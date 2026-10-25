import { Injectable, OnModuleInit } from '@nestjs/common';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessService, isBanned } from './access.service';
import { AlertsService } from './alerts.service';
import {
  alertsScreen,
  emissionScreen,
  mainMenu,
  newTicketScreen,
  proScreen,
  referralWelcomeScreen,
  replyPromptScreen,
  supportScreen,
  ticketCreatedScreen,
  ticketScreen,
} from './bot-screens';
import { esc, type Screen } from './bot-ui';
import { REGION_LABEL } from './format';
import { PRICE_ALERT_LIMIT, ProService, TRIAL_DAYS } from './pro.service';
import { InlineService } from './inline.service';
import { RecapService } from './recap.service';
import { ReviewsService } from './reviews.service';
import { ReferralService } from './referral.service';
import { type Category, isCategory } from './support-categories';
import { isNote, SupportLimitError, SupportService } from './support.service';
import {
  TelegramBotService,
  TgMessage,
  TgUpdate,
} from './telegram-bot.service';
import { LINK_CODE_RE, WebLinkService } from './web-link.service';

/** Чего бот ждёт от человека следующим сообщением (живёт в памяти 30 минут). */
type Pending =
  | { mode: 'new'; category: Category; at: number }
  | { mode: 'reply'; ticketId: number; at: number };
const PENDING_MS = 30 * 60_000;

/**
 * Бот: меню из одного «живого» сообщения (навигация — редактированием),
 * алерты, выброс, Pro и поддержка по тикетам. В личке — пользователи,
 * в группе поддержки (SUPPORT_CHAT_ID) — ответы поддержки по темам.
 */
@Injectable()
export class BotCommandsService implements OnModuleInit {
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly bot: TelegramBotService,
    private readonly alerts: AlertsService,
    private readonly webLink: WebLinkService,
    private readonly access: AccessService,
    private readonly pro: ProService,
    private readonly support: SupportService,
    private readonly prisma: PrismaService,
    private readonly referrals: ReferralService,
    private readonly inline: InlineService,
    private readonly recap: RecapService,
    private readonly reviews: ReviewsService,
  ) {}

  onModuleInit() {
    this.bot.onUpdate(async (u) => {
      await this.handle(u);
    });
    this.bot.onBlocked = (chatId) => this.alerts.markBlocked(chatId);
  }

  private async handle(update: TgUpdate) {
    if (update.inline_query) return this.inline.answer(update.inline_query);
    if (update.callback_query) return this.handleCallback(update);
    const msg = update.message;
    if (!msg?.from || msg.from.is_bot) return;
    if (this.support.groupId && msg.chat.id === this.support.groupId) {
      return this.handleSupportGroup(msg);
    }
    // настройка поддержки: админ узнаёт id группы для SUPPORT_CHAT_ID
    if (
      msg.chat.type !== 'private' &&
      /^\/chatid(@\w+)?$/i.test(msg.text?.trim() ?? '') &&
      this.access.isAdmin(msg.from.id)
    ) {
      return void this.bot.send(
        msg.chat.id,
        `SUPPORT_CHAT_ID=<code>${msg.chat.id}</code>${msg.chat.is_forum ? '' : '\n⚠️ В группе не включены темы - включите их в настройках группы.'}`,
        [],
        msg.message_thread_id,
      );
    }
    if (msg.chat.type !== 'private') return;

    // бан от админа: бот не отвечает (кроме одного пояснения на /start)
    const banned = await this.access.bannedUntil(String(msg.from.id));
    if (isBanned(banned) && !this.access.isAdmin(msg.from.id)) {
      if (msg.text?.startsWith('/start'))
        await this.bot.send(
          msg.chat.id,
          'Доступ к STALZONE INFO ограничен администратором.',
        );
      return;
    }

    const text = msg.text ?? '';
    if (text.startsWith('/')) return this.command(msg, text);
    return this.freeMessage(msg);
  }

  private async command(msg: TgMessage, text: string) {
    const chatId = msg.chat.id;
    const from = msg.from!;
    const command = text.split(/[\s@]/)[0].toLowerCase();
    this.pending.delete(chatId);

    switch (command) {
      case '/start': {
        await this.alerts.upsertSubscriber(from);
        // t.me/<бот>?start=link_<код> — привязка сайта
        const payload = text.split(' ')[1] ?? '';
        if (payload.startsWith('link_'))
          return this.askLink(chatId, payload.slice(5));
        if (payload === 'support') return this.go(chatId, 'sup');
        // t.me/<бот>?start=ref_<код> — пришёл по приглашению
        if (payload.startsWith('ref_')) {
          const inviter = await this.referrals.remember(
            chatId,
            payload.slice(4),
          );
          if (inviter) {
            return void this.bot.show(
              chatId,
              referralWelcomeScreen(this.bot.siteUrl, inviter, TRIAL_DAYS),
            );
          }
        }
        return this.go(chatId, 'menu');
      }
      case '/menu':
        return this.go(chatId, 'menu');
      case '/alerts':
        return this.go(chatId, 'alerts');
      case '/emission':
        await this.alerts.upsertSubscriber(from);
        return this.go(chatId, 'em');
      case '/pro':
        return this.go(chatId, 'pro');
      case '/recap':
        return this.recap.onDemand(chatId);
      case '/support':
        await this.alerts.upsertSubscriber(from);
        return this.go(chatId, 'sup');
      case '/stop':
        await this.alerts.clearAll(chatId);
        return void this.bot.send(
          chatId,
          'Все уведомления отключены. Включить снова - в /menu.',
        );
      // запасной путь поддержки без группы: админ отвечает из лички
      case '/reply':
      case '/close':
        if (this.access.isAdmin(from.id))
          return this.adminCommand(msg, command, text);
        return this.go(chatId, 'menu');
      default:
        return this.go(chatId, 'menu');
    }
  }

  /** Не команда: текст/фото для поддержки, иначе — меню. */
  private async freeMessage(msg: TgMessage) {
    const chatId = msg.chat.id;
    const pending = this.pending.get(chatId);
    const fresh = pending && Date.now() - pending.at < PENDING_MS;
    try {
      if (fresh && pending.mode === 'new') {
        await this.alerts.upsertSubscriber(msg.from!);
        const ticket = await this.support.create(chatId, pending.category, msg);
        this.pending.delete(chatId);
        return void this.bot.show(chatId, ticketCreatedScreen(ticket.id));
      }
      if (fresh && pending.mode === 'reply') {
        this.pending.delete(chatId);
        await this.support.append(pending.ticketId, chatId, msg);
        return void this.bot.send(
          chatId,
          `📨 Добавлено в обращение #${pending.ticketId}.`,
        );
      }
      // одно открытое обращение — пишем прямо в него, как в обычный чат
      const open = await this.support.openOf(chatId);
      if (open.length === 1) {
        await this.support.append(open[0].id, chatId, msg);
        return void this.bot.send(
          chatId,
          `📨 Добавлено в обращение #${open[0].id}.`,
        );
      }
      if (open.length > 1) {
        return void this.bot.show(chatId, {
          blocks: [
            {
              type: 'p',
              text: 'У вас несколько открытых обращений - выберите, в какое написать, и отправьте сообщение ещё раз.',
            },
          ],
          buttons: open.map((t) => [
            { text: `✍️ В обращение #${t.id}`, data: `sup:reply:${t.id}` },
          ]),
        });
      }
    } catch (error) {
      if (error instanceof SupportLimitError)
        return void this.bot.send(chatId, `⚠️ ${error.message}`);
      throw error;
    }
    return this.go(chatId, 'menu');
  }

  /** Показать экран по «адресу» — новым сообщением или вместо edit. */
  private async go(chatId: number, to: string, edit?: number) {
    const screen = await this.screen(chatId, to);
    if (screen) await this.bot.show(chatId, screen, { edit });
  }

  private async screen(chatId: number, to: string): Promise<Screen | null> {
    const site = this.bot.siteUrl;
    const [action, arg] = to.split(':');
    switch (action) {
      case 'menu': {
        const [sub, user, overview, open] = await Promise.all([
          this.prisma.telegramSubscriber.findUnique({
            where: { chatId: BigInt(chatId) },
            select: { firstName: true, proUntil: true },
          }),
          this.prisma.user.findUnique({
            where: { chatId: BigInt(chatId) },
            select: { login: true, proUntil: true },
          }),
          this.alerts.overview(chatId),
          this.support.openOf(chatId),
        ]);
        return mainMenu({
          site,
          name: sub?.firstName ?? undefined,
          login: user?.login,
          proUntil: user?.proUntil ?? sub?.proUntil,
          priceAlerts: overview.price.length,
          flipRegions: overview.flip.map(
            (f) => REGION_LABEL[f.region as Region] ?? f.region,
          ),
          emission: overview.emission,
          openTickets: open.length,
        });
      }
      case 'alerts': {
        const [{ price, flip }, status] = await Promise.all([
          this.alerts.overview(chatId),
          this.pro.chatStatus(BigInt(chatId)),
        ]);
        return alertsScreen({
          site,
          price,
          flip,
          limit: status.pro ? PRICE_ALERT_LIMIT.pro : PRICE_ALERT_LIMIT.free,
        });
      }
      case 'em':
        return emissionScreen((await this.alerts.overview(chatId)).emission);
      case 'pro': {
        const user = await this.prisma.user.findUnique({
          where: { chatId: BigInt(chatId) },
          select: { id: true },
        });
        const status = user
          ? await this.pro.status(user.id)
          : await this.pro.chatStatus(BigInt(chatId));
        const referral = user ? await this.referrals.stats(user.id) : undefined;
        return proScreen({ site, linked: !!user, ...status, referral });
      }
      case 'sup': {
        const tickets = await this.support.list(chatId);
        return supportScreen({ tickets, enabled: !!this.support.groupId });
      }
      case 'ticket': {
        const ticket = await this.prisma.supportTicket.findFirst({
          where: { id: Number(arg), chatId: BigInt(chatId) },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        });
        return ticket ? ticketScreen(ticket, ticket.messages) : null;
      }
    }
    return null;
  }

  /** Подтверждение кнопкой: чужая ссылка, открытая по ошибке, ничего не привяжет. */
  private async askLink(chatId: number, code: string) {
    if (!LINK_CODE_RE.test(code)) return this.go(chatId, 'menu');
    const login = await this.webLink.pendingLogin(code);
    if (!login) {
      return void this.bot.send(
        chatId,
        '⌛ Ссылка привязки устарела. Нажмите «Привязать Telegram» на сайте ещё раз.',
      );
    }
    await this.bot.show(chatId, {
      blocks: [
        {
          type: 'h',
          text: `🔗 Привязать этот Telegram к аккаунту ${esc(login)}?`,
        },
        {
          type: 'p',
          text: 'Алерты, уведомления о выбросе и Pro аккаунта будут работать здесь.',
        },
        {
          type: 'footer',
          text: 'Если вы не нажимали «Привязать Telegram» на сайте - просто проигнорируйте это сообщение.',
        },
      ],
      buttons: [
        [{ text: '✅ Привязать', data: `lnk:${code}`, style: 'success' }],
      ],
    });
  }

  private async handleCallback(update: TgUpdate) {
    const q = update.callback_query!;
    const message = q.message;
    const [action, arg, extra, value] = (q.data ?? '').split(':');
    const answer = (text = '', alert = false) =>
      this.bot
        .call('answerCallbackQuery', {
          callback_query_id: q.id,
          text,
          show_alert: alert,
        })
        .catch(() => {});

    // кнопки карточки обращения в группе поддержки
    if (action === 'sup' && arg === 'aclose') {
      const inGroup =
        !!this.support.groupId && message?.chat.id === this.support.groupId;
      if (!inGroup && !this.access.isAdmin(q.from.id)) return answer();
      const closed = await this.support.close(Number(extra), 'admin');
      return answer(closed ? 'Обращение закрыто' : 'Уже закрыто');
    }
    if (message?.chat.type !== 'private') return answer();

    if (
      isBanned(await this.access.bannedUntil(String(q.from.id))) &&
      !this.access.isAdmin(q.from.id)
    )
      return answer();
    const chatId = q.from.id;
    const edit = message.message_id;

    if (q.data === 'pro:trial') return this.trial(chatId, edit, answer);
    if (action === 'sup')
      return this.supportCallback(q.from, arg, extra, value, edit, answer);

    switch (action) {
      // модерация отзыва: кнопки в карточке, которую получают админы
      case 'rvw': {
        if (!this.access.isAdmin(chatId)) return answer();
        const id = Number(extra);
        if (!Number.isInteger(id)) return answer();
        const ok = arg === 'ok';
        const r = await this.reviews.moderate(id, ok).catch(() => null);
        if (!r) return answer('Отзыв не найден');
        const verdict =
          r.status === 'published' ? '✅ Опубликован' : '❌ Отклонён';
        // убираем кнопки и дописываем итог, чтобы второй админ видел, что уже решено
        await this.bot
          .call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: edit,
            reply_markup: {
              inline_keyboard: [[{ text: verdict, callback_data: 'noop' }]],
            },
          })
          .catch(() => {});
        return answer(r.changed ? verdict : `Уже решено: ${verdict}`);
      }
      // кнопка под итогами месяца: сообщение — картинка, его не редактируем, только ответ-подсказка
      case 'recap': {
        const off = arg === 'off';
        const ok = await this.recap.setOff(chatId, off);
        if (!ok) return answer('Аккаунт не привязан');
        return answer(
          off
            ? 'Больше не пришлём. Включить - командой /recap'
            : 'Итоги будут приходить 1-го числа',
          true,
        );
      }
      case 'menu':
      case 'alerts':
      case 'pro':
        this.pending.delete(chatId);
        await this.go(chatId, action, edit);
        return answer();
      case 'em': {
        if ((REGIONS as readonly string[]).includes(arg)) {
          const region = arg as Region;
          const { emission } = await this.alerts.overview(chatId);
          const enabled = !emission.includes(region);
          await this.alerts.setEmission(q.from, region, enabled);
          await this.go(chatId, 'em', edit);
          return answer(
            `${REGION_LABEL[region]}: ${enabled ? 'включено' : 'выключено'}`,
          );
        }
        await this.alerts.upsertSubscriber(q.from);
        await this.go(chatId, 'em', edit);
        return answer();
      }
      case 'lnk': {
        if (!LINK_CODE_RE.test(arg ?? '')) return answer();
        await this.alerts.upsertSubscriber(q.from);
        const ok = await this.webLink.confirm(arg, q.from);
        await this.bot.show(
          chatId,
          ok
            ? {
                blocks: [
                  { type: 'h', text: '✅ Telegram привязан' },
                  {
                    type: 'p',
                    text: 'Вернитесь на сайт - уведомления можно включать. А здесь доступно меню.',
                  },
                ],
                buttons: [[{ text: '🏠 Меню', data: 'menu' }]],
              }
            : {
                blocks: [
                  {
                    type: 'p',
                    text: '⌛ Ссылка устарела. Нажмите «Привязать Telegram» на сайте ещё раз.',
                  },
                ],
              },
          { edit },
        );
        return answer(ok ? 'Готово!' : 'Ссылка устарела');
      }
      case 'fdel': {
        const text = await this.alerts
          .deleteFlip(chatId, arg)
          .then(() => 'Флип-алерт отключён')
          .catch(() => 'Уже отключён');
        await this.go(chatId, 'alerts', edit);
        return answer(text);
      }
      case 'rdel': {
        if (!(REGIONS as readonly string[]).includes(arg)) return answer();
        await this.alerts.setRadar(q.from, arg as Region, false);
        return answer('Радар рынка отключён');
      }
      case 'del': {
        const text = await this.alerts
          .deletePrice(chatId, arg)
          .then(() => 'Алерт удалён')
          .catch(() => 'Алерт уже удалён');
        await this.go(chatId, 'alerts', edit);
        return answer(text);
      }
    }
    return answer();
  }

  private async trial(
    chatId: number,
    edit: number,
    answer: (text?: string, alert?: boolean) => Promise<unknown>,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { id: true },
    });
    if (!user) return answer('Сначала привяжите аккаунт на сайте', true);
    try {
      await this.pro.startTrial(user.id);
    } catch (error) {
      const message =
        (error as { response?: { message?: string } }).response?.message ??
        'Не получилось';
      return answer(message, true);
    }
    await this.go(chatId, 'pro', edit);
    return answer('🎁 Pro включён на 3 дня!', true);
  }

  private async supportCallback(
    from: { id: number; first_name?: string; username?: string },
    arg: string | undefined,
    extra: string | undefined,
    value: string | undefined,
    edit: number,
    answer: (text?: string, alert?: boolean) => Promise<unknown>,
  ) {
    const chatId = from.id;
    const id = Number(extra);
    switch (arg) {
      case undefined:
      case '':
        this.pending.delete(chatId);
        await this.alerts.upsertSubscriber(from);
        await this.go(chatId, 'sup', edit);
        return answer();
      case 'new':
        if (!isCategory(extra)) return answer();
        this.pending.set(chatId, {
          mode: 'new',
          category: extra,
          at: Date.now(),
        });
        await this.bot.show(chatId, newTicketScreen(extra), { edit });
        return answer();
      case 't':
        this.pending.delete(chatId);
        await this.go(chatId, `ticket:${id}`, edit);
        return answer();
      case 'reply': {
        const ticket = await this.support.find(id);
        if (
          !ticket ||
          ticket.chatId !== BigInt(chatId) ||
          ticket.status === 'closed'
        )
          return answer('Обращение уже закрыто', true);
        this.pending.set(chatId, {
          mode: 'reply',
          ticketId: id,
          at: Date.now(),
        });
        // ответ поддержки с фото редактировать как текст нельзя — тогда новым сообщением
        await this.bot.show(chatId, replyPromptScreen(id));
        return answer();
      }
      case 'close': {
        const ticket = await this.support.find(id);
        if (!ticket || ticket.chatId !== BigInt(chatId)) return answer();
        const closed = await this.support.close(id, 'user');
        return answer(closed ? 'Обращение закрыто' : 'Уже закрыто');
      }
      case 'rate': {
        const ok = await this.support.rate(id, chatId, value === '1' ? 1 : -1);
        if (ok) {
          await this.bot.show(
            chatId,
            {
              blocks: [
                {
                  type: 'p',
                  text:
                    value === '1'
                      ? '🙏 Спасибо за оценку! Рады, что помогли.'
                      : '😔 Жаль. Создайте новое обращение и опишите, что осталось нерешённым - разберёмся.',
                },
              ],
              buttons: [
                [{ text: '🛟 Поддержка', data: 'sup' }],
                [{ text: '🏠 В меню', data: 'menu' }],
              ],
            },
            { edit },
          );
        }
        return answer(ok ? 'Спасибо!' : 'Оценка уже есть');
      }
    }
    return answer();
  }

  // ---------- группа поддержки ----------

  private async handleSupportGroup(msg: TgMessage) {
    const topic = msg.message_thread_id;
    if (!topic || !msg.is_topic_message || msg.forum_topic_created) return;
    const ticket = await this.support.byTopic(topic);
    if (!ticket) return;
    const text = msg.text ?? msg.caption ?? '';
    if (/^\/close(@\w+)?$/i.test(text.trim())) {
      await this.support.close(ticket.id, 'admin');
      return;
    }
    if (text.startsWith('/') || isNote(text)) return;
    const delivered = await this.support.reply(ticket.id, msg);
    if (delivered) {
      await this.bot
        .call('setMessageReaction', {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          reaction: [{ type: 'emoji', emoji: '👌' }],
        })
        .catch(() => {});
    } else {
      await this.bot.send(
        msg.chat.id,
        '⚠️ Не доставлено: пользователь заблокировал бота или удалил чат.',
        [],
        topic,
      );
    }
  }

  /** /reply <номер> <текст>, /close <номер> — из лички админа (если группы нет). */
  private async adminCommand(msg: TgMessage, command: string, text: string) {
    const [, idStr = ''] = text.trim().split(/\s+/);
    const id = Number(idStr);
    if (!Number.isInteger(id)) {
      return void this.bot.send(
        msg.chat.id,
        `Формат: ${command} <номер> текст`,
      );
    }
    if (command === '/close') {
      const closed = await this.support.close(id, 'admin');
      return void this.bot.send(
        msg.chat.id,
        closed ? `🔒 #${id} закрыто.` : `#${id} не найдено или уже закрыто.`,
      );
    }
    // текст после номера — с переносами строк, как написан
    const trimmed = text.trim();
    const body = trimmed.slice(trimmed.indexOf(idStr) + idStr.length).trim();
    if (!body) {
      return void this.bot.send(msg.chat.id, 'Добавьте текст ответа.');
    }
    const ok = await this.support.reply(id, msg, body);
    await this.bot.send(
      msg.chat.id,
      ok ? `✅ Ответ по #${id} отправлен.` : `⚠️ #${id}: не доставлено.`,
    );
  }
}
