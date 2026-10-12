import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AccessService } from './access.service';
import { AdminService } from './admin.service';
import { TelegramAuthGuard, type TelegramRequest } from './telegram-auth.guard';

/** Только Telegram id из ADMIN_CHAT_IDS; остальным — 404, будто эндпоинта нет. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<TelegramRequest>();
    if (req.tgUser && this.access.isAdmin(req.tgUser.id)) return true;
    throw new NotFoundException();
  }
}

class ChatIdParam {
  @Matches(/^\d{1,20}$/, { message: 'chatId — Telegram id числом' })
  chatId!: string;
}

class UsersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;
}

class TermDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36500)
  days?: number;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @IsBoolean()
  forever?: boolean;
}

class GrantProDto extends TermDto {
  /** Сообщить пользователю в боте (по умолчанию — да) */
  @IsOptional()
  @IsBoolean()
  notify?: boolean;
}

class BanDto extends TermDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

@Controller('api/admin')
@UseGuards(TelegramAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('users')
  @Header('Cache-Control', 'no-store')
  users(@Query() query: UsersQuery) {
    return this.admin.users(query.q ?? '');
  }

  @Get('users/:chatId')
  @Header('Cache-Control', 'no-store')
  user(@Param() p: ChatIdParam) {
    return this.admin.user(p.chatId);
  }

  @Get('log')
  @Header('Cache-Control', 'no-store')
  log() {
    return this.admin.log();
  }

  @Post('users/:chatId/pro')
  grantPro(
    @Req() req: TelegramRequest,
    @Param() p: ChatIdParam,
    @Body() dto: GrantProDto,
  ) {
    return this.admin.grantPro(req.tgUser.id, p.chatId, dto);
  }

  @Post('users/:chatId/pro/revoke')
  revokePro(@Req() req: TelegramRequest, @Param() p: ChatIdParam) {
    return this.admin.revokePro(req.tgUser.id, p.chatId);
  }

  @Post('users/:chatId/ban')
  ban(
    @Req() req: TelegramRequest,
    @Param() p: ChatIdParam,
    @Body() dto: BanDto,
  ) {
    return this.admin.ban(req.tgUser.id, p.chatId, dto);
  }

  @Post('users/:chatId/unban')
  unban(@Req() req: TelegramRequest, @Param() p: ChatIdParam) {
    return this.admin.unban(req.tgUser.id, p.chatId);
  }
}
