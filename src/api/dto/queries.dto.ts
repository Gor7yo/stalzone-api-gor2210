import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Строгая валидация всех параметров: они попадают в путь запроса к STALCRAFT API,
 * поэтому разрешены только ожидаемые символы (никаких «/», «..», «?»).
 */

export const REGIONS = ['ru', 'eu', 'na', 'sea'] as const;
export type Region = (typeof REGIONS)[number];

export const LOT_SORTS = [
  'time_created',
  'time_left',
  'current_price',
  'buyout_price',
] as const;

class RegionQuery {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;
}

/** Больше 200 за запрос EXBO не отдаёт - такие запросы к нему урезаем (лоты из нашей БД - до 1000). */
export const EXBO_PAGE_MAX = 200;

class PageQuery extends RegionQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EXBO_PAGE_MAX)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  offset?: number;
}

export class AuctionQueryDto extends PageQuery {
  /** Лоты из нашей БД - до 1000 за запрос (рынок модулей ~4 тыс.); к EXBO уходит не больше 200 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  declare limit?: number;

  /** ID предмета из базы EXBO: «gyn0», «5lpy4» */
  @Matches(/^[a-z0-9]{1,16}$/, { message: 'item: некорректный ID предмета' })
  item!: string;

  @IsOptional()
  @IsBooleanString()
  additional?: string;

  @IsOptional()
  @IsIn(LOT_SORTS)
  sort?: (typeof LOT_SORTS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  /** true — пользователь нажал «Обновить»: снимок не старше нескольких секунд */
  @IsOptional()
  @IsBooleanString()
  fresh?: string;

  /** Насколько старый снимок лотов годится, с (цены в списках); по умолчанию — минута */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(3600)
  maxAge?: number;
}

export const HISTORY_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

/** История продаж за период: сервер сам листает страницы EXBO и отдаёт одним ответом. */
export class HistoryPeriodQueryDto extends RegionQuery {
  @Matches(/^[a-z0-9]{1,16}$/, { message: 'item: некорректный ID предмета' })
  item!: string;

  @IsIn(HISTORY_PERIODS, {
    message: `period: одно из ${HISTORY_PERIODS.join(', ')}`,
  })
  period!: HistoryPeriod;

  /** true — пользователь нажал «Обновить» */
  @IsOptional()
  @IsBooleanString()
  fresh?: string;
}

export class CharacterQueryDto extends RegionQuery {
  @Matches(/^[\p{L}\p{N}_.-]{1,32}$/u, {
    message: 'username: некорректный ник',
  })
  username!: string;
}

export class ClanListQueryDto extends PageQuery {}

export class ClanInfoQueryDto extends RegionQuery {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'clanId: некорректный ID клана',
  })
  clanId!: string;
}

export class EmissionQueryDto extends RegionQuery {}
