import { Injectable } from '@nestjs/common';
import { ITEM_INFO } from 'src/collector/item-info';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';

const HOUR = 3_600_000;
/** Радар пересчитывается раз в 5 минут на регион. */
const TTL_MS = 5 * 60_000;
/** Меньше стольких сделок в одном из окон — изменение цены случайное, не показываем. */
const MIN_DEALS = 8;
/**
 * В списки «растут / падают» — только позиции, где изменение не шум: сделок больше,
 * а цена заметная (на дешёвых предметах пара сделок даёт ±50 %).
 */
const MOVER_MIN_DEALS = 12;
const MOVER_MIN_PRICE = 50_000;
/** Сколько строк в каждом списке. */
const TOP = 10;
/** Изменения больше этого в индексе обрезаем: один «сломанный» предмет не должен двигать весь рынок. */
const INDEX_CLIP = 0.5;

export interface RadarRow {
  itemId: string;
  /** русское название из справочника EXBO — чтобы фронт и поисковики видели имя до загрузки индекса */
  name?: string;
  /** -1 — без качества */
  quality: number;
  /** ступень заточки: 0 — +0, 1 — +1…4, 2 — +5…9, 3 — +10…14, 4 — +15 */
  tier: number;
  /** медиана за штуку за последние сутки и за предыдущие */
  price: number;
  prevPrice: number | null;
  /** изменение медианы, % (null — в прошлые сутки сделок мало) */
  change: number | null;
  deals: number;
  prevDeals: number;
  /** оборот за сутки, ₽ */
  turnover: number;
}

export interface Radar {
  region: string;
  updatedAt: string;
  /** изменение цен рынка за сутки, % (по обороту) и по скольким позициям посчитано */
  index: { change: number; groups: number };
  up: RadarRow[];
  down: RadarRow[];
  volume: RadarRow[];
}

interface Row {
  itemId: string;
  quality: number;
  tier: number;
  cur_n: number;
  prev_n: number;
  cur_med: number | null;
  prev_med: number | null;
  turnover: number;
}

/**
 * Радар рынка: что подорожало, подешевело и где больше всего сделок за сутки.
 * Сравниваем медиану последних 24 ч с предыдущими 24 ч внутри одной позиции —
 * предмет + качество + ступень заточки (иначе смесь лотов разного качества
 * давала бы ложные скачки цены). Всё из БД сборщика, квоту EXBO не тратит.
 */
@Injectable()
export class MarketService {
  private readonly cache = new TtlCache<Radar>(10);

  constructor(private readonly prisma: PrismaService) {}

  radar(region: string) {
    return this.cache.getOrLoad(region, TTL_MS, () => this.compute(region));
  }

  private async compute(region: string): Promise<Radar> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    const twoDaysAgo = new Date(now.getTime() - 48 * HOUR);

    const rows = await this.prisma.$queryRaw<Row[]>`
      WITH s AS (
        SELECT "itemId", "quality",
               CASE WHEN "upgrade" <= 0 THEN 0 WHEN "upgrade" <= 4 THEN 1
                    WHEN "upgrade" <= 9 THEN 2 WHEN "upgrade" <= 14 THEN 3 ELSE 4 END AS tier,
               "price"::float8 / GREATEST("amount", 1) AS unit,
               "price"::float8 AS price,
               "time" >= ${dayAgo} AS cur
        FROM "auction_sales"
        WHERE "region" = ${region} AND "time" >= ${twoDaysAgo} AND "price" > 0
      )
      SELECT "itemId", "quality", tier,
             count(*) FILTER (WHERE cur)::int AS cur_n,
             count(*) FILTER (WHERE NOT cur)::int AS prev_n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) FILTER (WHERE cur) AS cur_med,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) FILTER (WHERE NOT cur) AS prev_med,
             coalesce(sum(price) FILTER (WHERE cur), 0)::float8 AS turnover
      FROM s
      GROUP BY 1, 2, 3
      HAVING count(*) FILTER (WHERE cur) >= ${MIN_DEALS}`;

    const all: RadarRow[] = rows
      .filter((r) => r.cur_med != null)
      .map((r) => {
        const comparable =
          r.prev_n >= MIN_DEALS && r.prev_med != null && r.prev_med > 0;
        return {
          itemId: r.itemId,
          name: ITEM_INFO[r.itemId]?.[0],
          quality: r.quality,
          tier: r.tier,
          price: Math.round(r.cur_med!),
          prevPrice: comparable ? Math.round(r.prev_med!) : null,
          change: comparable
            ? round1(((r.cur_med! - r.prev_med!) / r.prev_med!) * 100)
            : null,
          deals: r.cur_n,
          prevDeals: r.prev_n,
          turnover: Math.round(r.turnover),
        };
      });

    const changed = all.filter((r) => r.change != null);
    const movers = changed.filter(
      (r) =>
        r.deals >= MOVER_MIN_DEALS &&
        r.prevDeals >= MOVER_MIN_DEALS &&
        r.price >= MOVER_MIN_PRICE,
    );
    // индекс: средневзвешенное по обороту изменение (обрезанное), чтобы дорогие ходовые позиции весили больше
    const weight = changed.reduce((s, r) => s + r.turnover, 0);
    const index = weight
      ? changed.reduce(
          (s, r) =>
            s +
            Math.max(-INDEX_CLIP, Math.min(INDEX_CLIP, r.change! / 100)) *
              r.turnover,
          0,
        ) / weight
      : 0;

    return {
      region,
      updatedAt: now.toISOString(),
      index: { change: round1(index * 100), groups: changed.length },
      up: movers
        .filter((r) => r.change! > 0)
        .sort((a, b) => b.change! - a.change!)
        .slice(0, TOP),
      down: movers
        .filter((r) => r.change! < 0)
        .sort((a, b) => a.change! - b.change!)
        .slice(0, TOP),
      volume: [...all].sort((a, b) => b.turnover - a.turnover).slice(0, TOP),
    };
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
