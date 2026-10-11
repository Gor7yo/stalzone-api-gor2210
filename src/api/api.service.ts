import { Injectable } from '@nestjs/common';
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
} from './dto/queries.dto';

/** Сколько живёт ответ в кеше сервера (мс). Лоты меняются часто, кланы — редко. */
export const TTL = {
  lots: 5_000,
  history: 60_000,
  character: 60_000,
  clans: 5 * 60_000,
  emission: 10_000,
} as const;

@Injectable()
export class ApiService {
  constructor(private readonly stalcraft: StalcraftApiClient) {}

  getAuctionItemLots(q: AuctionQueryDto) {
    return this.stalcraft.get<AuctionItemLotsResponse>(
      [q.region, 'auction', q.item, 'lots'],
      {
        additional: q.additional ?? 'false',
        limit: q.limit ?? 20,
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
        limit: q.limit ?? 20,
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

  /** Ответ в формате { [region]: { totalClans, data } } — так его ждёт фронтенд. */
  async getClanList(q: ClanListQueryDto): Promise<IRegionData> {
    const list = await this.stalcraft.get<IClansList>(
      [q.region, 'clans'],
      { limit: q.limit ?? 20, offset: q.offset ?? 0 },
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
