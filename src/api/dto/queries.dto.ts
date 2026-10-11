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

class PageQuery extends RegionQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  offset?: number;
}

export class AuctionQueryDto extends PageQuery {
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
