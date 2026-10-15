import { Injectable, Logger } from '@nestjs/common';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { CollectorService } from 'src/collector/collector.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { FEE, FLIP_WINDOW_DAYS, MIN_DEALS } from './flip-filter';
import {
  hoursToSell,
  priceForHours,
  SELL_TARGETS,
  undercut,
  type LadderStep,
  type SalePrices,
  type SellMarket,
} from './sell-estimate';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Окно сделок — как у флиппера: рынок быстро демпингуется. */
const WINDOW_DAYS = FLIP_WINDOW_DAYS;
/** Ответ на позицию живёт 30 с: лоты сборщик обновляет раз в минуту, у открытых предметов — чаще. */
const TTL_MS = 30_000;
/** Снимок лотов старше этого — сначала снимаем свежий. */
const MAX_LOTS_AGE = 5 * MIN;
/** Сколько самых дешёвых лотов отдаём фронту (оценка «моя цена → время» считается по ним). */
const LADDER_MAX = 200;

/** Ступени заточки — как у флиппера и на фронте: +0, +1–4, +5–9, +10–14, +15. */
const TIERS = [
  [0, 0],
  [1, 4],
  [5, 9],
  [10, 14],
  [15, 15],
] as const;
const tierRange = (u: number) =>
  TIERS.find(([lo, hi]) => u >= lo && u <= hi) ?? TIERS[0];

export interface SellQuery {
  region: string;
  itemId: string;
  /** -1 — у предмета нет качества */
  quality: number;
  upgrade: number;
  /** Ключевая характеристика модуля; "" — у предмета вариантов нет */
  variant: string;
  /** Сколько штук продаём одним лотом */
  amount: number;
}

export interface SellTarget {
  hours: number;
  /** цена за штуку; null — за этот срок не продать даже дешевле всех */
  price: number | null;
}

export interface SellAdvice {
  region: string;
  itemId: string;
  quality: number;
  upgrade: number;
  variant: string;
  amount: number;
  updatedAt: string;
  /** exact — сделки с той же заточкой, tier — со ступенью заточки (точных мало) */
  basis: 'exact' | 'tier';
  windowDays: number;
  /** Сделок и проданных штук за окно, штук в час */
  deals: number;
  units: number;
  ratePerHour: number;
  /** Цены сделок за штуку; null — сделок мало, цене не верим */
  sales: SalePrices | null;
  lastSale: string | null;
  /** Лоты той же позиции по возрастанию цены за штуку (не больше LADDER_MAX) */
  ladder: LadderStep[];
  lotsTotal: number;
  lotsAt: string | null;
  /** Перебить самый дешёвый лот — быстрее всего */
  quick: { price: number; hours: number | null } | null;
  targets: SellTarget[];
  fee: number;
}

/** Перцентили цены сделок: p10, p25, медиана, p75, p90. */
const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9];

interface StatsRow {
  e_n: number;
  e_units: number;
  e_q: number[] | null;
  e_last: Date | null;
  t_n: number;
  t_units: number;
  t_q: number[] | null;
  t_last: Date | null;
  /** самая ранняя сделка предмета в окне (любого качества) */
  first: Date | null;
}

interface LotRow {
  upgrade: number;
  amount: number;
  buyoutPrice: bigint;
}

/**
 * Помощник продажи (Pro): по какой цене выставить лот, чтобы он ушёл за N часов.
 * Позиция — предмет + качество + заточка + вариант (ключевая характеристика модуля);
 * сделок мало — ступень заточки, вариант всегда точный.
 * Считает по БД сборщика: скорость сделок за окно и очередь лотов дешевле (sell-estimate.ts).
 */
@Injectable()
export class SellAdvisorService {
  private readonly log = new Logger(SellAdvisorService.name);
  private readonly cache = new TtlCache<SellAdvice>(500);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
  ) {}

  advise(q: SellQuery) {
    const key = `${q.region}|${q.itemId}|${q.quality}|${q.upgrade}|${q.variant}|${q.amount}`;
    return this.cache.getOrLoad(key, TTL_MS, () => this.compute(q));
  }

  private async compute(q: SellQuery): Promise<SellAdvice> {
    const { region, itemId, quality, upgrade, variant, amount } = q;
    await this.collector.touch(region, itemId, 'view');
    let tracked = await this.prisma.trackedItem.findUnique({
      where: { region_itemId: { region, itemId } },
      select: { lastLotsAt: true, historyFrom: true },
    });
    if (
      this.collector.enabled &&
      (!tracked?.lastLotsAt ||
        Date.now() - tracked.lastLotsAt.getTime() > MAX_LOTS_AGE)
    ) {
      await this.collector
        .refreshLots(region, itemId)
        .catch((e: Error) => this.log.warn(`лоты ${itemId}: ${e.message}`));
      tracked = await this.prisma.trackedItem.findUnique({
        where: { region_itemId: { region, itemId } },
        select: { lastLotsAt: true, historyFrom: true },
      });
    }

    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * HOUR);
    // история в БД может быть короче окна (предмет только начали собирать)
    const from = new Date(
      Math.max(since.getTime(), tracked?.historyFrom?.getTime() ?? 0),
    );
    const [lo, hi] = tierRange(upgrade);

    // сделки с той же заточкой (e_*) и со всей её ступенью (t_*)
    const [row] = await this.prisma.$queryRaw<StatsRow[]>`
      WITH s AS (
        SELECT "upgrade" = ${upgrade} AS exact, GREATEST("amount", 1) AS amount,
               "price"::float8 / GREATEST("amount", 1) AS unit, "time"
        FROM "auction_sales"
        WHERE "region" = ${region} AND "itemId" = ${itemId} AND "quality" = ${quality}
          AND "variant" = ${variant}
          AND "upgrade" BETWEEN ${lo} AND ${hi} AND "time" >= ${from} AND "price" > 0
      )
      SELECT count(*) FILTER (WHERE exact)::int AS e_n,
             coalesce(sum(amount) FILTER (WHERE exact), 0)::float8 AS e_units,
             percentile_cont(${QUANTILES}::float8[]) WITHIN GROUP (ORDER BY unit) FILTER (WHERE exact) AS e_q,
             max("time") FILTER (WHERE exact) AS e_last,
             count(*)::int AS t_n,
             coalesce(sum(amount), 0)::float8 AS t_units,
             percentile_cont(${QUANTILES}::float8[]) WITHIN GROUP (ORDER BY unit) AS t_q,
             max("time") AS t_last,
             (SELECT min("time") FROM "auction_sales"
              WHERE "region" = ${region} AND "itemId" = ${itemId} AND "time" >= ${from}) AS first
      FROM s`;
    // пока старая история догружается (historyFrom = null), сделки в БД — только с самой ранней
    // собранной: скорость считаем от неё (сборщик идёт от новых сделок к старым)
    const start =
      !tracked?.historyFrom && row.first
        ? Math.max(from.getTime(), new Date(row.first).getTime())
        : from.getTime();
    const hours = Math.max(1, (now.getTime() - start) / HOUR);
    const basis: SellAdvice['basis'] =
      row.e_n >= MIN_DEALS || lo === hi ? 'exact' : 'tier';
    const stats =
      basis === 'exact'
        ? { n: row.e_n, units: row.e_units, q: row.e_q, last: row.e_last }
        : { n: row.t_n, units: row.t_units, q: row.t_q, last: row.t_last };
    // конкуренты — лоты той же заточки (или ступени, если цену считаем по ней)
    const [lotsFrom, lotsTo] =
      basis === 'exact' ? [upgrade, upgrade] : [lo, hi];

    const lots = await this.prisma.$queryRaw<LotRow[]>`
      SELECT l."upgrade", l."amount", l."buyoutPrice"
      FROM "auction_lots" l
      JOIN "tracked_items" t ON t."region" = l."region" AND t."itemId" = l."itemId"
      WHERE l."region" = ${region} AND l."itemId" = ${itemId} AND l."quality" = ${quality}
        AND l."variant" = ${variant}
        AND l."upgrade" BETWEEN ${lotsFrom} AND ${lotsTo}
        AND l."goneAt" IS NULL AND l."buyoutPrice" > 0
        AND l."lastSeenAt" >= t."lastLotsAt" AND l."endTime" > ${now}`;
    const ladder = lots
      .map((l) => {
        const amount = Math.max(1, l.amount);
        return { unit: Math.round(Number(l.buyoutPrice) / amount), amount };
      })
      .sort((a, b) => a.unit - b.unit);

    const { n, units } = stats;
    const sales: SalePrices | null =
      n >= MIN_DEALS && stats.q
        ? {
            p10: Math.round(stats.q[0]),
            p25: Math.round(stats.q[1]),
            median: Math.round(stats.q[2]),
            p75: Math.round(stats.q[3]),
            p90: Math.round(stats.q[4]),
          }
        : null;
    const ratePerHour = units / hours;
    const market: SellMarket | null = sales
      ? { ladder, ratePerHour, sales }
      : null;

    const cheapest = ladder[0]?.unit;
    const quickPrice = cheapest ? undercut(cheapest) : sales?.median;
    return {
      region,
      itemId,
      quality,
      upgrade,
      variant,
      amount,
      updatedAt: now.toISOString(),
      basis,
      windowDays: WINDOW_DAYS,
      deals: n,
      units: Math.round(units),
      ratePerHour: Math.round(ratePerHour * 100) / 100,
      sales,
      lastSale: stats.last ? new Date(stats.last).toISOString() : null,
      ladder: ladder.slice(0, LADDER_MAX),
      lotsTotal: ladder.length,
      lotsAt: tracked?.lastLotsAt?.toISOString() ?? null,
      quick:
        quickPrice != null
          ? {
              price: quickPrice,
              hours: market ? hoursToSell(market, quickPrice, amount) : null,
            }
          : null,
      targets: market
        ? SELL_TARGETS.map((h) => ({
            hours: h,
            price: priceForHours(market, h, amount),
          }))
        : [],
      fee: FEE,
    };
  }
}
