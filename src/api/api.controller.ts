import { Controller, Get, Header, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { MarketActivityService } from 'src/collector/market-activity.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { ApiService } from './api.service';
import {
  AuctionQueryDto,
  CharacterQueryDto,
  ClanInfoQueryDto,
  ClanListQueryDto,
  EmissionQueryDto,
  HistoryPeriodQueryDto,
} from './dto/queries.dto';
import { HistoryPeriodService } from './history-period.service';
import { MarketService } from './market.service';

/**
 * Cache-Control подсказывает браузеру/CDN, сколько можно не перезапрашивать ответ.
 * Значения чуть меньше серверного кеша (TTL в api.service.ts).
 */
@Controller('api')
export class ApiController {
  constructor(
    private readonly apiService: ApiService,
    private readonly stalcraft: StalcraftApiClient,
    private readonly historyPeriod: HistoryPeriodService,
    private readonly market: MarketService,
    private readonly activity: MarketActivityService,
  ) {}

  /**
   * Предметы, которые за 30 дней были на аукционе (RU и EU вместе) - рынок на сайте показывает только их.
   * ready=false - справочник ещё не обойдён, фильтровать рано.
   */
  @Get('market/active')
  @Header('Cache-Control', 'public, max-age=600')
  getActiveItems() {
    return this.activity.active();
  }

  /** Радар рынка: подорожало / подешевело / больше всего сделок за сутки (из БД сборщика). */
  @Get('market/radar')
  @Header('Cache-Control', 'public, max-age=120')
  getRadar(@Query() query: EmissionQueryDto) {
    return this.market.radar(query.region);
  }

  @Get('auction/lots')
  // коротко: в приложении есть кнопка «Обновить» (перезарядка 5 с после ответа)
  @Header('Cache-Control', 'public, max-age=3')
  getAuctionLots(@Query() query: AuctionQueryDto) {
    return this.apiService.getAuctionItemLots(query);
  }

  @Get('auction/history')
  @Header('Cache-Control', 'public, max-age=60')
  getAuctionHistory(@Query() query: AuctionQueryDto) {
    return this.apiService.getAuctionItemHistory(query);
  }

  /** История за день/неделю/месяц/год одним ответом (сервер сам листает страницы EXBO). */
  @Get('auction/history/period')
  @Header('Cache-Control', 'public, max-age=60')
  getAuctionHistoryPeriod(@Query() query: HistoryPeriodQueryDto) {
    return this.historyPeriod.get(query);
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
