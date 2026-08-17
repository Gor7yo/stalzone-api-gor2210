import { Body, Controller, Get, Query } from '@nestjs/common';
import { ApiService, AuctionItemResponse } from './api.service';

export interface IQueryParametersStrict {
  region: string;
  item: string;
  additional?: string;
  limit?: number;
  offset?: number;
  order?: 'ASC' | 'DESC';
  sort?: string;
}

@Controller('api')
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  @Get('auction/item')
  async getAuctionItem(
    @Query('region') region: string,
    @Query('item') item: string,
    @Query('additional') additional?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('order') order?: string,
    @Query('sort') sort?: string,
  ) {
    const data = await this.apiService.getAuctionItem(region, item);
    return data;
  }

  @Get('auction/history')
  async getAuctionHistory(
    @Query('region') region: string,
    @Query('item') item: string,
    @Query('additional') additional?: string,
    @Query('limit') limit?: string,
  ) {}
}
