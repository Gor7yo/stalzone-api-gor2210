import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectorService } from 'src/collector/collector.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccessService, FOREVER_MS, isBanned } from './access.service';
import { AccountService } from './account.service';
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

const USER_SELECT = {
  id: true,
  login: true,
  chatId: true,
  proUntil: true,
  trialUsedAt: true,
  bannedUntil: true,
  banReason: true,
  lastSeenAt: true,
  createdAt: true,
  subscriber: { select: { username: true, firstName: true, blocked: true } },
} as const;

type UserRow = {
  id: string;
  login: string;
  chatId: bigint | null;
  proUntil: Date | null;
  trialUsedAt: Date | null;
  bannedUntil: Date | null;
  banReason: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  subscriber: {
    username: string | null;
    firstName: string | null;
    blocked: boolean;
  } | null;
};

/** Аккаунт для админки (chatId — строкой: BigInt в JSON не уходит). */
function publicUser(u: UserRow) {
  return {
    id: u.id,
    login: u.login,
    telegram: u.chatId
      ? {
          chatId: String(u.chatId),
          username: u.subscriber?.username ?? null,
          firstName: u.subscriber?.firstName ?? null,
          botBlocked: u.subscriber?.blocked ?? false,
        }
      : null,
    pro: isProActive(u.proUntil),
    proUntil: u.proUntil,
    trialUsedAt: u.trialUsedAt,
    banned: isBanned(u.bannedUntil),
    bannedUntil: u.bannedUntil,
    banReason: u.banReason,
    lastSeenAt: u.lastSeenAt,
    createdAt: u.createdAt,
  };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly access: AccessService,
    private readonly accounts: AccountService,
    private readonly bot: TelegramBotService,
    private readonly collector: CollectorService,
  ) {}

  async dashboard() {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const since = ago(SERIES_DAYS);
    const db = this.prisma;
    const users = db.user;

    const [
      total,
      new1,
      new7,
      dau,
      wau,
      mau,
      telegram,
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
      users.count(),
      users.count({ where: { createdAt: { gte: ago(1) } } }),
      users.count({ where: { createdAt: { gte: ago(7) } } }),
      users.count({ where: { lastSeenAt: { gte: ago(1) } } }),
      users.count({ where: { lastSeenAt: { gte: ago(7) } } }),
      users.count({ where: { lastSeenAt: { gte: ago(30) } } }),
      users.count({ where: { chatId: { not: null } } }),
      users.count({ where: { proUntil: { gt: now } } }),
      users.count({ where: { trialUsedAt: { not: null } } }),
      users.count({ where: { bannedUntil: { gt: now } } }),
      db.priceAlert.count(),
      db.flipAlert.count(),
      db.telegramSubscriber.count({
        where: { NOT: { emissionRegions: { isEmpty: true } } },
      }),
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
        FROM users WHERE "createdAt" >= ${since} GROUP BY 1`,
      db.$queryRaw<{ day: Date; n: number }[]>`
        SELECT day, count(*)::int AS n FROM account_activity_days WHERE day >= ${since}::date GROUP BY 1`,
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
      users: { total, new1, new7, dau, wau, mau, banned, telegram },
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

  /** Поиск: логин EXBO, @ник или имя Telegram, Telegram id. Пусто — последние активные. */
  async users(q: string) {
    const query = q.trim().replace(/^@/, '');
    const like = { contains: query, mode: 'insensitive' as const };
    const where = !query
      ? {}
      : {
          OR: [
            { login: like },
            { subscriber: { is: { username: like } } },
            { subscriber: { is: { firstName: like } } },
            ...(/^\d{1,20}$/.test(query) ? [{ chatId: BigInt(query) }] : []),
          ],
        };
    const list = await this.prisma.user.findMany({
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

  async user(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: USER_SELECT,
    });
    if (!u) throw new NotFoundException('Пользователь не найден');
    const [price, flip, payments, log] = await Promise.all([
      u.chatId
        ? this.prisma.priceAlert.count({ where: { chatId: u.chatId } })
        : 0,
      u.chatId
        ? this.prisma.flipAlert.count({ where: { chatId: u.chatId } })
        : 0,
      this.prisma.proPayment.findMany({
        where: {
          OR: [{ userId: u.id }, ...(u.chatId ? [{ chatId: u.chatId }] : [])],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.adminLog.findMany({
        where: {
          OR: [
            { targetUserId: u.id },
            ...(u.chatId ? [{ targetId: u.chatId }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      ...publicUser(u),
      alerts: { price, flip },
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
    // логины целей - чтобы в журнале было видно, кому выдали/кого забанили
    const ids = [...new Set(rows.flatMap((r) => r.targetUserId ?? []))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, login: true },
    });
    const login = new Map(users.map((u) => [u.id, u.login]));
    return rows.map((r) => ({
      ...publicLog(r),
      targetLogin: r.targetUserId ? (login.get(r.targetUserId) ?? null) : null,
    }));
  }

  /** Выдать Pro: +дни к текущему сроку, до даты или навсегда. */
  async grantPro(
    adminId: bigint,
    id: string,
    term: Term & { notify?: boolean },
  ) {
    const u = await this.target(id);
    const until =
      term.days && !term.until && !term.forever
        ? await this.pro.grant(id, term.days)
        : await this.pro.setUntil(id, untilOf(term));
    await this.logAction(adminId, id, 'pro_grant', fmt(until));
    if (term.notify !== false && u.chatId)
      await this.bot.send(
        u.chatId,
        `⭐ <b>Вам выдан STALZONE INFO Pro</b> ${fmt(until)}.\nФлиппер, графики и флип-алерты уже открыты.`,
      );
    return this.user(id);
  }

  async revokePro(adminId: bigint, id: string) {
    await this.target(id);
    await this.pro.setUntil(id, null);
    await this.logAction(adminId, id, 'pro_revoke');
    return this.user(id);
  }

  async ban(adminId: bigint, id: string, term: Term & { reason?: string }) {
    const u = await this.target(id);
    if (this.access.isAdmin(u.chatId))
      throw new BadRequestException('Нельзя забанить администратора');
    const until = untilOf(term);
    const reason = term.reason?.trim().slice(0, 300) || null;
    await this.accounts.setBan(id, until, reason);
    this.access.forget(id, u.chatId);
    await this.logAction(
      adminId,
      id,
      'ban',
      `${fmt(until)}${reason ? ` · ${reason}` : ''}`,
    );
    return this.user(id);
  }

  async unban(adminId: bigint, id: string) {
    const u = await this.target(id);
    await this.accounts.setBan(id, null, null);
    this.access.forget(id, u.chatId);
    await this.logAction(adminId, id, 'unban');
    return this.user(id);
  }

  private async target(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { chatId: true },
    });
    if (!u) throw new NotFoundException('Пользователь не найден');
    return u;
  }

  private logAction(
    adminId: bigint,
    userId: string,
    action: string,
    details?: string,
  ) {
    return this.prisma.adminLog.create({
      data: { adminId, targetUserId: userId, action, details },
    });
  }
}

function publicLog(l: {
  id: string;
  adminId: bigint;
  targetId: bigint | null;
  targetUserId: string | null;
  action: string;
  details: string | null;
  createdAt: Date;
}) {
  return {
    ...l,
    adminId: String(l.adminId),
    targetId: l.targetId == null ? null : String(l.targetId),
  };
}
