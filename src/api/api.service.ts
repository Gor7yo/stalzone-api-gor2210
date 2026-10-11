import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import {
  IQueryParametersAuction,
  IQueryParametrsCharacter,
  IQueryParametrsClan,
} from './api.controller';
import { StalzoneOAuthService } from 'src/stalzone/oauth/stalzone-oauth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AuctionItemHistoryResponse,
  AuctionItemLotsResponse,
  IClanInfo,
  IClansList,
  IRegionData,
} from './api.constants';

type ClanRegions = 'ru' | 'eu' | 'na';

@Injectable()
export class ApiService {
  constructor(
    private readonly oAuthService: StalzoneOAuthService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  private access_token: string = '';
  private lastGetClansInfoTime: string = '';
  private lastClanListData: IRegionData = {};

  private async getToken() {
    const token = await this.oAuthService.getApplicationToken();
    return (this.access_token = token.access_token);
  }

  private getApiUrl() {
    return this.configService.getOrThrow<string>('STALZONE_API_URL');
  }

  async getAuctionItemLots(query: IQueryParametersAuction) {
    // return { total: 60 };
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const { data } = await firstValueFrom(
      this.httpService.get<AuctionItemLotsResponse>(
        `${apiUrl}/${query.region}/auction/${query.item}/lots`,
        {
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
          },
          params: {
            additional: query.additional ?? 'false',
            limit: query.limit ?? '20',
            offset: query.offset ?? '0',
            ...(query.sort ? { sort: query.sort } : {}),
            ...(query.order ? { order: query.order } : {}),
          },
        },
      ),
    );

    return data;
  }

  async getAuctionItemHistory(query: IQueryParametersAuction) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const { data } = await firstValueFrom(
      this.httpService.get<AuctionItemHistoryResponse>(
        `${apiUrl}/${query.region}/auction/${query.item}/history`,
        {
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
          },
          params: {
            additional: query.additional ?? 'false',
            limit: query.limit ?? '20',
            offset: query.offset ?? '0',
          },
        },
      ),
    );

    return data;
  }

  async getPlayerInfo(query: IQueryParametrsCharacter) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const { data } = await firstValueFrom(
      this.httpService.get(
        `${apiUrl}/${query.region}/character/by-name/${query.username}/profile`,
        {
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
          },
        },
      ),
    );

    return data;
  }

  async getClanInformation(query: IQueryParametrsClan) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const { data } = await firstValueFrom(
      this.httpService.get(
        `${apiUrl}/${query.region}/clan/${query.clanId}/info`,
        {
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
          },
        },
      ),
    );

    return data;
  }

  async getClanList(query: IQueryParametrsClan) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');
    const splitedRegions: string[] = query.region.split(',');

    console.log(splitedRegions);
    console.log(JSON.stringify(query))
    let resultData: IRegionData = {};

    if (splitedRegions.length > 1) {
      for (const region of splitedRegions) {
        const { data: curData } = await firstValueFrom(
          this.httpService.get<IClansList>(`${apiUrl}/${region}/clans`, {
            headers: {
              Authorization: `Bearer ${await this.getToken()}`,
            },
            params: {
              limit: query.limit ?? '20',
              offset: query.offset ?? '0',
            },
          }),
        );

        for (const clan of curData.data) clan.region = region;
        resultData[region] = curData;

        // if (!curData.data || curData.data.length === 0) continue;

        // const values = curData.data.map((clan) => ({
        //   id: clan.id,
        //   name: clan.name,
        //   region: region,
        //   tag: clan.tag,
        //   leader: clan.leader,
        // }));

        // await this.prisma.$transaction(
        //   values.map((clan) =>
        //     this.prisma.clan.upsert({
        //       where: { id: clan.id },
        //       update: {
        //         name: clan.name,
        //         region: clan.region,
        //         tag: clan.tag,
        //         leader: clan.leader,
        //       },
        //       create: {
        //         id: clan.id,
        //         name: clan.name,
        //         region: clan.region,
        //         tag: clan.tag,
        //         leader: clan.leader,
        //       },
        //     }),
        //   ),
        // );
      }

      this.lastClanListData = resultData;

      return resultData;
    }

    this.lastGetClansInfoTime = Date.now().toLocaleString('ru-RU');

    const { data: curData } = await firstValueFrom(
      this.httpService.get(`${apiUrl}/${query.region}/clans`, {
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
        },
        params: {
          limit: query.limit ?? '20',
          offset: query.offset ?? '0',
        },
      }),
    );

    resultData[query.region] = curData;

    return resultData;
  }

  async getEmissionStatus(region: string) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const { data } = await firstValueFrom(
      this.httpService.get(`${apiUrl}/${region}/emission`, {
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
        },
      }),
    );

    return data;
  }
}
