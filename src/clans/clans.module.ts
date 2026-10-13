import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Length, Max, Min } from 'class-validator';
import { EmissionQueryDto } from 'src/api/dto/queries.dto';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
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

@Controller('api/clan')
class ClansController {
  constructor(private readonly clans: ClansService) {}

  /** Поиск клана по своей копии списка EXBO (у EXBO поиска нет). */
  @Get('search')
  @Header('Cache-Control', 'public, max-age=30')
  search(@Query() query: ClanSearchQueryDto) {
    return this.clans.search(query.region, query.q, query.limit ?? 20);
  }
}

/** Кланы: синхронизация списка EXBO в БД и поиск по нему. */
@Module({
  imports: [StalzoneModule],
  controllers: [ClansController],
  providers: [ClansService],
  exports: [ClansService],
})
export class ClansModule {}
