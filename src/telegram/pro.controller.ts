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
import { IsIn, IsInt, Matches, Max, Min } from 'class-validator';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { ServerGuard } from 'src/common/guards/server.guard';
import { FlipperService } from 'src/flipper/flipper.service';
import { AccessService } from './access.service';
import { ProService } from './pro.service';
import { TelegramAuthGuard, type TelegramRequest } from './telegram-auth.guard';

class FlipsQueryDto {
  @IsIn(REGIONS, { message: `region: одно из ${REGIONS.join(', ')}` })
  region!: Region;
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
