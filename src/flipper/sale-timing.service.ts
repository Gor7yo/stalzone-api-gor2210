import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import type { Region } from 'src/api/dto/queries.dto';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';

const DAY = 86_400_000;
/** Сколько истории берём: 8 недель (сколько есть, если меньше). */
const WINDOW_DAYS = 56;
/** День в расчёт — только если в нём столько сделок (иначе медиана дня случайна). */
const MIN_DAY_DEALS = 3;
/** Час / день недели показываем, только если в нём столько сделок. */
export const MIN_HOUR_DEALS = 10;
export const MIN_WEEKDAY_DEALS = 20;
/** Выводы по дням недели надёжны с такого числа недель; меньше — помечаем «мало недель». */
export const RELIABLE_WEEKS = 8;
/** Меньше сделок всего — не показываем ничего. */
export const MIN_TOTAL_DEALS = 150;
/** Час «живой» для совета, если сделок в нём не меньше этой доли от среднего за час. */
export const LIQUID_SHARE = 0.5;
const CACHE_MS = 30 * 60_000;
/** Moscow — UTC+3 без перехода на летнее время. */
const MSK = "interval '3 hours'";

export interface TimingSlot {
  /** час 0–23 или день недели 1 (пн) … 7 (вс) */
  key: number;
  /** отклонение медианы цены от обычной для того же дня, %; null — мало сделок */
  delta: number | null;
  /** сделок за весь период в этот час / день недели */
  deals: number;
}

export interface SaleTiming {
  /** всего сделок в расчёте; 0 — данных мало, показывать нечего */
  deals: number;
  /** сколько дней с данными и сколько недель охвачено */
  days: number;
  weeks: number;
  /** по дням недели — только при weeks ≥ RELIABLE_WEEKS считаем надёжным */
  weekdaysReliable: boolean;
  hours: TimingSlot[];
  weekdays: TimingSlot[];
  /** лучший и худший час для продажи (null — нет надёжных) */
  bestHour: TimingSlot | null;
  worstHour: TimingSlot | null;
  /** отклонение текущего часа МСК — для «сейчас цены на 3% ниже обычного» */
  now: TimingSlot | null;
}

/** Ступени заточки, как в радаре: 0, 1–4, 5–9, 10–14, 15. */
const TIER_SQL = Prisma.sql`CASE WHEN "upgrade" <= 0 THEN 0 WHEN "upgrade" <= 4 THEN 1
  WHEN "upgrade" <= 9 THEN 2 WHEN "upgrade" <= 14 THEN 3 ELSE 4 END`;
const tierOf = (u: number) =>
  u <= 0 ? 0 : u <= 4 ? 1 : u <= 9 ? 2 : u <= 14 ? 3 : 4;

interface Row {
  kind: 'h' | 'd' | 'all';
  key: number | null;
  delta: number | null;
  n: number;
  days: number | null;
  weeks: number | null;
}

/**
 * «Когда выгоднее продавать»: по сделкам из БД сборщика за последние 8 недель.
 * Каждую сделку сравниваем с медианой цены за штуку в тот же день (так тренд за месяц не искажает
 * картину), потом медиана этих отношений по часам суток и по дням недели (время московское).
 * Одно качество, ступень заточки и характеристика модуля — иначе карта покажет не время, а смесь лотов.
 */
@Injectable()
export class SaleTimingService {
  private readonly cache = new TtlCache<SaleTiming>(1000);

  constructor(private readonly prisma: PrismaService) {}

  get(q: {
    region: Region;
    itemId: string;
    quality: number;
    upgrade: number;
    variant: string;
  }) {
    const tier = tierOf(q.upgrade);
    const key = `${q.region}:${q.itemId}:${q.quality}:${tier}:${q.variant}`;
    return this.cache.getOrLoad(key, CACHE_MS, async () =>
      summarize(await this.rows({ ...q, tier }), new Date()),
    );
  }

  private rows(q: {
    region: Region;
    itemId: string;
    quality: number;
    tier: number;
    variant: string;
  }) {
    const since = new Date(Date.now() - WINDOW_DAYS * DAY);
    const msk = Prisma.raw(MSK);
    return this.prisma.$queryRaw<Row[]>`
      WITH s AS (
        SELECT "time" + ${msk} AS t, "price"::float8 / GREATEST("amount", 1) AS unit
        FROM "auction_sales"
        WHERE "region" = ${q.region} AND "itemId" = ${q.itemId} AND "time" >= ${since}
          AND "price" > 0 AND "quality" = ${q.quality} AND "variant" = ${q.variant}
          AND ${TIER_SQL} = ${q.tier}
      ), d AS (
        SELECT date_trunc('day', t) AS day,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS med, count(*) AS n
        FROM s GROUP BY 1
      ), r AS (
        SELECT s.t, s.unit / d.med AS ratio
        FROM s JOIN d ON date_trunc('day', s.t) = d.day
        WHERE d.n >= ${MIN_DAY_DEALS} AND d.med > 0
      )
      SELECT 'h' AS kind, extract(hour FROM t)::int AS key,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) - 1) * 100 AS delta,
             count(*)::int AS n, NULL::int AS days, NULL::int AS weeks
      FROM r GROUP BY 2
      UNION ALL
      SELECT 'd', extract(isodow FROM t)::int,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) - 1) * 100,
             count(*)::int, NULL, NULL
      FROM r GROUP BY 2
      UNION ALL
      SELECT 'all', NULL, NULL, count(*)::int,
             count(DISTINCT date_trunc('day', t))::int,
             count(DISTINCT date_trunc('week', t))::int
      FROM r`;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Сырые строки → ответ: пороги надёжности, лучший/худший час, текущий час. Чистая функция — для тестов. */
export function summarize(rows: Row[], now: Date): SaleTiming {
  const all = rows.find((r) => r.kind === 'all');
  const deals = all?.n ?? 0;
  const days = all?.days ?? 0;
  const weeks = all?.weeks ?? 0;
  const slots = (kind: 'h' | 'd', keys: number[], min: number) =>
    keys.map((key): TimingSlot => {
      const r = rows.find((x) => x.kind === kind && x.key === key);
      const n = r?.n ?? 0;
      return {
        key,
        deals: n,
        delta: r && r.delta != null && n >= min ? round1(r.delta) : null,
      };
    });

  if (deals < MIN_TOTAL_DEALS) {
    return {
      deals: 0,
      days,
      weeks,
      weekdaysReliable: false,
      hours: [],
      weekdays: [],
      bestHour: null,
      worstHour: null,
      now: null,
    };
  }
  const hours = slots(
    'h',
    Array.from({ length: 24 }, (_, i) => i),
    MIN_HOUR_DEALS,
  );
  const weekdays = slots('d', [1, 2, 3, 4, 5, 6, 7], MIN_WEEKDAY_DEALS);
  const valid = hours.filter((h) => h.delta != null);
  // ночью цена часто выше, но покупателей мало — лот может не уйти. Лучший/худший час
  // выбираем только среди «живых» часов: сделок не меньше половины от среднего за час
  const avg =
    valid.reduce((s, h) => s + h.deals, 0) / Math.max(1, valid.length);
  const liquid = valid.filter((h) => h.deals >= avg * LIQUID_SHARE);
  const byDelta = [...liquid].sort((a, b) => b.delta! - a.delta!);
  const mskHour = (now.getUTCHours() + 3) % 24;
  return {
    deals,
    days,
    weeks,
    weekdaysReliable: weeks >= RELIABLE_WEEKS,
    hours,
    weekdays,
    bestHour: byDelta[0] ?? null,
    worstHour: byDelta.length > 1 ? byDelta[byDelta.length - 1] : null,
    now: hours.find((h) => h.key === mskHour && h.delta != null) ?? null,
  };
}
