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

export interface AuctionItemLotsResponse {
  total: number;
  lots: {
    itemId: string;
    amount: number;
    startPrice: number;
    buyoutPrice: number;
    startTime: number;
    endTime: string;
    additional?: { [key: string]: any };
  }[];
}
export interface AuctionItemHistoryResponse {
  total: number;
  prices: {
    amount: string;
    price: number;
    time: number;
    additional?: { [key: string]: any };
  }[];
}

@Injectable()
export class ApiService {
  constructor(
    private readonly oAuthService: StalzoneOAuthService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private access_token: string = '';

  private async getToken() {
    const token = await this.oAuthService.getApplicationToken();
    return (this.access_token = token.access_token);
  }

  private getApiUrl() {
    return this.configService.getOrThrow<string>('STALZONE_API_URL');
  }

  async getAuctionItemLots(query: IQueryParametersAuction) {
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
            offset: query.offset ?? '20',
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

    const { data } = await firstValueFrom(
      this.httpService.get(`${apiUrl}/${query.region}/clans`, {
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
        },
        params: {
          limit: query.limit ?? '20',
          offset: query.offset ?? '20',
        },
      }),
    );

    return data;
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
