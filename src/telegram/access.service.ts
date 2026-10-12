import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
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
 * Доступ пользователя Telegram: бан от админа, отметка визита (для метрик)
 * и проверка «админ ли это» (ADMIN_CHAT_IDS в .env).
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

  isAdmin(chatId: number | bigint) {
    return this.admins.has(String(chatId));
  }

  /** Бросает 403 code=banned, если пользователь забанен. Заодно отмечает визит. */
  async check(user: SubscriberInfo) {
    const key = String(user.id);
    this.touch(user);
    if (this.isAdmin(user.id)) return;
    const until = await this.bannedUntil(key);
    if (isBanned(until)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'banned',
        message: 'Доступ ограничен администратором',
        until: until!.toISOString(),
      });
    }
  }

  async bannedUntil(chatId: string): Promise<Date | null> {
    const cached = this.bans.get(chatId);
    if (cached && Date.now() - cached.at < BAN_CACHE_MS) return cached.until;
    const s = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { bannedUntil: true },
    });
    const until = s?.bannedUntil ?? null;
    this.bans.set(chatId, { until, at: Date.now() });
    return until;
  }

  /** Админ поменял бан — сбросить кеш, чтобы сработало сразу. */
  forget(chatId: string) {
    this.bans.delete(chatId);
  }

  /** Отметка визита: subscriber (с ником для поиска), lastSeenAt и день активности. */
  private touch(user: SubscriberInfo) {
    const key = String(user.id);
    const last = this.seen.get(key) ?? 0;
    if (Date.now() - last < SEEN_EVERY_MS) return;
    this.seen.set(key, Date.now());
    const chatId = BigInt(user.id);
    const now = new Date();
    const names = {
      ...(user.first_name !== undefined && { firstName: user.first_name }),
      ...(user.username !== undefined && { username: user.username }),
    };
    void this.prisma
      .$transaction([
        this.prisma.telegramSubscriber.upsert({
          where: { chatId },
          create: { chatId, ...names, lastSeenAt: now },
          update: { ...names, lastSeenAt: now },
        }),
        this.prisma.activityDay.createMany({
          data: [{ day: today(), chatId }],
          skipDuplicates: true,
        }),
      ])
      .catch((error: unknown) =>
        this.logger.warn(`отметка визита: ${String(error)}`),
      );
  }
}
