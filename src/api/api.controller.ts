import { Controller, Get, Query } from '@nestjs/common';
import { ApiService } from './api.service';

export interface IQueryParametersAuction {
  region: string;
  item: string;
  additional: string;
  limit: string;
  offset: string;
  sort?: 'time_created' | 'time_left' | 'current_price' | 'buyout_price';
  order?: 'asc' | 'desc';
}

export interface IQueryParametrsCharacter {
  region: string;
  username: string;
}

export interface IQueryParametrsClan {
  region: string;
  clanId: string;
  offset: string;
  limit: string;
}

@Controller('api')
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  // аукцион

  @Get('auction/lots')
  async getAuctionItem(@Query() query: IQueryParametersAuction) {
    const data = await this.apiService.getAuctionItemLots(query);
    return data;
  }

  @Get('auction/history')
  async getAuctionHistory(@Query() query: IQueryParametersAuction) {
    const data = await this.apiService.getAuctionItemHistory(query);
    return data;
  }

  // персонаж

  @Get('character/profile')
  async getPlayerInfo(@Query() query: IQueryParametrsCharacter) {
    const data = await this.apiService.getPlayerInfo(query);
    return data;
  }

  // кланы

  @Get('clan/list')
  async getClanList(@Query() query: IQueryParametrsClan) {
    const data = await this.apiService.getClanList(query);
    return data;
  }

  @Get('clan/info')
  async getClanInfo(@Query() query: IQueryParametrsClan) {
    const data = await this.apiService.getClanInformation(query);
    return data;
  }

  // выбросы

  @Get('emission')
  async getEmissionStatus(@Query('region') region: string) {
    const data = await this.apiService.getEmissionStatus(region);
    return data;
  }
}
