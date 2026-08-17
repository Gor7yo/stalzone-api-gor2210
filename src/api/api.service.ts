import { Body, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AuctionBody } from './api.controller';
import { ApiConstants } from './api.constants';
import { StalzoneOAuthService } from 'src/stalzone/oauth/stalzone-oauth.service';

export interface AuctionItemResponse {
  total: number;
  lots: {
    itemId: string;
    amount: number;
    startPrice: number;
    currentPrice: number;
    buyoutPrice: number;
    startTime: string;
  }[];
}

@Injectable()
export class ApiService {
  constructor(
    private readonly oAuthService: StalzoneOAuthService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private access_token?: string;

  private async getToken() {
    const token = await this.oAuthService.getApplicationToken();
    return (this.access_token = token.access_token);
  }

  async getAuctionItem(region: string, item: string, body?: AuctionBody) {
    const apiUrl = this.configService.getOrThrow<string>('STALZONE_API_URL');

    const params = new URLSearchParams({
      additional: body?.additional || 'true',
      limit: body?.limit || '1',
      offset: body?.offset || '20',
      order: body?.order || 'desc',
      sort: body?.sort || 'time_created',
    });

    const { data } = await firstValueFrom(
      this.httpService.get(`${apiUrl}/${region}/auction/${item}/lots`, {
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
        },
        params: { ...params },
      }),
    );

    return data;
  }
}
