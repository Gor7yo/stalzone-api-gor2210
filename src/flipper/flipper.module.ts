import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { CollectorModule } from 'src/collector/collector.module';
import { FlipperService } from './flipper.service';
import { SaleTimingService } from './sale-timing.service';
import { SellAdvisorService } from './sell-advisor.service';
import { ShowcaseService } from './showcase.service';

class ShowcaseQueryDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;
}

/** Витрина флиппера - открыта всем: так бесплатная версия видит, что упускает без Pro. */
@Controller('api/flips')
class ShowcaseController {
  constructor(private readonly showcase: ShowcaseService) {}

  @Get('showcase')
  @Header('Cache-Control', 'public, max-age=300')
  get(@Query() query: ShowcaseQueryDto) {
    return this.showcase.get(query.region);
  }
}

/**
 * Флиппер: выгодные для перепродажи лоты по данным сборщика, и помощник продажи.
 * Лента и помощник - в TelegramModule (FlipsController, SellController): только для Pro.
 * Витрина (ShowcaseController) - для всех.
 */
@Module({
  imports: [CollectorModule],
  controllers: [ShowcaseController],
  providers: [
    FlipperService,
    SellAdvisorService,
    SaleTimingService,
    ShowcaseService,
  ],
  exports: [FlipperService, SellAdvisorService, SaleTimingService],
})
export class FlipperModule {}
