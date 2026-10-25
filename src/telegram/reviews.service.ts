import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessService } from './access.service';
import type { Account } from './account.service';
import {
  channelText,
  cleanNick,
  cleanText,
  moderationText,
  nextReviewAt,
  REVIEW_EVERY_MS,
  REVIEW_NICK,
  REVIEW_TEXT,
} from './reviews';
import { TelegramBotService } from './telegram-bot.service';

const PAGE = 20;
const SEND_GAP_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Как отзыв показывается на сайте — без id чата и аккаунта. */
const publicSelect = {
  id: true,
  nick: true,
  rating: true,
  text: true,
  createdAt: true,
} as const;

/**
 * Отзывы: оставить можно с привязанным Telegram, один раз в неделю (считаются и отклонённые).
 * Новый отзыв приходит админам (ADMIN_CHAT_IDS) с кнопками; одобренный появляется на сайте
 * и, если задан REVIEWS_CHANNEL_ID (@канал или -100…, бот — админ канала), постится в канал.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);
  private readonly channel?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly access: AccessService,
    config: ConfigService,
  ) {
    this.channel =
      config.get<string>('REVIEWS_CHANNEL_ID')?.trim() || undefined;
  }

  /** Опубликованные — новые сверху, по 20; before — id последнего показанного. */
  async list(before?: number) {
    const [items, stats] = await Promise.all([
      this.prisma.review.findMany({
        where: { status: 'published', ...(before && { id: { lt: before } }) },
        orderBy: { id: 'desc' },
        take: PAGE + 1,
        select: publicSelect,
      }),
      this.prisma.review.aggregate({
        where: { status: 'published' },
        _count: true,
        _avg: { rating: true },
      }),
    ]);
    return {
      count: stats._count,
      average: stats._avg.rating
        ? Math.round(stats._avg.rating * 10) / 10
        : null,
      items: items.slice(0, PAGE),
      more: items.length > PAGE,
    };
  }

  /**
   * Можно ли оставить отзыв сейчас, когда следующий и свой отзыв за неделю.
   * mine автор видит в списке сразу, в любом статусе: о модерации он не знает —
   * отклонённый просто не видят остальные, а через неделю он пропадает и у автора.
   */
  async status(account: Account) {
    if (account.chatId == null)
      return { telegram: false, nextAt: null, mine: null };
    const mine = await this.prisma.review.findFirst({
      where: {
        chatId: account.chatId,
        createdAt: { gt: new Date(Date.now() - REVIEW_EVERY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: publicSelect,
    });
    return {
      telegram: true,
      nextAt: nextReviewAt(mine?.createdAt)?.toISOString() ?? null,
      mine,
    };
  }

  async create(
    account: Account,
    input: { nick: string; rating: number; text: string },
  ) {
    const chatId = account.chatId;
    if (chatId == null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'telegram_required',
        message: 'Оставить отзыв можно после привязки Telegram',
      });
    }
    const next = nextReviewAt(await this.lastAt(chatId));
    if (next) {
      throw new ConflictException({
        statusCode: 409,
        code: 'review_limit',
        message: 'Отзыв можно оставлять раз в неделю',
        nextAt: next.toISOString(),
      });
    }
    const nick = cleanNick(input.nick);
    const text = cleanText(input.text);
    // длины уже проверил DTO, но после чистки пробелов текст мог стать короче
    if (nick.length < REVIEW_NICK.min || text.length < REVIEW_TEXT.min) {
      throw new BadRequestException(
        `Ник - от ${REVIEW_NICK.min} символов, отзыв - от ${REVIEW_TEXT.min}`,
      );
    }
    const review = await this.prisma.review.create({
      data: {
        chatId,
        userId: account.userId,
        nick,
        rating: input.rating,
        text,
      },
      select: publicSelect,
    });
    this.logger.log(
      `Отзыв #${review.id} от ${account.login}: ${review.rating}★`,
    );
    void this.notifyAdmins(review, account.login);
    return review;
  }

  /** Кнопка модерации: ok — опубликовать, иначе отклонить. Повторное нажатие ничего не делает. */
  async moderate(id: number, ok: boolean) {
    const { count } = await this.prisma.review.updateMany({
      where: { id, status: 'pending' },
      data: { status: ok ? 'published' : 'rejected', moderatedAt: new Date() },
    });
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException('Отзыв не найден');
    if (!count) return { changed: false, status: review.status };

    // автор о модерации не знает: при отклонении молчим, при публикации — спасибо и ссылка на канал
    if (!ok) return { changed: true, status: review.status };
    if (this.channel) {
      const posted = await this.bot
        .call<{ message_id: number }>('sendMessage', {
          chat_id: this.channel,
          text: channelText(review, this.bot.siteUrl),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        .catch((e: Error) => {
          this.logger.warn(`Отзыв #${id} в канал: ${e.message}`);
          return null;
        });
      if (posted) {
        await this.prisma.review.update({
          where: { id },
          data: { channelMessageId: posted.message_id },
        });
        const link = this.channel.startsWith('@')
          ? `https://t.me/${this.channel.slice(1)}`
          : null;
        await this.bot.send(
          review.chatId,
          `⭐ Спасибо за отзыв! Он теперь и в нашем канале${link ? `: ${link}` : '.'}`,
        );
      }
    }
    return { changed: true, status: review.status };
  }

  private async lastAt(chatId: bigint) {
    const last = await this.prisma.review.findFirst({
      where: {
        chatId,
        createdAt: { gt: new Date(Date.now() - REVIEW_EVERY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? null;
  }

  private async notifyAdmins(
    review: { id: number; nick: string; rating: number; text: string },
    login: string,
  ) {
    for (const admin of this.access.adminIds) {
      await this.bot.send(Number(admin), moderationText(review, login), [
        [
          { text: '✅ Опубликовать', callback_data: `rvw:ok:${review.id}` },
          { text: '❌ Отклонить', callback_data: `rvw:no:${review.id}` },
        ],
      ]);
      await sleep(SEND_GAP_MS);
    }
  }
}
