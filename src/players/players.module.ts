import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { IsIn, IsOptional, Matches } from 'class-validator';
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

class RecapQueryDto extends CharacterQueryDto {
  @Matches(/^20\d\d-(0[1-9]|1[0-2])$/, { message: 'month: ГГГГ-ММ' })
  month!: string;
}

@Controller('api/character')
class PlayersController {
  constructor(private readonly players: PlayersService) {}

  /** Карточка игрока: рейтинг 35–99, шесть характеристик, архетип, процентили против всех, кого видели. */
  @Get('rating')
  @Header('Cache-Control', 'public, max-age=300')
  rating(@Query() query: CharacterQueryDto) {
    return this.players.rating(query.region, query.username);
  }

  /** Итоги месяца: убийства, часы, лучший день, архетип. */
  @Get('recap')
  @Header('Cache-Control', 'public, max-age=600')
  recap(@Query() query: RecapQueryDto) {
    return this.players.recap(query.region, query.username, query.month);
  }

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
