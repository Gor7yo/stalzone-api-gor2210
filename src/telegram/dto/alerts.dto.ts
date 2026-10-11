import { Transform, Type } from 'class-transformer';
import {
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

  /** Порог цены за штуку */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  maxPrice!: number;
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
