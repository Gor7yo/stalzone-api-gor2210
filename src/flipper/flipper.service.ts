import { Injectable } from '@nestjs/common';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { SEED_ITEMS } from 'src/collector/seed-items';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  FEE,
  MIN_DEALS,
  MIN_PCT,
  MIN_PROFIT,
  type Confidence,
  type Flip,
} from './flip-filter';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Окно сделок для оценки цены продажи. */
const WINDOW_DAYS = 7;
/** Лоты из снимков старше этого не показываем: их, скорее всего, уже выкупили. */
const MAX_SNAPSHOT_AGE = 3 * 60 * MIN;
/**
 * Лента пересчитывается не чаще раза в 15 с на регион: сборщик ловит новые лоты
 * за секунды, минутный кеш съедал бы эту скорость.
 */
const TTL_MS = 15_000;
/** Медианы по сделкам за неделю меняются медленно — их пересчитываем раз в 10 минут. */
const PRICES_TTL_MS = 10 * MIN;

export * from './flip-filter';

export interface FlipFeed {
  region: string;
  updatedAt: string;
  windowDays: number;
  flips: Flip[];
}

interface PriceRow {
  itemId: string;
  quality: number;
  bucket: number;
  n: number;
  median: number;
  p25: number;
  p75: number;
  last: Date;
}

interface LotRow {
  itemId: string;
  quality: number;
  upgrade: number;
  amount: number;
  buyoutPrice: bigint;
  endTime: Date;
  seenAt: Date;
}

const SEED_BY_ID = new Map(SEED_ITEMS.map((s) => [s.id, s]));

/** Ступени заточки — как на фронте (TIERS): +0, +1–4, +5–9, +10–14, +15. */
const tierOf = (u: number) =>
  u <= 0 ? 0 : u <= 4 ? 1 : u <= 9 ? 2 : u <= 14 ? 3 : 4;

/** Надёжность оценки: сколько сделок и насколько разбросаны их цены. */
function confidenceOf(p: PriceRow, basis: Flip['basis']): Confidence {
  const spread = p.p25 > 0 ? p.p75 / p.p25 : Infinity;
  if (basis === 'exact' && p.n >= 15 && spread <= 1.6) return 'high';
  if (p.n >= 7 && spread <= 2.5) return 'medium';
  return 'low';
}

const iso = (d: Date) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Флиппер: лоты, которые выгодно выкупить и перепродать.
 *
 * Цена продажи — медиана сделок за 7 дней с тем же качеством и заточкой;
 * если таких сделок мало — по ступени заточки. Прибыль = цена × количество × 0,95 − выкуп.
 * Всё считается по нашей БД (сборщик), EXBO не трогаем.
 */
@Injectable()
export class FlipperService {
  private readonly cache = new TtlCache<FlipFeed>(10);
  private readonly pricesCache = new TtlCache<Map<string, PriceRow>>(10);

  constructor(private readonly prisma: PrismaService) {}

  feed(region: string): Promise<FlipFeed> {
    return this.cache.getOrLoad(region, TTL_MS, () => this.compute(region));
  }

  /** Медианы за штуку: по точной заточке (bucket = 0–15) и по ступени (bucket = 100 + ступень). */
  private prices(region: string) {
    return this.pricesCache.getOrLoad(region, PRICES_TTL_MS, async () => {
      const since = new Date(Date.now() - WINDOW_DAYS * DAY);
      const rows = await this.prisma.$queryRaw<PriceRow[]>`
      WITH s AS (
        SELECT "itemId", "quality", "upgrade", "time",
               CASE WHEN "upgrade" <= 0 THEN 0 WHEN "upgrade" <= 4 THEN 1
                    WHEN "upgrade" <= 9 THEN 2 WHEN "upgrade" <= 14 THEN 3 ELSE 4 END AS tier,
               "price"::float8 / GREATEST("amount", 1) AS unit
        FROM "auction_sales"
        WHERE "region" = ${region} AND "time" >= ${since} AND "price" > 0
      )
      SELECT "itemId", "quality",
             CASE WHEN GROUPING("upgrade") = 0 THEN "upgrade" ELSE 100 + tier END AS bucket,
             count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS median,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY unit) AS p25,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY unit) AS p75,
             max("time") AS last
      FROM s
      GROUP BY GROUPING SETS (("itemId", "quality", "upgrade"), ("itemId", "quality", tier))
      HAVING count(*) >= ${MIN_DEALS}`;
      return new Map(
        rows.map((p) => [`${p.itemId}|${p.quality}|${p.bucket}`, p]),
      );
    });
  }

  private async compute(region: string): Promise<FlipFeed> {
    const now = new Date();
    const freshSince = new Date(now.getTime() - MAX_SNAPSHOT_AGE);
    const byKey = await this.prices(region);

    // лоты с выкупом из последнего снимка сборщика и быстрых проверок новых лотов
    const lots = await this.prisma.$queryRaw<LotRow[]>`
      SELECT l."itemId", l."quality", l."upgrade", l."amount", l."buyoutPrice",
             l."endTime", l."lastSeenAt" AS "seenAt"
      FROM "auction_lots" l
      JOIN "tracked_items" t ON t."region" = l."region" AND t."itemId" = l."itemId"
      WHERE l."region" = ${region} AND l."goneAt" IS NULL AND l."buyoutPrice" > 0
        AND l."lastSeenAt" >= t."lastLotsAt" AND t."lastLotsAt" >= ${freshSince}
        AND l."endTime" > ${now}`;

    const flips: Flip[] = [];
    for (const lot of lots) {
      const exact = byKey.get(`${lot.itemId}|${lot.quality}|${lot.upgrade}`);
      const tier = byKey.get(
        `${lot.itemId}|${lot.quality}|${100 + tierOf(lot.upgrade)}`,
      );
      const basis: Flip['basis'] = exact ? 'exact' : 'tier';
      const p = exact ?? tier;
      if (!p) continue;

      const amount = Math.max(1, lot.amount);
      const buyout = Number(lot.buyoutPrice);
      const profit = Math.round(p.median * amount * (1 - FEE) - buyout);
      const pct = (profit / buyout) * 100;
      if (profit < MIN_PROFIT || pct < MIN_PCT) continue;

      const seed = SEED_BY_ID.get(lot.itemId);
      flips.push({
        key: `${lot.itemId}|${lot.quality}|${lot.upgrade}|${amount}|${buyout}|${lot.endTime.getTime()}`,
        itemId: lot.itemId,
        name: seed?.name,
        group: seed?.group,
        quality: lot.quality,
        upgrade: lot.upgrade,
        amount,
        buyout,
        unitPrice: Math.round(buyout / amount),
        sellUnit: Math.round(p.median),
        profit,
        pct: Math.round(pct * 10) / 10,
        profitLow: Math.round(p.p25 * amount * (1 - FEE) - buyout),
        basis,
        deals: p.n,
        perDay: Math.round((p.n / WINDOW_DAYS) * 10) / 10,
        confidence: confidenceOf(p, basis),
        seenAt: iso(lot.seenAt),
        endTime: iso(lot.endTime),
        lastSale: iso(p.last),
      });
    }
    flips.sort((a, b) => b.profit - a.profit);

    return {
      region,
      updatedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      flips,
    };
  }
}
