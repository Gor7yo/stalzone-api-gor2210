import { Module } from '@nestjs/common';
import { ClansModule } from 'src/clans/clans.module';
import { CollectorModule } from 'src/collector/collector.module';
import { PlayersModule } from 'src/players/players.module';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { HistoryPeriodService } from './history-period.service';
import { MarketService } from './market.service';

@Module({
  imports: [StalzoneModule, CollectorModule, ClansModule, PlayersModule],
  controllers: [ApiController],
  providers: [ApiService, HistoryPeriodService, MarketService],
})
export class ApiModule {}
