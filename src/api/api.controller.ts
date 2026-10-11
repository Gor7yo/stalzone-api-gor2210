import { Controller, Get, Header, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { ApiService } from './api.service';
import {
  AuctionQueryDto,
  CharacterQueryDto,
  ClanInfoQueryDto,
  ClanListQueryDto,
  EmissionQueryDto,
} from './dto/queries.dto';

/**
 * Cache-Control подсказывает браузеру/CDN, сколько можно не перезапрашивать ответ.
 * Значения чуть меньше серверного кеша (TTL в api.service.ts).
 */
@Controller('api')
export class ApiController {
  constructor(
    private readonly apiService: ApiService,
    private readonly stalcraft: StalcraftApiClient,
  ) {}

  @Get('auction/lots')
  @Header('Cache-Control', 'public, max-age=15')
  getAuctionLots(@Query() query: AuctionQueryDto) {
    return this.apiService.getAuctionItemLots(query);
  }

  @Get('auction/history')
  @Header('Cache-Control', 'public, max-age=60')
  getAuctionHistory(@Query() query: AuctionQueryDto) {
    return this.apiService.getAuctionItemHistory(query);
  }

  @Get('character/profile')
  @Header('Cache-Control', 'public, max-age=60')
  getPlayerInfo(@Query() query: CharacterQueryDto) {
    return this.apiService.getPlayerInfo(query);
  }

  @Get('clan/list')
  @Header('Cache-Control', 'public, max-age=300')
  getClanList(@Query() query: ClanListQueryDto) {
    return this.apiService.getClanList(query);
  }

  @Get('clan/info')
  @Header('Cache-Control', 'public, max-age=300')
  getClanInfo(@Query() query: ClanInfoQueryDto) {
    return this.apiService.getClanInformation(query);
  }

  @Get('emission')
  @Header('Cache-Control', 'public, max-age=5')
  getEmissionStatus(@Query() query: EmissionQueryDto) {
    return this.apiService.getEmissionStatus(query);
  }

  /** Для мониторинга/деплоя: жив ли сервер. */
  @Get('health')
  @SkipThrottle()
  @Header('Cache-Control', 'no-store')
  health() {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      cacheEntries: this.stalcraft.cacheSize,
    };
  }
}
