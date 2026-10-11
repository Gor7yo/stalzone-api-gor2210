import { Module } from '@nestjs/common';
import { FlipperService } from './flipper.service';

/**
 * Флиппер: выгодные для перепродажи лоты по данным сборщика.
 * Эндпоинт ленты — в TelegramModule (FlipsController): лента только для Pro.
 */
@Module({
  providers: [FlipperService],
  exports: [FlipperService],
})
export class FlipperModule {}
