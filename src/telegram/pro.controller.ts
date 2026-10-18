import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { ServerGuard } from 'src/common/guards/server.guard';
import { FlipperService } from 'src/flipper/flipper.service';
import { SaleTimingService } from 'src/flipper/sale-timing.service';
import { SellAdvisorService } from 'src/flipper/sell-advisor.service';
import { ProService } from './pro.service';
import { AccountGuard, type AccountRequest } from './account.guard';

class FlipsQueryDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;
}

class SellQueryDto extends FlipsQueryDto {
  @Matches(/^[a-z0-9]{1,16}$/, { message: 'item: некорректный ID предмета' })
  item!: string;

  /** -1 — у предмета нет качества */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  @Max(5)
  quality?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  upgrade?: number;

  /** Ключевая характеристика модуля (marksman, sadist…) */
  @IsOptional()
  @Matches(/^[a-z0-9_]{1,64}$/, {
    message: 'variant: некорректная характеристика',
  })
  variant?: string;

  /** Сколько штук продаём одним лотом */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  amount?: number;
}

class GrantProDto {
  /** Telegram id пользователя */
  @Matches(/^\d{1,20}$/)
  chatId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3660)
  days!: number;
}

/** Лента флиппера — только для Pro. */
@Controller('api/flips')
@UseGuards(AccountGuard)
export class FlipsController {
  constructor(
    private readonly pro: ProService,
    private readonly flipper: FlipperService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, max-age=30')
  async flips(@Req() req: AccountRequest, @Query() query: FlipsQueryDto) {
    await this.pro.require(req.account.userId);
    return this.flipper.feed(query.region);
  }
}

/** Помощник продажи — только для Pro. */
@Controller('api/sell')
@UseGuards(AccountGuard)
export class SellController {
  constructor(
    private readonly pro: ProService,
    private readonly advisor: SellAdvisorService,
    private readonly timingService: SaleTimingService,
  ) {}

  @Get('advice')
  @Header('Cache-Control', 'private, max-age=20')
  async advice(@Req() req: AccountRequest, @Query() query: SellQueryDto) {
    await this.pro.require(req.account.userId);
    return this.advisor.advise({
      region: query.region,
      itemId: query.item,
      quality: query.quality ?? -1,
      upgrade: query.upgrade ?? 0,
      variant: query.variant ?? '',
      amount: query.amount ?? 1,
    });
  }

  /** «Когда выгоднее продавать»: цена и сделки по часам суток и дням недели. */
  @Get('timing')
  @Header('Cache-Control', 'private, max-age=300')
  async timing(@Req() req: AccountRequest, @Query() query: SellQueryDto) {
    await this.pro.require(req.account.userId);
    return this.timingService.get({
      region: query.region,
      itemId: query.item,
      quality: query.quality ?? -1,
      upgrade: query.upgrade ?? 0,
      variant: query.variant ?? '',
    });
  }
}

/** Ручная выдача Pro (тест, подарки, поддержка): заголовок X-Admin-Token. */
@Controller('api/admin/pro')
@UseGuards(ServerGuard)
export class ProAdminController {
  constructor(private readonly pro: ProService) {}

  @Post()
  async grant(@Body() dto: GrantProDto) {
    const { userId, until } = await this.pro.grantChat(
      BigInt(dto.chatId),
      dto.days,
    );
    return { chatId: dto.chatId, userId, proUntil: until };
  }
}
