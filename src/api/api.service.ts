import { Injectable } from '@nestjs/common';
import { ClansService, type ClanPage } from 'src/clans/clans.service';
import { AuctionStore } from 'src/collector/auction-store.service';
import { CollectorService } from 'src/collector/collector.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import {
  AuctionItemHistoryResponse,
  AuctionItemLotsResponse,
  IClansList,
  IRegionData,
} from './api.constants';
import {
  AuctionQueryDto,
  CharacterQueryDto,
  ClanInfoQueryDto,
  ClanListQueryDto,
  EmissionQueryDto,
  EXBO_PAGE_MAX,
} from './dto/queries.dto';

/** Сколько живёт ответ в кеше сервера (мс). Лоты меняются часто, кланы — редко. */
export const TTL = {
  lots: 5_000,
  history: 60_000,
  character: 60_000,
  clans: 5 * 60_000,
  emission: 10_000,
} as const;

/** Насколько старый снимок лотов из БД отдаём: открытый предмет / после «Обновить». */
const LOTS_MAX_AGE = { view: 60_000, fresh: 10_000 } as const;

@Injectable()
export class ApiService {
  constructor(
    private readonly stalcraft: StalcraftApiClient,
    private readonly collector: CollectorService,
    private readonly store: AuctionStore,
    private readonly clans: ClansService,
  ) {}

  /**
   * Лоты из снимка сборщика в БД; EXBO напрямую — только если БД ответить не может
   * (сортировка глубже 200 самых дешёвых на большом рынке, сборщик выключен).
   */
  async getAuctionItemLots(q: AuctionQueryDto) {
    // maxAge передают списки цен: такой предмет только добавляем в сборщик;
    // открытый предмет сборщик держит свежим чаще (ответ не ждёт записи)
    const list = q.maxAge !== undefined;
    void this.collector.touch(q.region, q.item, list ? 'list' : 'view');
    const maxAgeMs =
      q.fresh === 'true'
        ? LOTS_MAX_AGE.fresh
        : list
          ? q.maxAge! * 1000
          : LOTS_MAX_AGE.view;
    const stored = await this.store
      .lots(
        {
          region: q.region,
          item: q.item,
          sort: q.sort,
          order: q.order,
          limit: q.limit ?? 20,
          offset: q.offset ?? 0,
          additional: q.additional === 'true',
        },
        maxAgeMs,
      )
      .catch(() => null);
    if (stored) return stored;

    return this.stalcraft.get<AuctionItemLotsResponse>(
      [q.region, 'auction', q.item, 'lots'],
      {
        additional: q.additional ?? 'false',
        limit: Math.min(q.limit ?? 20, EXBO_PAGE_MAX),
        offset: q.offset ?? 0,
        sort: q.sort,
        order: q.order,
      },
      TTL.lots,
    );
  }

  getAuctionItemHistory(q: AuctionQueryDto) {
    return this.stalcraft.get<AuctionItemHistoryResponse>(
      [q.region, 'auction', q.item, 'history'],
      {
        additional: q.additional ?? 'false',
        limit: Math.min(q.limit ?? 20, EXBO_PAGE_MAX),
        offset: q.offset ?? 0,
      },
      TTL.history,
    );
  }

  getPlayerInfo(q: CharacterQueryDto) {
    return this.stalcraft.get<unknown>(
      [q.region, 'character', 'by-name', q.username, 'profile'],
      {},
      TTL.character,
    );
  }

  getClanInformation(q: ClanInfoQueryDto) {
    return this.stalcraft.get<unknown>(
      [q.region, 'clan', q.clanId, 'info'],
      {},
      TTL.clans,
    );
  }

  /**
   * Ответ в формате { [region]: { totalClans, data } } — так его ждёт фронтенд.
   * Рейтинг — из своей копии списка (ClansService, квоту EXBO не тратит);
   * пока регион не загружен целиком (сразу после деплоя) — напрямую из EXBO.
   */
  async getClanList(
    q: ClanListQueryDto,
  ): Promise<IRegionData | Record<string, ClanPage>> {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const own = await this.clans
      .list(q.region, offset, limit)
      .catch(() => null);
    if (own) return { [q.region]: own };

    const list = await this.stalcraft.get<IClansList>(
      [q.region, 'clans'],
      { limit, offset },
      TTL.clans,
    );
    return {
      [q.region]: {
        ...list,
        data: list.data.map((clan) => ({ ...clan, region: q.region })),
      },
    };
  }

  getEmissionStatus(q: EmissionQueryDto) {
    return this.stalcraft.get<unknown>(
      [q.region, 'emission'],
      {},
      TTL.emission,
    );
  }
}
