import { Injectable, Logger } from '@nestjs/common';
import type {
  AuctionItemHistoryResponse,
  AuctionItemLotsResponse,
} from 'src/api/api.constants';
import type { LOT_SORTS } from 'src/api/dto/queries.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import type { AuctionLot, TrackedItem } from 'generated/prisma/client';
import { CollectorService, lotPagesOf, PAGE } from './collector.service';

type Lot = AuctionItemLotsResponse['lots'][number];
type Sale = AuctionItemHistoryResponse['prices'][number];

/** Больше стольких сделок за период не отдаём — равномерная выборка. */
const MAX_POINTS = 3_000;
/** При выборке самые свежие сделки отдаём все (правый край графика, сделки за сутки). */
const RECENT_POINTS = 600;

export interface LotsQuery {
  region: string;
  item: string;
  sort?: (typeof LOT_SORTS)[number];
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
  additional: boolean;
}

/** Как у EXBO: «2026-10-11T17:24:37Z», без миллисекунд (на этом формате держатся ключи лотов в алертах). */
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** additional в формате EXBO; ключевая характеристика модуля - как у EXBO, атрибутом type 2. */
const additionalOf = (quality: number, upgrade: number, variant: string) => ({
  ...(quality >= 0 && { qlt: quality }),
  ...(upgrade > 0 && { ptn: upgrade }),
  ...(variant && { attributes: [{ type: 2, definitionId: variant }] }),
});

const SORT_KEY: Record<(typeof LOT_SORTS)[number], (l: AuctionLot) => number> =
  {
    buyout_price: (l) => Number(l.buyoutPrice),
    current_price: (l) => Number(l.currentPrice ?? l.startPrice),
    time_created: (l) => l.startTime.getTime(),
    time_left: (l) => l.endTime.getTime(),
  };

/**
 * Чтение аукциона из нашей БД (её наполняет CollectorService) вместо EXBO.
 * Если снимок старше, чем допускает запрос, — сначала свежий снимок через сборщик
 * (один запрос к EXBO на предмет, сколько бы людей ни смотрели).
 * null — БД ответить не может, вызывающий идёт в EXBO напрямую.
 */
@Injectable()
export class AuctionStore {
  private readonly logger = new Logger(AuctionStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
  ) {}

  private tracked(region: string, itemId: string) {
    return this.prisma.trackedItem.findUnique({
      where: { region_itemId: { region, itemId } },
    });
  }

  private isFresh(at: Date | null | undefined, maxAgeMs: number) {
    return !!at && Date.now() - at.getTime() <= maxAgeMs;
  }

  /** Последний снимок лотов (по возрастанию выкупа), при необходимости обновлённый. */
  private async snapshot(region: string, itemId: string, maxAgeMs: number) {
    if (!this.collector.enabled) return null;
    let item: TrackedItem | null = await this.tracked(region, itemId);
    if (!this.isFresh(item?.lastLotsAt, maxAgeMs)) {
      try {
        await this.collector.refreshLots(region, itemId);
        item = await this.tracked(region, itemId);
      } catch (error) {
        // EXBO не ответил — отдадим что есть, если есть
        this.logger.debug(`снимок ${region}:${itemId}: ${String(error)}`);
      }
    }
    if (!item?.lastLotsAt) return null;
    const lots = await this.prisma.auctionLot.findMany({
      where: {
        region,
        itemId,
        goneAt: null,
        lastSeenAt: { gte: item.lastLotsAt },
        endTime: { gt: new Date() },
      },
      orderBy: [{ buyoutPrice: 'asc' }, { startTime: 'asc' }],
    });
    // в снимке все лоты аукциона или только самые дешёвые (если лотов больше lotPagesOf страниц)
    const complete = (item.lotsTotal ?? 0) <= lotPagesOf(itemId) * PAGE;
    return {
      lots,
      complete,
      total: complete ? lots.length : (item.lotsTotal ?? lots.length),
    };
  }

  private toLot(l: AuctionLot, additional: boolean): Lot {
    return {
      itemId: l.itemId,
      amount: l.amount,
      startPrice: Number(l.startPrice),
      ...(l.currentPrice !== null && { currentPrice: Number(l.currentPrice) }),
      buyoutPrice: Number(l.buyoutPrice),
      startTime: iso(l.startTime),
      endTime: iso(l.endTime),
      additional: additional
        ? {
            ...additionalOf(l.quality, l.upgrade, l.variant),
            // все три атрибута модуля с quality и statsRandom, как у EXBO
            ...(Array.isArray(l.attributes) && { attributes: l.attributes }),
          }
        : {},
    };
  }

  /**
   * Страница лотов в формате EXBO. Полный снимок отвечает на любую сортировку;
   * неполный (на аукционе > 200 лотов) — только «дешевле» в пределах снимка.
   */
  async lots(
    q: LotsQuery,
    maxAgeMs: number,
  ): Promise<AuctionItemLotsResponse | null> {
    if (!q.sort) return null;
    const cheapFirst = q.sort === 'buyout_price' && q.order !== 'desc';
    const snap = await this.snapshot(q.region, q.item, maxAgeMs);
    if (!snap || (!snap.complete && !cheapFirst)) return null;
    if (!snap.complete && q.offset >= snap.lots.length) return null;

    let lots = snap.lots;
    if (!cheapFirst) {
      const key = SORT_KEY[q.sort];
      const dir = q.order === 'desc' ? -1 : 1;
      lots = [...lots].sort(
        (a, b) =>
          (key(a) - key(b)) * dir ||
          a.startTime.getTime() - b.startTime.getTime(),
      );
    }
    return {
      total: snap.total,
      lots: lots
        .slice(q.offset, q.offset + q.limit)
        .map((l) => this.toLot(l, q.additional)),
    };
  }

  /** Самые дешёвые по выкупу лоты для алертов; complete=false — за снимком есть ещё лоты. */
  async cheapestLots(region: string, itemId: string, maxAgeMs: number) {
    const snap = await this.snapshot(region, itemId, maxAgeMs);
    if (!snap) return null;
    return {
      complete: snap.complete,
      lots: snap.lots.map((l) => this.toLot(l, true)),
    };
  }

  /**
   * Продажи с момента since, свежие первыми. null — история в БД с since ещё неполная.
   * Сделок больше MAX_POINTS — свежие целиком + равномерная выборка остальных.
   */
  async sales(
    region: string,
    itemId: string,
    since: Date,
    maxAgeMs: number,
  ): Promise<{ total: number; sampled: boolean; prices: Sale[] } | null> {
    if (!this.collector.enabled) return null;
    const item = await this.tracked(region, itemId);
    if (!item?.historyFrom || item.historyFrom > since) return null;
    if (!this.isFresh(item.lastSalesAt, maxAgeMs)) {
      await this.collector
        .refreshSales(region, itemId)
        .catch((error) =>
          this.logger.debug(`продажи ${region}:${itemId}: ${String(error)}`),
        );
    }

    const filter = { region, itemId, time: { gte: since } };
    const total = await this.prisma.auctionSale.count({ where: filter });
    type Row = {
      time: Date;
      price: bigint;
      amount: number;
      quality: number;
      upgrade: number;
      variant: string;
    };
    let rows: Row[];
    if (total <= MAX_POINTS) {
      rows = await this.prisma.auctionSale.findMany({
        where: filter,
        orderBy: { time: 'desc' },
        select: {
          time: true,
          price: true,
          amount: true,
          quality: true,
          upgrade: true,
          variant: true,
        },
      });
    } else {
      const step = Math.ceil(
        (total - RECENT_POINTS) / (MAX_POINTS - RECENT_POINTS),
      );
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT "time", "price", "amount", "quality", "upgrade", "variant" FROM (
          SELECT "time", "price", "amount", "quality", "upgrade", "variant",
                 row_number() OVER (ORDER BY "time" DESC) AS rn
          FROM "auction_sales"
          WHERE "region" = ${region} AND "itemId" = ${itemId} AND "time" >= ${since}
        ) t
        WHERE rn <= ${RECENT_POINTS} OR rn % ${step} = 0
        ORDER BY "time" DESC`;
    }
    return {
      total,
      sampled: total > MAX_POINTS,
      prices: rows.map((r) => ({
        amount: Number(r.amount),
        price: Number(r.price),
        time: iso(new Date(r.time)),
        additional: additionalOf(r.quality, r.upgrade, r.variant),
      })),
    };
  }
}
