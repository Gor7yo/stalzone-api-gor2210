import { Module } from '@nestjs/common';
import { CollectorModule } from 'src/collector/collector.module';
import { FlipperService } from './flipper.service';
import { SellAdvisorService } from './sell-advisor.service';

/**
 * Флиппер: выгодные для перепродажи лоты по данным сборщика, и помощник продажи.
 * Эндпоинты — в TelegramModule (FlipsController, SellController): только для Pro.
 */
@Module({
  imports: [CollectorModule],
  providers: [FlipperService, SellAdvisorService],
  exports: [FlipperService, SellAdvisorService],
})
export class FlipperModule {}
