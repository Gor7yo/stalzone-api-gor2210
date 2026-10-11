import { Controller, Get, Header, Module, UseGuards } from '@nestjs/common';
import { ServerGuard } from 'src/common/guards/server.guard';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { AuctionStore } from './auction-store.service';
import { CollectorService } from './collector.service';

@Controller('api/collector')
class CollectorController {
  constructor(private readonly collector: CollectorService) {}

  /** Здоровье сборщика: расход квоты EXBO, сколько предметов просрочено, сколько данных накоплено. */
  @Get('status')
  @UseGuards(ServerGuard)
  @Header('Cache-Control', 'no-store')
  status() {
    return this.collector.status();
  }
}

/** Сборщик аукциона: свои лоты и история продаж в БД (см. CollectorService). */
@Module({
  imports: [StalzoneModule],
  controllers: [CollectorController],
  providers: [CollectorService, AuctionStore],
  exports: [CollectorService, AuctionStore],
})
export class CollectorModule {}
