import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectorService } from 'src/collector/collector.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessService, FOREVER_MS, isBanned } from './access.service';
import { isProActive, ProService } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';

const DAY = 86_400_000;
/** Сколько дней в графиках дашборда. */
const SERIES_DAYS = 30;

/** Срок: N дней от сейчас, до даты или навсегда. */
export interface Term {
  days?: number;
  until?: string;
  forever?: boolean;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function untilOf(term: Term): Date {
  if (term.forever) return new Date(Date.now() + FOREVER_MS);
  if (term.until) {
    const d = new Date(term.until);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now())
      throw new BadRequestException('Дата должна быть в будущем');
    return d;
  }
  if (term.days && term.days > 0) return new Date(Date.now() + term.days * DAY);
  throw new BadRequestException('Укажите срок: дни, дату или «навсегда»');
}

const fmt = (d: Date) =>
  d.getTime() - Date.now() > 50 * 365 * DAY
    ? 'навсегда'
    : `до ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })}`;

/** Пользователь для админки (chatId — строкой: BigInt в JSON не уходит). */
function publicUser(s: {
  chatId: bigint;
  username: string | null;
  firstName: string | null;
  proUntil: Date | null;
  trialUsedAt: Date | null;
  bannedUntil: Date | null;
  banReason: string | null;
  blocked: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}) {
  return {
    chatId: String(s.chatId),
    username: s.username,
    firstName: s.firstName,
    pro: isProActive(s.proUntil),
    proUntil: s.proUntil,
    trialUsedAt: s.trialUsedAt,
    banned: isBanned(s.bannedUntil),
    bannedUntil: s.bannedUntil,
    banReason: s.banReason,
    botBlocked: s.blocked,
    lastSeenAt: s.lastSeenAt,
    createdAt: s.createdAt,
  };
}

const USER_SELECT = {
  chatId: true,
  username: true,
  firstName: true,
  proUntil: true,
  trialUsedAt: true,
  bannedUntil: true,
  banReason: true,
  blocked: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly access: AccessService,
    private readonly bot: TelegramBotService,
    private readonly collector: CollectorService,
  ) {}

  async dashboard() {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const since = ago(SERIES_DAYS);
    const db = this.prisma;
    const sub = db.telegramSubscriber;

    const [
      users,
      new1,
      new7,
      dau,
      wau,
      mau,
      proActive,
      trials,
      banned,
      priceAlerts,
      flipAlerts,
      emission,
      paidUsers,
      payments,
      revenue,
      revenue30,
      newSeries,
      activeSeries,
      paySeries,
      collector,
    ] = await Promise.all([
      sub.count(),
      sub.count({ where: { createdAt: { gte: ago(1) } } }),
      sub.count({ where: { createdAt: { gte: ago(7) } } }),
      sub.count({ where: { lastSeenAt: { gte: ago(1) } } }),
      sub.count({ where: { lastSeenAt: { gte: ago(7) } } }),
      sub.count({ where: { lastSeenAt: { gte: ago(30) } } }),
      sub.count({ where: { proUntil: { gt: now } } }),
      sub.count({ where: { trialUsedAt: { not: null } } }),
      sub.count({ where: { bannedUntil: { gt: now } } }),
      db.priceAlert.count(),
      db.flipAlert.count(),
      sub.count({ where: { NOT: { emissionRegions: { isEmpty: true } } } }),
      db.proPayment.groupBy({ by: ['chatId'] }).then((r) => r.length),
      db.proPayment.count(),
      db.proPayment.groupBy({
        by: ['currency'],
        _sum: { amount: true },
        _count: true,
      }),
      db.proPayment.groupBy({
        by: ['currency'],
        where: { createdAt: { gte: ago(30) } },
        _sum: { amount: true },
        _count: true,
      }),
      db.$queryRaw<{ day: Date; n: number }[]>`
        SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS n
        FROM telegram_subscribers WHERE "createdAt" >= ${since} GROUP BY 1`,
      db.$queryRaw<{ day: Date; n: number }[]>`
        SELECT day, count(*)::int AS n FROM activity_days WHERE day >= ${since}::date GROUP BY 1`,
      db.$queryRaw<{ day: Date; n: number }[]>`
        SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS n
        FROM pro_payments WHERE "createdAt" >= ${since} GROUP BY 1`,
      this.collector.status(),
    ]);

    // ряды за SERIES_DAYS дней, пропуски — нулями
    const series = (rows: { day: Date; n: number }[]) => {
      const byDay = new Map(rows.map((r) => [dayKey(new Date(r.day)), r.n]));
      return Array.from({ length: SERIES_DAYS }, (_, i) => {
        const d = dayKey(new Date(now.getTime() - (SERIES_DAYS - 1 - i) * DAY));
        return { day: d, n: byDay.get(d) ?? 0 };
      });
    };
    const money = (rows: typeof revenue) =>
      rows.map((r) => ({
        currency: r.currency ?? '—',
        amount: r._sum.amount ?? 0,
        count: r._count,
      }));

    return {
      updatedAt: now.toISOString(),
      users: { total: users, new1, new7, dau, wau, mau, banned },
      pro: { active: proActive, trials, paidUsers, payments },
      revenue: { total: money(revenue), last30: money(revenue30) },
      alerts: { price: priceAlerts, flip: flipAlerts, emission },
      series: {
        newUsers: series(newSeries),
        active: series(activeSeries),
        payments: series(paySeries),
      },
      collector: {
        regions: collector.regions,
        tracked: collector.tracked,
        overdue: collector.overdue,
        backfilling: collector.backfilling,
        budget: collector.budget,
        stored: collector.stored,
      },
    };
  }

  /** Поиск: @ник, часть ника/имени или Telegram id. Пусто — последние активные. */
  async users(q: string) {
    const query = q.trim().replace(/^@/, '');
    const where = !query
      ? {}
      : /^\d+$/.test(query)
        ? { chatId: BigInt(query) }
        : {
            OR: [
              { username: { contains: query, mode: 'insensitive' as const } },
              { firstName: { contains: query, mode: 'insensitive' as const } },
            ],
          };
    const list = await this.prisma.telegramSubscriber.findMany({
      where,
      select: USER_SELECT,
      orderBy: [
        { lastSeenAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 30,
    });
    return list.map(publicUser);
  }

  async user(chatId: string) {
    const s = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: BigInt(chatId) },
      select: {
        ...USER_SELECT,
        _count: { select: { priceAlerts: true, flipAlerts: true } },
      },
    });
    if (!s) throw new NotFoundException('Пользователь не найден');
    const [payments, log] = await Promise.all([
      this.prisma.proPayment.findMany({
        where: { chatId: s.chatId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.adminLog.findMany({
        where: { targetId: s.chatId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      ...publicUser(s),
      alerts: { price: s._count.priceAlerts, flip: s._count.flipAlerts },
      payments: payments.map((p) => ({ ...p, chatId: String(p.chatId) })),
      log: log.map(publicLog),
    };
  }

  /** Последние действия всех админов. */
  async log() {
    const rows = await this.prisma.adminLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(publicLog);
  }

  /** Выдать Pro: +дни к текущему сроку, до даты или навсегда. */
  async grantPro(
    adminId: number,
    chatId: string,
    term: Term & { notify?: boolean },
  ) {
    await this.ensure(chatId);
    const until =
      term.days && !term.until && !term.forever
        ? await this.pro.grant(BigInt(chatId), term.days)
        : await this.pro.setUntil(BigInt(chatId), untilOf(term));
    await this.logAction(adminId, chatId, 'pro_grant', fmt(until!));
    if (term.notify !== false)
      await this.bot.send(
        BigInt(chatId),
        `⭐ <b>Вам выдан STALZONE INFO Pro</b> ${fmt(until!)}.\nФлиппер, графики и флип-алерты уже открыты.`,
      );
    return this.user(chatId);
  }

  async revokePro(adminId: number, chatId: string) {
    await this.ensure(chatId);
    await this.pro.setUntil(BigInt(chatId), null);
    await this.logAction(adminId, chatId, 'pro_revoke');
    return this.user(chatId);
  }

  async ban(adminId: number, chatId: string, term: Term & { reason?: string }) {
    if (this.access.isAdmin(BigInt(chatId)))
      throw new BadRequestException('Нельзя забанить администратора');
    await this.ensure(chatId);
    const until = untilOf(term);
    const reason = term.reason?.trim().slice(0, 300) || null;
    await this.prisma.telegramSubscriber.update({
      where: { chatId: BigInt(chatId) },
      data: { bannedUntil: until, banReason: reason },
    });
    this.access.forget(chatId);
    await this.logAction(
      adminId,
      chatId,
      'ban',
      `${fmt(until)}${reason ? ` · ${reason}` : ''}`,
    );
    return this.user(chatId);
  }

  async unban(adminId: number, chatId: string) {
    await this.ensure(chatId);
    await this.prisma.telegramSubscriber.update({
      where: { chatId: BigInt(chatId) },
      data: { bannedUntil: null, banReason: null },
    });
    this.access.forget(chatId);
    await this.logAction(adminId, chatId, 'unban');
    return this.user(chatId);
  }

  /** Пользователь по id может ещё не быть в БД (не заходил) — создаём, чтобы выдать Pro/бан заранее. */
  private ensure(chatId: string) {
    const id = BigInt(chatId);
    return this.prisma.telegramSubscriber.upsert({
      where: { chatId: id },
      create: { chatId: id },
      update: {},
    });
  }

  private logAction(
    adminId: number,
    chatId: string,
    action: string,
    details?: string,
  ) {
    return this.prisma.adminLog.create({
      data: {
        adminId: BigInt(adminId),
        targetId: BigInt(chatId),
        action,
        details,
      },
    });
  }
}

function publicLog(l: {
  id: string;
  adminId: bigint;
  targetId: bigint;
  action: string;
  details: string | null;
  createdAt: Date;
}) {
  return { ...l, adminId: String(l.adminId), targetId: String(l.targetId) };
}
