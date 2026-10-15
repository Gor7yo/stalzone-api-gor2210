import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';

export class CreatePriceAlertDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;

  @Matches(/^[a-z0-9]{1,16}$/, { message: 'itemId: некорректный ID предмета' })
  itemId!: string;

  /** Название для текста уведомления (бэкенд справочник предметов не хранит). */
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(1, 64)
  itemName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  quality?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  upgrade?: number;

  /** Набор качеств: [2, 3] — Особый или Редкий */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(5, { each: true })
  qualities?: number[];

  /** Набор уровней заточки: [1, 5], [5, 6, 7, 8] */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(15, { each: true })
  upgrades?: number[];

  /** Ключевая характеристика модуля (marksman, sadist…); нет - любая */
  @IsOptional()
  @Matches(/^[a-z0-9_]{1,64}$/, {
    message: 'variant: некорректная характеристика',
  })
  variant?: string;

  /** Порог цены за штуку */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  maxPrice!: number;
}

/** Флип-алерт: условия — те же фильтры, что в ленте флиппера. */
export class FlipAlertDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;

  /** Прибыль после комиссии не меньше, ₽ */
  @Type(() => Number)
  @IsInt()
  @Min(10_000)
  @Max(2_000_000_000)
  minProfit!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  minPct?: number;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  minConfidence?: 'low' | 'medium' | 'high';

  /** Выкуп не дороже; 0 — любой */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  maxBudget?: number;

  /** Категории предметов (artefact, weapon…); пусто — любые */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @Matches(/^[a-z_]{1,32}$/, { each: true })
  groups?: string[];
}

export class RegionParam {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;
}

export class EmissionToggleDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;

  @IsBoolean()
  enabled!: boolean;
}

export class AlertIdParam {
  @IsUUID()
  id!: string;
}
