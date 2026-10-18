import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessService } from './access.service';
import { type Button, esc, type Screen, toKeyboard } from './bot-ui';
import { CATEGORIES, type Category, MAX_OPEN } from './support-categories';
import { TelegramBotService, TgMessage } from './telegram-bot.service';

/** Сообщений в поддержку в час от одного человека (защита от флуда). */
export const MAX_PER_HOUR = 20;
const MAX_TEXT = 3500;
const HOUR = 3_600_000;

/** Заметка для своих: сообщение в теме, которое пользователю не отправляется. */
export const isNote = (text: string | undefined) => !!text?.startsWith('//');

export class SupportLimitError extends Error {}

/** Текст и вложение сообщения (фото — крупнейший размер, или файл). */
export function contentOf(msg: TgMessage) {
  const text =
    (msg.text ?? msg.caption ?? '').trim().slice(0, MAX_TEXT) || null;
  const file = msg.photo?.at(-1)?.file_id ?? msg.document?.file_id ?? null;
  return { text, file };
}

const dateRu = (d: Date) =>
  d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });

/**
 * Поддержка по тикетам. Каждое обращение — тема в группе-форуме SUPPORT_CHAT_ID:
 * сообщения пользователя копируются в тему, ответ в теме уходит пользователю.
 * Без SUPPORT_CHAT_ID обращения приходят админам (ADMIN_CHAT_IDS) в личку,
 * отвечать — командой /reply <номер> <текст>.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  /** id группы поддержки (отрицательный); undefined — не настроена */
  readonly groupId?: number;
  private readonly sent = new Map<number, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly access: AccessService,
    config: ConfigService,
  ) {
    const id = Number(config.get<string>('SUPPORT_CHAT_ID')?.trim());
    this.groupId = Number.isInteger(id) && id < 0 ? id : undefined;
    if (!this.groupId)
      this.logger.warn(
        'SUPPORT_CHAT_ID не задан — обращения приходят админам в личку',
      );
  }

  find(id: number) {
    return this.prisma.supportTicket.findUnique({ where: { id } });
  }

  byTopic(topicId: number) {
    return this.prisma.supportTicket.findFirst({ where: { topicId } });
  }

  /** Обращения человека: сначала открытые, потом последние закрытые. */
  async list(chatId: number) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { _count: { select: { messages: true } } },
    });
    return tickets.sort(
      (a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'),
    );
  }

  openOf(chatId: number) {
    return this.prisma.supportTicket.findMany({
      where: { chatId: BigInt(chatId), status: { not: 'closed' } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Не больше MAX_PER_HOUR сообщений в час; бросает SupportLimitError. */
  private throttle(chatId: number) {
    const now = Date.now();
    const recent = (this.sent.get(chatId) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= MAX_PER_HOUR) {
      throw new SupportLimitError(
        'Слишком много сообщений подряд. Подождите немного - мы уже читаем ваше обращение.',
      );
    }
    recent.push(now);
    this.sent.set(chatId, recent);
  }

  /** Новое обращение с первым сообщением. */
  async create(chatId: number, category: Category, msg: TgMessage) {
    const { text, file } = contentOf(msg);
    if (!text && !file) {
      throw new SupportLimitError(
        'Опишите вопрос текстом - можно приложить скриншот.',
      );
    }
    if ((await this.openOf(chatId)).length >= MAX_OPEN) {
      throw new SupportLimitError(
        `У вас уже ${MAX_OPEN} открытых обращения. Дождитесь ответа или закройте одно из них.`,
      );
    }
    this.throttle(chatId);

    const user = await this.prisma.user.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { id: true },
    });
    const ticket = await this.prisma.supportTicket.create({
      data: {
        chatId: BigInt(chatId),
        userId: user?.id,
        category,
        messages: { create: { fromAdmin: false, text, photo: file } },
      },
    });

    const cat = CATEGORIES[category];
    if (this.groupId) {
      const name = await this.displayName(chatId);
      const topic = await this.bot
        .call<{ message_thread_id: number }>('createForumTopic', {
          chat_id: this.groupId,
          name: `#${ticket.id} ${cat.icon} ${name}`.slice(0, 128),
          icon_color: cat.color,
        })
        .catch((e: Error) => {
          this.logger.error(`createForumTopic: ${e.message}`);
          return null;
        });
      if (topic) {
        await this.prisma.supportTicket.update({
          where: { id: ticket.id },
          data: { topicId: topic.message_thread_id },
        });
        await this.bot.show(this.groupId, await this.card(ticket.id), {
          threadId: topic.message_thread_id,
        });
        await this.copy(chatId, msg, this.groupId, topic.message_thread_id);
        return ticket;
      }
    }
    // группы нет или тему создать не удалось — пишем админам в личку
    await this.toAdmins(ticket.id, msg);
    return ticket;
  }

  /** Ещё одно сообщение в открытое обращение. */
  async append(ticketId: number, chatId: number, msg: TgMessage) {
    const ticket = await this.find(ticketId);
    if (
      !ticket ||
      ticket.chatId !== BigInt(chatId) ||
      ticket.status === 'closed'
    ) {
      throw new SupportLimitError('Это обращение уже закрыто. Создайте новое.');
    }
    const { text, file } = contentOf(msg);
    if (!text && !file) return ticket;
    this.throttle(chatId);
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: 'open',
        messages: { create: { fromAdmin: false, text, photo: file } },
      },
    });
    if (this.groupId && ticket.topicId) {
      await this.copy(chatId, msg, this.groupId, ticket.topicId);
    } else {
      await this.toAdmins(ticketId, msg);
    }
    return ticket;
  }

  /**
   * Ответ поддержки (сообщение в теме или /reply в личке админа) → пользователю.
   * Текст — своим сообщением с шапкой, фото и файлы — копией с подписью-шапкой.
   * false — не доставлено (пользователь заблокировал бота).
   */
  async reply(ticketId: number, msg: TgMessage, overrideText?: string) {
    const ticket = await this.find(ticketId);
    if (!ticket) return false;
    const { text: original, file } = contentOf(msg);
    const text = overrideText ?? original;
    const head = `💬 <b>Поддержка · обращение #${ticket.id}</b>`;
    let delivered: boolean;
    if (file && !overrideText) {
      delivered = await this.bot
        .call('copyMessage', {
          chat_id: Number(ticket.chatId),
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          caption: text ? `${head}\n\n${esc(text)}` : head,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: toKeyboard(this.userButtons(ticket.id)),
          },
        })
        .then(() => true)
        .catch(() => false);
    } else {
      delivered =
        (await this.bot.show(ticket.chatId, {
          blocks: [
            { type: 'h', text: `💬 Поддержка · обращение #${ticket.id}` },
            { type: 'p', text: esc(text ?? '').replace(/\n/g, '<br>') },
          ],
          buttons: this.userButtons(ticket.id),
        })) != null;
    }
    if (delivered) {
      await this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: ticket.status === 'closed' ? 'closed' : 'answered',
          messages: { create: { fromAdmin: true, text, photo: file } },
        },
      });
    }
    return delivered;
  }

  /** Закрыть обращение. by — кто закрыл (для сообщений обеим сторонам). */
  async close(ticketId: number, by: 'user' | 'admin') {
    const ticket = await this.find(ticketId);
    if (!ticket || ticket.status === 'closed') return null;
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'closed', closedAt: new Date() },
    });
    if (this.groupId && ticket.topicId) {
      await this.bot.send(
        this.groupId,
        by === 'user'
          ? '🔒 Пользователь закрыл обращение.'
          : '🔒 Обращение закрыто, пользователю отправлен запрос оценки.',
        [],
        ticket.topicId,
      );
      await this.bot
        .call('closeForumTopic', {
          chat_id: this.groupId,
          message_thread_id: ticket.topicId,
        })
        .catch(() => {});
    }
    await this.bot.show(ticket.chatId, {
      blocks: [
        { type: 'h', text: `✅ Обращение #${ticket.id} закрыто` },
        {
          type: 'p',
          text:
            by === 'user'
              ? 'Если вопрос вернётся - создайте новое обращение.'
              : 'Поддержка отметила вопрос решённым. Мы помогли?',
        },
      ],
      buttons: [
        [
          { text: '👍 Да', data: `sup:rate:${ticket.id}:1`, style: 'success' },
          { text: '👎 Нет', data: `sup:rate:${ticket.id}:-1`, style: 'danger' },
        ],
        [{ text: '🏠 В меню', data: 'menu' }],
      ],
    });
    return ticket;
  }

  /** Оценка после закрытия — один раз. */
  async rate(ticketId: number, chatId: number, value: 1 | -1) {
    const { count } = await this.prisma.supportTicket.updateMany({
      where: {
        id: ticketId,
        chatId: BigInt(chatId),
        status: 'closed',
        rating: null,
      },
      data: { rating: value },
    });
    if (!count) return false;
    const ticket = await this.find(ticketId);
    if (this.groupId && ticket?.topicId) {
      await this.bot
        .call('reopenForumTopic', {
          chat_id: this.groupId,
          message_thread_id: ticket.topicId,
        })
        .catch(() => {});
      await this.bot.send(
        this.groupId,
        `Оценка пользователя: ${value > 0 ? '👍 помогли' : '👎 не помогли'}`,
        [],
        ticket.topicId,
      );
      await this.bot
        .call('closeForumTopic', {
          chat_id: this.groupId,
          message_thread_id: ticket.topicId,
        })
        .catch(() => {});
    }
    return true;
  }

  /** Кнопки под ответом поддержки. */
  private userButtons(ticketId: number): Button[][] {
    return [
      [
        {
          text: '✍️ Ответить',
          data: `sup:reply:${ticketId}`,
          style: 'primary',
        },
        {
          text: '✅ Вопрос решён',
          data: `sup:close:${ticketId}`,
          style: 'success',
        },
      ],
    ];
  }

  /**
   * Карточка обращения — первое сообщение темы (или сообщение админу в личку,
   * inTopic=false): кто пишет, аккаунт, Pro.
   */
  async card(ticketId: number, inTopic = true): Promise<Screen> {
    const ticket = await this.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    const [sub, user, total] = await Promise.all([
      this.prisma.telegramSubscriber.findUnique({
        where: { chatId: ticket.chatId },
        select: { firstName: true, username: true },
      }),
      this.prisma.user.findUnique({
        where: { chatId: ticket.chatId },
        select: {
          login: true,
          proUntil: true,
          trialUsedAt: true,
          bannedUntil: true,
        },
      }),
      this.prisma.supportTicket.count({ where: { chatId: ticket.chatId } }),
    ]);
    const cat = CATEGORIES[ticket.category as Category] ?? CATEGORIES.question;
    const tg = `<a href="tg://user?id=${ticket.chatId}">${esc(sub?.firstName ?? 'без имени')}</a>${sub?.username ? ` @${esc(sub.username)}` : ''} · <code>${ticket.chatId}</code>`;
    const pro =
      user?.proUntil && user.proUntil > new Date()
        ? `до ${dateRu(user.proUntil)}`
        : 'нет';
    return {
      blocks: [
        {
          type: 'h',
          text: `🆕 Обращение #${ticket.id} · ${cat.icon} ${cat.label}`,
        },
        {
          type: 'table',
          head: ['', ''],
          rows: [
            ['Telegram', tg],
            [
              'Аккаунт EXBO',
              user ? `<code>${esc(user.login)}</code>` : 'не привязан',
            ],
            ['Pro', pro],
            [
              'Пробный',
              user?.trialUsedAt
                ? `брал ${dateRu(user.trialUsedAt)}`
                : 'не брал',
            ],
            ...(user?.bannedUntil && user.bannedUntil > new Date()
              ? [['Бан', `до ${dateRu(user.bannedUntil)}`]]
              : []),
            ['Обращений всего', String(total)],
          ],
        },
        {
          type: 'footer',
          text: inTopic
            ? 'Ответ в этой теме уйдёт пользователю. Сообщения с «//» - заметки, их видите только вы. /close - закрыть обращение.'
            : `Ответить: <code>/reply ${ticket.id} текст</code> · закрыть: <code>/close ${ticket.id}</code>`,
        },
      ],
      buttons: [
        [
          {
            text: '🔒 Закрыть обращение',
            data: `sup:aclose:${ticket.id}`,
            style: 'danger',
          },
        ],
      ],
    };
  }

  private async displayName(chatId: number) {
    const [sub, user] = await Promise.all([
      this.prisma.telegramSubscriber.findUnique({
        where: { chatId: BigInt(chatId) },
        select: { firstName: true, username: true },
      }),
      this.prisma.user.findUnique({
        where: { chatId: BigInt(chatId) },
        select: { login: true },
      }),
    ]);
    return (
      user?.login ??
      (sub?.username ? `@${sub.username}` : (sub?.firstName ?? String(chatId)))
    );
  }

  private copy(
    fromChat: number,
    msg: TgMessage,
    toChat: number,
    threadId?: number,
  ) {
    return this.bot
      .call('copyMessage', {
        chat_id: toChat,
        from_chat_id: fromChat,
        message_id: msg.message_id,
        ...(threadId && { message_thread_id: threadId }),
      })
      .catch((e: Error) => this.logger.warn(`copyMessage: ${e.message}`));
  }

  /** Запасной путь без группы: карточка и копия сообщения каждому админу. */
  private async toAdmins(ticketId: number, msg: TgMessage) {
    const card = await this.card(ticketId, false);
    for (const admin of this.access.adminIds) {
      await this.bot.show(Number(admin), card);
      await this.copy(msg.chat.id, msg, Number(admin));
    }
  }
}
