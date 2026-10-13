import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { EmissionQueryDto } from 'src/api/dto/queries.dto';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { SERIES_PERIODS, type SeriesPeriod } from './clan-metrics';
import { ClanMetricsService } from './clan-metrics.service';
import { ClansService } from './clans.service';

class ClanSearchQueryDto extends EmissionQueryDto {
  /** Название, тег или ник лидера (подстрока, регистр и раскладка не важны) */
  @Length(1, 64, { message: 'q: от 1 до 64 символов' })
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class ClanMetricsQueryDto extends EmissionQueryDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'id: некорректный ID клана' })
  id!: string;

  /** Период графика: неделя (по часам), месяц и всё время (по дням) */
  @IsOptional()
  @IsIn(SERIES_PERIODS, {
    message: `period: одно из ${SERIES_PERIODS.join(', ')}`,
  })
  period?: SeriesPeriod;
}

@Controller('api/clan')
class ClansController {
  constructor(
    private readonly clans: ClansService,
    private readonly metrics: ClanMetricsService,
  ) {}

  /** Поиск клана по своей копии списка EXBO (у EXBO поиска нет). */
  @Get('search')
  @Header('Cache-Control', 'public, max-age=30')
  search(@Query() query: ClanSearchQueryDto) {
    return this.clans.search(query.region, query.q, query.limit ?? 20);
  }

  /** Метрики клана: рост очков, бойцы, место в рейтинге, график, соседи. */
  @Get('metrics')
  @Header('Cache-Control', 'public, max-age=120')
  clanMetrics(@Query() query: ClanMetricsQueryDto) {
    return this.metrics.clan(query.region, query.id, query.period ?? 'week');
  }

  /** Сводка по кланам региона: топы роста, группировки, новые и распущенные, распределения. */
  @Get('analytics')
  @Header('Cache-Control', 'public, max-age=300')
  analytics(@Query() query: EmissionQueryDto) {
    return this.metrics.region(query.region);
  }
}

/** Кланы: синхронизация списка EXBO в БД (раз в час, с историей), поиск и метрики. */
@Module({
  imports: [StalzoneModule],
  controllers: [ClansController],
  providers: [ClansService, ClanMetricsService],
  exports: [ClansService],
})
export class ClansModule {}
