import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CollectorService } from 'src/collector/collector.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { AccessService } from './access.service';
import { TelegramBotService } from './telegram-bot.service';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Сборщик молчит дольше — тревога. */
export const COLLECTOR_STALE_MS = 15 * MIN;
/** Сбоев EXBO за 5 минут — тревога. */
export const EXBO_FAILURES = 20;
const EXBO_WINDOW_MS = 5 * MIN;
/** Утренняя сводка — в 9:00 по Москве (UTC+3). */
const SUMMARY_HOUR_UTC = 6;

export interface CheckResult {
  /** null — всё в порядке */
  problem: string | null;
}

/**
 * Мониторинг в Telegram: раз в минуту проверяет сборщик аукциона, EXBO и базу,
 * пишет админам (ADMIN_CHAT_IDS) при поломке и когда снова работает; в 9:00 МСК — сводка за сутки.
 * Тревога — только при смене состояния, без повторов каждую минуту.
 * Выключен локально (NODE_ENV=test) и при MONITOR=false.
 */
@Injectable()
export class MonitorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MonitorService.name);
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  /** текущие проблемы: проверка → с какого момента */
  private readonly down = new Map<string, number>();
  private lastSummaryDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly access: AccessService,
    private readonly collector: CollectorService,
    private readonly stalcraft: StalcraftApiClient,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('MONITOR') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.enabled || !this.bot.enabled) return;
    if (!this.access.adminIds.length) {
      this.logger.warn('ADMIN_CHAT_IDS не задан — мониторингу некому писать');
      return;
    }
    // сводку за сегодня не шлём, если сервер перезапустился после 9:00
    this.lastSummaryDay = this.summaryDue(new Date()) ? dayKey(new Date()) : '';
    void this.notify('🔄 <b>Сервер запущен</b> - мониторинг работает.');
    this.timer = setInterval(() => void this.tick(), MIN);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    const checks: [string, () => Promise<CheckResult>][] = [
      ['db', () => this.checkDb()],
      ['collector', () => this.checkCollector()],
      ['exbo', () => this.checkExbo()],
    ];
    for (const [name, check] of checks) {
      // база лежит — проверка сборщика (запрос в базу) тоже упадёт: одна тревога вместо двух
      if (name === 'collector' && this.down.has('db')) continue;
      const { problem } = await check().catch((e: Error) => ({
        problem: `проверка упала: ${e.message}`,
      }));
      await this.transition(name, problem);
    }
    const now = new Date();
    if (this.summaryDue(now) && this.lastSummaryDay !== dayKey(now)) {
      this.lastSummaryDay = dayKey(now);
      await this.summary().catch((e: Error) =>
        this.logger.warn(`сводка: ${e.message}`),
      );
    }
  }

  /** Сообщаем только о смене состояния: сломалось / починилось (со временем простоя). */
  private async transition(name: string, problem: string | null) {
    const since = this.down.get(name);
    if (problem && since === undefined) {
      this.down.set(name, Date.now());
      await this.notify(`⚠️ <b>${TITLES[name] ?? name}</b>\n${problem}`);
    } else if (!problem && since !== undefined) {
      this.down.delete(name);
      const minutes = Math.max(1, Math.round((Date.now() - since) / MIN));
      await this.notify(
        `✅ <b>${TITLES[name] ?? name}</b> - снова работает (простой ~${minutes} мин).`,
      );
    }
  }

  async checkDb(): Promise<CheckResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { problem: null };
    } catch (e) {
      return { problem: `База данных не отвечает: ${(e as Error).message}` };
    }
  }

  /** Сборщик пишет lastSeenAt лотам при каждом снимке — давно не писал, значит встал. */
  async checkCollector(): Promise<CheckResult> {
    if (!this.collector.enabled) return { problem: null };
    const [row] = await this.prisma.$queryRaw<{ at: Date | null }[]>`
      SELECT max("lastSeenAt") AS at FROM "auction_lots"`;
    return { problem: collectorProblem(row?.at ?? null, Date.now()) };
  }

  checkExbo(): Promise<CheckResult> {
    const n = this.stalcraft.failuresSince(EXBO_WINDOW_MS);
    return Promise.resolve({
      problem:
        n >= EXBO_FAILURES
          ? `EXBO отвечает ошибками: ${n} за 5 минут. Цены и профили могут не обновляться.`
          : null,
    });
  }

  private summaryDue(now: Date) {
    return now.getUTCHours() >= SUMMARY_HOUR_UTC;
  }

  /** Сводка за сутки: люди, деньги, поддержка, сбор данных. */
  async summary() {
    const since = new Date(Date.now() - DAY);
    const [
      newUsers,
      active,
      trials,
      payments,
      referrals,
      tickets,
      openTickets,
      sales,
    ] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: since } } }),
      this.prisma.user.count({ where: { lastSeenAt: { gte: since } } }),
      this.prisma.user.count({ where: { trialUsedAt: { gte: since } } }),
      this.prisma.proPayment.count({ where: { createdAt: { gte: since } } }),
      this.prisma.referral.count({ where: { createdAt: { gte: since } } }),
      this.prisma.supportTicket.count({ where: { createdAt: { gte: since } } }),
      this.prisma.supportTicket.count({ where: { status: 'open' } }),
      this.prisma.auctionSale.count({ where: { time: { gte: since } } }),
    ]);
    const problems = [...this.down.keys()].map((k) => TITLES[k] ?? k);
    await this.notify(
      [
        '☀️ <b>Сводка за сутки</b>',
        '',
        `👤 Новых аккаунтов: <b>${newUsers}</b> · заходили: <b>${active}</b>`,
        `🎁 Взяли пробный: <b>${trials}</b> · пришли по приглашению: <b>${referrals}</b>`,
        `💳 Оплат Pro: <b>${payments}</b>`,
        `🛟 Новых обращений: <b>${tickets}</b> · ждут ответа: <b>${openTickets}</b>`,
        `📦 Собрано сделок: <b>${sales.toLocaleString('ru-RU')}</b>`,
        '',
        problems.length
          ? `⚠️ Сейчас не работает: ${problems.join(', ')}`
          : '✅ Всё работает',
      ].join('\n'),
    );
  }

  private async notify(html: string) {
    for (const admin of this.access.adminIds) {
      await this.bot.send(Number(admin), html);
    }
  }
}

const TITLES: Record<string, string> = {
  db: 'База данных',
  collector: 'Сборщик аукциона',
  exbo: 'API EXBO',
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Проблема сборщика по времени последнего снимка (чистая функция — для тестов). */
export function collectorProblem(lastAt: Date | null, now: number) {
  if (!lastAt) return 'Сборщик ещё не записал ни одного лота.';
  const idle = now - lastAt.getTime();
  if (idle < COLLECTOR_STALE_MS) return null;
  return `Сборщик аукциона ${Math.round(idle / MIN)} мин не обновлял лоты - цены, флиппер и алерты показывают старые данные.`;
}
