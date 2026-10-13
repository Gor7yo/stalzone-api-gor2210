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
import { SellAdvisorService } from 'src/flipper/sell-advisor.service';
import { AccessService } from './access.service';
import { ProService } from './pro.service';
import { TelegramAuthGuard, type TelegramRequest } from './telegram-auth.guard';

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

/** Статус подписки текущего пользователя. */
@Controller('api/me')
@UseGuards(TelegramAuthGuard)
export class MeController {
  constructor(
    private readonly pro: ProService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async me(@Req() req: TelegramRequest) {
    const status = await this.pro.status(req.tgUser.id);
    return {
      ...status,
      ...(this.access.isAdmin(req.tgUser.id) && { admin: true }),
    };
  }

  /** Взять пробный Pro (один раз). Отдаёт новый статус. */
  @Post('trial')
  @Header('Cache-Control', 'no-store')
  trial(@Req() req: TelegramRequest) {
    return this.pro.startTrial(req.tgUser.id);
  }
}

/** Лента флиппера — только для Pro. */
@Controller('api/flips')
@UseGuards(TelegramAuthGuard)
export class FlipsController {
  constructor(
    private readonly pro: ProService,
    private readonly flipper: FlipperService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, max-age=30')
  async flips(@Req() req: TelegramRequest, @Query() query: FlipsQueryDto) {
    await this.pro.require(req.tgUser.id);
    return this.flipper.feed(query.region);
  }
}

/** Помощник продажи — только для Pro. */
@Controller('api/sell')
@UseGuards(TelegramAuthGuard)
export class SellController {
  constructor(
    private readonly pro: ProService,
    private readonly advisor: SellAdvisorService,
  ) {}

  @Get('advice')
  @Header('Cache-Control', 'private, max-age=20')
  async advice(@Req() req: TelegramRequest, @Query() query: SellQueryDto) {
    await this.pro.require(req.tgUser.id);
    return this.advisor.advise({
      region: query.region,
      itemId: query.item,
      quality: query.quality ?? -1,
      upgrade: query.upgrade ?? 0,
      amount: query.amount ?? 1,
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
    const proUntil = await this.pro.grant(BigInt(dto.chatId), dto.days);
    return { chatId: dto.chatId, proUntil };
  }
}
