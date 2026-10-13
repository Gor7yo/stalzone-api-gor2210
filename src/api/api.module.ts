import { Module } from '@nestjs/common';
import { CollectorModule } from 'src/collector/collector.module';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { HistoryPeriodService } from './history-period.service';
import { MarketService } from './market.service';

@Module({
  imports: [StalzoneModule, CollectorModule],
  controllers: [ApiController],
  providers: [ApiService, HistoryPeriodService, MarketService],
})
export class ApiModule {}
