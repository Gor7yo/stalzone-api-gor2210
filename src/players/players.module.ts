import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { CharacterQueryDto } from 'src/api/dto/queries.dto';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { PlayersService } from './players.service';
import { PROGRESS_PERIODS, type ProgressPeriod } from './progress';

class ProgressQueryDto extends CharacterQueryDto {
  @IsOptional()
  @IsIn(PROGRESS_PERIODS, {
    message: `period: одно из ${PROGRESS_PERIODS.join(', ')}`,
  })
  period?: ProgressPeriod;
}

@Controller('api/character')
class PlayersController {
  constructor(private readonly players: PlayersService) {}

  /** Прирост статистики игрока за неделю / месяц (с первого открытия профиля на сайте). */
  @Get('progress')
  @Header('Cache-Control', 'public, max-age=120')
  progress(@Query() query: ProgressQueryDto) {
    return this.players.progress(
      query.region,
      query.username,
      query.period ?? 'week',
    );
  }
}

/** Прогресс игроков: ежедневные снимки статистики и прирост за период. */
@Module({
  imports: [StalzoneModule],
  controllers: [PlayersController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
