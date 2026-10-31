import { Injectable, Logger } from '@nestjs/common';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { ITEM_INFO } from 'src/collector/item-info';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  FEE,
  FLIP_WINDOW_DAYS,
  MIN_DEALS,
  MIN_PCT,
  MIN_PROFIT,
  type Confidence,
  type Flip,
} from './flip-filter';
import {
  flipBatch,
  flipTiming,
  type LadderStep,
  type SellMarket,
} from './sell-estimate';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WINDOW_DAYS = FLIP_WINDOW_DAYS;
/** Лоты из снимков старше этого не показываем: их, скорее всего, уже выкупили. */
const MAX_SNAPSHOT_AGE = 3 * 60 * MIN;
/**
 * Лента пересчитывается не чаще раза в 15 с на регион: сборщик ловит новые лоты
 * за секунды, минутный кеш съедал бы эту скорость.
 */
const TTL_MS = 15_000;
/** Медианы по сделкам за окно меняются медленно — их пересчитываем раз в 10 минут. */
const PRICES_TTL_MS = 10 * MIN;
/** Журнал флипов (витрина бесплатной версии) храним 3 дня, чистим раз в час. */
const LOG_KEEP_MS = 3 * DAY;
const LOG_CLEAN_EVERY_MS = 60 * MIN;
/** Сколько ключей уже записанных лотов помним, чтобы не слать их в БД каждые 15 с. */
const LOGGED_KEYS_MAX = 5_000;

export * from './flip-filter';

export interface FlipFeed {
  region: string;
  updatedAt: string;
  windowDays: number;
  flips: Flip[];
}

interface PriceRow {
  itemId: string;
  variant: string;
  quality: number;
  bucket: number;
  n: number;
  /** продано штук за окно — скорость рынка для времени продажи */
  units: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  last: Date;
}

interface LotRow {
  itemId: string;
  quality: number;
  upgrade: number;
  variant: string;
  amount: number;
  buyoutPrice: bigint;
  endTime: Date;
  seenAt: Date;
  firstSeenAt: Date;
}

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

/** Рынок позиции для оценки времени продажи: очередь без купленных лотов и скорость сделок за окно. */
const marketOf = (
  p: PriceRow,
  ladder: (LadderStep & { lot: LotRow })[] = [],
  bought: LotRow[],
): SellMarket => ({
  ladder: ladder.filter((s) => !bought.includes(s.lot)),
  ratePerHour: p.units / (WINDOW_DAYS * 24),
  sales: {
    p10: p.p10,
    p25: p.p25,
    median: p.median,
    p75: p.p75,
    p90: p.p90,
  },
});

const iso = (d: Date) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Флиппер: лоты, которые выгодно выкупить и перепродать.
 *
 * Цена продажи — медиана сделок за FLIP_WINDOW_DAYS дня с тем же качеством, заточкой и
 * вариантом (ключевая характеристика модуля); если таких сделок мало — по ступени заточки
 * (вариант всегда точный: модули с разной характеристикой стоят несравнимо).
 * Прибыль = цена × количество × 0,95 − выкуп.
 * Всё считается по нашей БД (сборщик), EXBO не трогаем.
 */
@Injectable()
export class FlipperService {
  private readonly logger = new Logger(FlipperService.name);
  private readonly cache = new TtlCache<FlipFeed>(10);
  private readonly pricesCache = new TtlCache<Map<string, PriceRow>>(10);
  /** регион → ключи лотов, уже записанных в журнал (после перезапуска повтор отсекает БД) */
  private readonly logged = new Map<string, Set<string>>();
  private loggedCleanAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  feed(region: string): Promise<FlipFeed> {
    return this.cache.getOrLoad(region, TTL_MS, () => this.compute(region));
  }

  /** Сборщик только что освежил лоты региона - следующий запрос посчитает ленту заново. */
  forget(region: string) {
    this.cache.delete(region);
  }

  /** Медианы за штуку: по точной заточке (bucket = 0–15) и по ступени (bucket = 100 + ступень). */
  private prices(region: string) {
    return this.pricesCache.getOrLoad(region, PRICES_TTL_MS, async () => {
      const since = new Date(Date.now() - WINDOW_DAYS * DAY);
      const rows = await this.prisma.$queryRaw<PriceRow[]>`
      WITH s AS (
        SELECT "itemId", "variant", "quality", "upgrade", "time",
               CASE WHEN "upgrade" <= 0 THEN 0 WHEN "upgrade" <= 4 THEN 1
                    WHEN "upgrade" <= 9 THEN 2 WHEN "upgrade" <= 14 THEN 3 ELSE 4 END AS tier,
               GREATEST("amount", 1) AS amount,
               "price"::float8 / GREATEST("amount", 1) AS unit
        FROM "auction_sales"
        WHERE "region" = ${region} AND "time" >= ${since} AND "price" > 0
      )
      SELECT "itemId", "variant", "quality",
             CASE WHEN GROUPING("upgrade") = 0 THEN "upgrade" ELSE 100 + tier END AS bucket,
             count(*)::int AS n,
             sum(amount)::float8 AS units,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS median,
             percentile_cont(0.1) WITHIN GROUP (ORDER BY unit) AS p10,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY unit) AS p25,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY unit) AS p75,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY unit) AS p90,
             max("time") AS last
      FROM s
      GROUP BY GROUPING SETS (
        ("itemId", "variant", "quality", "upgrade"),
        ("itemId", "variant", "quality", tier)
      )
      HAVING count(*) >= ${MIN_DEALS}`;
      return new Map(
        rows.map((p) => [
          `${p.itemId}|${p.variant}|${p.quality}|${p.bucket}`,
          p,
        ]),
      );
    });
  }

  private async compute(region: string): Promise<FlipFeed> {
    const now = new Date();
    const freshSince = new Date(now.getTime() - MAX_SNAPSHOT_AGE);
    const byKey = await this.prices(region);

    // лоты с выкупом из последнего снимка сборщика и быстрых проверок новых лотов
    const lots = await this.prisma.$queryRaw<LotRow[]>`
      SELECT l."itemId", l."quality", l."upgrade", l."variant", l."amount", l."buyoutPrice",
             l."endTime", l."lastSeenAt" AS "seenAt", l."firstSeenAt"
      FROM "auction_lots" l
      JOIN "tracked_items" t ON t."region" = l."region" AND t."itemId" = l."itemId"
      WHERE l."region" = ${region} AND l."goneAt" IS NULL AND l."buyoutPrice" > 0
        AND l."lastSeenAt" >= t."lastLotsAt" AND t."lastLotsAt" >= ${freshSince}
        AND l."endTime" > ${now}`;

    // очереди конкурентов для времени продажи: по точной заточке и по ступени (как цена)
    const ladders = new Map<string, (LadderStep & { lot: LotRow })[]>();
    const addTo = (key: string, lot: LotRow) => {
      const amount = Math.max(1, lot.amount);
      const step = { unit: Number(lot.buyoutPrice) / amount, amount, lot };
      const list = ladders.get(key);
      if (list) list.push(step);
      else ladders.set(key, [step]);
    };
    for (const lot of lots) {
      const base = `${lot.itemId}|${lot.variant}|${lot.quality}`;
      addTo(`${base}|${lot.upgrade}`, lot);
      addTo(`${base}|${100 + tierOf(lot.upgrade)}`, lot);
    }
    for (const list of ladders.values()) list.sort((a, b) => a.unit - b.unit);

    const flips: Flip[] = [];
    // флипы одной позиции (предмет, вариант, качество, заточка) — для пакетного флипа
    const positions = new Map<
      string,
      { p: PriceRow; ladderKey: string; items: { flip: Flip; lot: LotRow }[] }
    >();
    for (const lot of lots) {
      const base = `${lot.itemId}|${lot.variant}|${lot.quality}`;
      const exactKey = `${base}|${lot.upgrade}`;
      const tierKey = `${base}|${100 + tierOf(lot.upgrade)}`;
      const exact = byKey.get(exactKey);
      const tier = byKey.get(tierKey);
      const basis: Flip['basis'] = exact ? 'exact' : 'tier';
      const p = exact ?? tier;
      if (!p) continue;

      const amount = Math.max(1, lot.amount);
      const buyout = Number(lot.buyoutPrice);
      const profit = Math.round(p.median * amount * (1 - FEE) - buyout);
      const pct = (profit / buyout) * 100;
      if (profit < MIN_PROFIT || pct < MIN_PCT) continue;

      // после выкупа этот лот уходит с рынка — в очереди остаются остальные
      const ladderKey = exact ? exactKey : tierKey;
      const timing = flipTiming(
        marketOf(p, ladders.get(ladderKey), [lot]),
        amount,
        profit,
      );

      // название и группа — из справочника EXBO по всем предметам (не только стартовый список)
      const info = ITEM_INFO[lot.itemId];
      const flip: Flip = {
        key: `${lot.itemId}|${lot.quality}|${lot.upgrade}|${amount}|${buyout}|${lot.endTime.getTime()}${lot.variant ? `|${lot.variant}` : ''}`,
        itemId: lot.itemId,
        name: info?.[0],
        group: info?.[1],
        quality: lot.quality,
        upgrade: lot.upgrade,
        ...(lot.variant && { variant: lot.variant }),
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
        sellHours: timing.hours,
        profitPerHour: timing.perHour,
        seenAt: iso(lot.seenAt),
        firstSeenAt: iso(lot.firstSeenAt),
        endTime: iso(lot.endTime),
        lastSale: iso(p.last),
      };
      flips.push(flip);
      const position = positions.get(exactKey);
      if (position) position.items.push({ flip, lot });
      else positions.set(exactKey, { p, ladderKey, items: [{ flip, lot }] });
    }

    // пакет: несколько выгодных лотов одной позиции — сколько скупить, чтобы всё ушло за сутки
    for (const { p, ladderKey, items } of positions.values()) {
      if (items.length < 2) continue;
      const batch = flipBatch(
        marketOf(
          p,
          ladders.get(ladderKey),
          items.map((i) => i.lot),
        ),
        items.map((i) => i.flip),
      );
      if (batch) for (const i of items) i.flip.batch = batch;
    }
    flips.sort((a, b) => b.profit - a.profit);
    // в журнал - фоном: лента от него не зависит
    void this.log(region, flips).catch((e) =>
      this.logger.warn(`Журнал флипов: ${(e as Error).message}`),
    );

    return {
      region,
      updatedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      flips,
    };
  }

  /** Новые лоты ленты - в журнал флипов (витрина бесплатной версии); старше 3 дней - прочь. */
  private async log(region: string, flips: Flip[]) {
    const seen = this.logged.get(region) ?? new Set<string>();
    this.logged.set(region, seen);
    const fresh = flips.filter((f) => !seen.has(f.key));
    if (fresh.length) {
      await this.prisma.flipLog.createMany({
        data: fresh.map((f) => ({
          region,
          key: f.key,
          itemId: f.itemId,
          quality: f.quality,
          upgrade: f.upgrade,
          variant: f.variant ?? '',
          amount: f.amount,
          buyout: BigInt(f.buyout),
          sellUnit: BigInt(f.sellUnit),
          profit: BigInt(f.profit),
          pct: f.pct,
          confidence: f.confidence,
          deals: f.deals,
          endTime: new Date(f.endTime),
          seenAt: new Date(f.firstSeenAt ?? f.seenAt),
        })),
        skipDuplicates: true,
      });
      // память не копим: забытый ключ при следующей записи отсечёт первичный ключ в БД
      if (seen.size + fresh.length > LOGGED_KEYS_MAX) seen.clear();
      for (const f of fresh) seen.add(f.key);
    }
    if (Date.now() - this.loggedCleanAt > LOG_CLEAN_EVERY_MS) {
      this.loggedCleanAt = Date.now();
      await this.prisma.flipLog.deleteMany({
        where: { seenAt: { lt: new Date(Date.now() - LOG_KEEP_MS) } },
      });
    }
  }
}
