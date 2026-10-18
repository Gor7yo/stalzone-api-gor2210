import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Account } from './account.service';
import type { SubscriberInfo } from './alerts.service';

const MIN = 60_000;
/** Статус бана держим в памяти минуту — чтобы не ходить в БД на каждый запрос. */
const BAN_CACHE_MS = MIN;
/** Визит (lastSeenAt, активность за день) пишем не чаще раза в 10 минут на пользователя. */
const SEEN_EVERY_MS = 10 * MIN;
/** «Навсегда» = 100 лет. */
export const FOREVER_MS = 100 * 365 * 24 * 60 * MIN;

export const isBanned = (until: Date | null | undefined, now = Date.now()) =>
  !!until && until.getTime() > now;

const today = () => new Date(new Date().toISOString().slice(0, 10));

/**
 * Доступ: бан от админа, отметка визита (для метрик) и «админ ли это»
 * (ADMIN_CHAT_IDS в .env - Telegram id; админ - аккаунт с таким привязанным Telegram).
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private readonly admins: Set<string>;
  private readonly bans = new Map<string, { until: Date | null; at: number }>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.admins = new Set(
      String(config.get('ADMIN_CHAT_IDS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s)),
    );
    if (!this.admins.size)
      this.logger.warn('ADMIN_CHAT_IDS не задан — админка недоступна');
  }

  /** Telegram id админов — куда слать обращения в поддержку, если группа не настроена. */
  get adminIds() {
    return [...this.admins];
  }

  isAdmin(chatId: number | bigint | null | undefined) {
    return chatId != null && this.admins.has(String(chatId));
  }

  /** Бросает 403 code=banned, если аккаунт забанен. Заодно отмечает визит. */
  async check(account: Account) {
    this.touch(account.userId);
    if (this.isAdmin(account.chatId)) return;
    const until = await this.cached(`u:${account.userId}`, async () => {
      const u = await this.prisma.user.findUnique({
        where: { id: account.userId },
        select: { bannedUntil: true },
      });
      return u?.bannedUntil ?? null;
    });
    if (isBanned(until)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'banned',
        message: 'Доступ ограничен администратором',
        until: until!.toISOString(),
      });
    }
  }

  /** Бан Telegram-чата (копия бана аккаунта) - бот не отвечает забаненным. */
  bannedUntil(chatId: string): Promise<Date | null> {
    return this.cached(`c:${chatId}`, async () => {
      const s = await this.prisma.telegramSubscriber.findUnique({
        where: { chatId: BigInt(chatId) },
        select: { bannedUntil: true },
      });
      return s?.bannedUntil ?? null;
    });
  }

  /** Админ поменял бан — сбросить кеш, чтобы сработало сразу. */
  forget(userId: string, chatId?: bigint | null) {
    this.bans.delete(`u:${userId}`);
    if (chatId != null) this.bans.delete(`c:${chatId}`);
  }

  /** Мини-приложение: обновить имя/ник Telegram (для поиска в админке). */
  touchChat(user: SubscriberInfo) {
    const key = `c:${user.id}`;
    if (Date.now() - (this.seen.get(key) ?? 0) < SEEN_EVERY_MS) return;
    this.seen.set(key, Date.now());
    const chatId = BigInt(user.id);
    const names = {
      ...(user.first_name !== undefined && { firstName: user.first_name }),
      ...(user.username !== undefined && { username: user.username }),
    };
    void this.prisma.telegramSubscriber
      .upsert({
        where: { chatId },
        create: { chatId, ...names, lastSeenAt: new Date() },
        update: { ...names, lastSeenAt: new Date() },
      })
      .catch((error: unknown) =>
        this.logger.warn(`отметка Telegram: ${String(error)}`),
      );
  }

  private async cached(key: string, load: () => Promise<Date | null>) {
    const hit = this.bans.get(key);
    if (hit && Date.now() - hit.at < BAN_CACHE_MS) return hit.until;
    const until = await load();
    this.bans.set(key, { until, at: Date.now() });
    return until;
  }

  /** Отметка визита аккаунта: lastSeenAt и день активности. */
  private touch(userId: string) {
    const key = `u:${userId}`;
    if (Date.now() - (this.seen.get(key) ?? 0) < SEEN_EVERY_MS) return;
    this.seen.set(key, Date.now());
    void this.prisma
      .$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { lastSeenAt: new Date() },
        }),
        this.prisma.accountActivityDay.createMany({
          data: [{ day: today(), userId }],
          skipDuplicates: true,
        }),
      ])
      .catch((error: unknown) =>
        this.logger.warn(`отметка визита: ${String(error)}`),
      );
  }
}
