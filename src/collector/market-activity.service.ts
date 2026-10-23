import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuctionItemHistoryResponse,
  AuctionItemLotsResponse,
} from 'src/api/api.constants';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { BudgetExhaustedError } from 'src/stalzone/api/token-budget';
import { ITEM_INFO } from './item-info';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Предмет «на рынке», если продавался за столько дней или выставлен сейчас. */
export const ACTIVE_DAYS = 30;
/** Каждый предмет перепроверяем раз в сутки (новые предметы и ушедшие с аукциона). */
const RECHECK_MS = DAY;
/** Ход - раз в минуту, за ход не больше стольких предметов; квота - только остаток (background). */
const TICK_MS = MIN;
const BATCH = 30;
const FIRST_TICK_MS = 2 * MIN;
const ACTIVE_TTL_MS = 10 * MIN;

export interface ActivityRow {
  lastSaleAt: Date | null;
  lotsTotal: number;
}

/** Торгуется: продажа за 30 дней или лоты на аукционе прямо сейчас. */
export function isActive(row: ActivityRow, now: number) {
  return (
    row.lotsTotal > 0 ||
    (row.lastSaleAt !== null &&
      now - row.lastSaleAt.getTime() <= ACTIVE_DAYS * DAY)
  );
}

/** Все предметы справочника, кроме мебели и оборудования убежища (их на аукционе нет). */
const CANDIDATES = Object.entries(ITEM_INFO)
  .filter(([, [, group]]) => group !== 'other')
  .map(([id]) => id);

/**
 * Какие предметы реально есть на аукционе: раз в сутки по всему справочнику спрашиваем EXBO
 * последнюю продажу (и, если её месяц не было, число лотов). Сборщик держит в БД только
 * нужные людям предметы - этот обход нужен, чтобы рынок на сайте не показывал «мусор»,
 * которого не бывает на аукционе. Квота - только остаток после сборщика и людей.
 */
@Injectable()
export class MarketActivityService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MarketActivityService.name);
  private readonly regions: Region[];
  private readonly enabled: boolean;
  private readonly cache = new TtlCache<{
    ready: boolean;
    items: string[];
  }>(1);
  private timer?: NodeJS.Timeout;
  private running = false;
  private announced = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    config: ConfigService,
  ) {
    const regions = String(config.get('COLLECTOR_REGIONS') ?? 'ru,eu')
      .split(',')
      .map((r) => r.trim())
      .filter((r): r is Region => (REGIONS as readonly string[]).includes(r));
    this.regions = regions.length ? regions : ['ru'];
    this.enabled =
      config.get<string>('MARKET_ACTIVITY') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.enabled) return;
    const tick = () => {
      void this.tick().finally(() => {
        this.timer = setTimeout(tick, TICK_MS);
      });
    };
    this.timer = setTimeout(tick, FIRST_TICK_MS);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  /**
   * Предметы на рынке (объединение регионов). ready=false, пока первый обход не прошёл весь
   * справочник хотя бы в одном регионе - тогда сайт не фильтрует, чтобы рынок не опустел.
   */
  active() {
    return this.cache.getOrLoad('all', ACTIVE_TTL_MS, async () => {
      const rows = await this.prisma.marketItemActivity.findMany({
        select: {
          itemId: true,
          region: true,
          lastSaleAt: true,
          lotsTotal: true,
        },
      });
      const now = Date.now();
      const checked = new Set(
        rows.filter((r) => r.region === this.regions[0]).map((r) => r.itemId),
      );
      const items = new Set(
        rows.filter((r) => isActive(r, now)).map((r) => r.itemId),
      );
      return {
        ready: CANDIDATES.every((id) => checked.has(id)),
        items: [...items].sort(),
      };
    });
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.marketItemActivity.findMany({
        select: { region: true, itemId: true, checkedAt: true },
      });
      const checkedAt = new Map(
        rows.map((r) => [`${r.region}:${r.itemId}`, r.checkedAt.getTime()]),
      );
      const due = Date.now() - RECHECK_MS;
      // сначала ни разу не проверенные (первый регион вперёд), потом самые старые
      const queue = this.regions
        .flatMap((region) =>
          CANDIDATES.map((itemId) => ({
            region,
            itemId,
            at: checkedAt.get(`${region}:${itemId}`) ?? -1,
          })),
        )
        .filter((x) => x.at < due)
        .sort((a, b) => a.at - b.at)
        .slice(0, BATCH);

      let done = 0;
      for (const x of queue) {
        try {
          await this.check(x.region, x.itemId);
          done++;
        } catch (e) {
          if (e instanceof BudgetExhaustedError) break;
          this.logger.warn(
            `Проверка ${x.region}:${x.itemId}: ${(e as Error).message}`,
          );
        }
      }
      if (done) this.cache.clear();
      if (!this.announced && done && queue.length < BATCH) {
        this.announced = true;
        this.logger.log('Активность рынка: обход справочника завершён');
      }
    } catch (e) {
      this.logger.warn(`Активность рынка: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async check(region: Region, itemId: string) {
    let lastSaleAt: Date | null = null;
    let lotsTotal = 0;
    try {
      const history = await this.stalcraft.get<AuctionItemHistoryResponse>(
        [region, 'auction', itemId, 'history'],
        { limit: 1, offset: 0 },
        0,
        'background',
      );
      const time = history.prices?.[0]?.time;
      lastSaleAt = time ? new Date(time) : null;
      // продажа за месяц уже есть - лоты не спрашиваем (экономим квоту)
      if (!lastSaleAt || !isActive({ lastSaleAt, lotsTotal: 0 }, Date.now())) {
        const lots = await this.stalcraft.get<AuctionItemLotsResponse>(
          [region, 'auction', itemId, 'lots'],
          { limit: 1, offset: 0 },
          0,
          'background',
        );
        lotsTotal = lots.total ?? 0;
      }
    } catch (e) {
      // предмета нет на аукционе этого региона - просто «не торгуется»
      if (!(e instanceof NotFoundException)) throw e;
    }
    const data = { lastSaleAt, lotsTotal, checkedAt: new Date() };
    await this.prisma.marketItemActivity.upsert({
      where: { region_itemId: { region, itemId } },
      create: { region, itemId, ...data },
      update: data,
    });
  }
}
