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
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AccessService } from './access.service';
import { AccountGuard, type AccountRequest } from './account.guard';
import { AdminService } from './admin.service';

/** Только аккаунт с Telegram из ADMIN_CHAT_IDS; остальным — 404, будто эндпоинта нет. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AccountRequest>();
    if (req.account && this.access.isAdmin(req.account.chatId)) return true;
    throw new NotFoundException();
  }
}

/** Админ всегда с привязанным Telegram (иначе AdminGuard не пустит). */
const adminOf = (req: AccountRequest) => req.account.chatId!;

class UserIdParam {
  @IsUUID('4', { message: 'id — id аккаунта' })
  id!: string;
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
@UseGuards(AccountGuard, AdminGuard)
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

  @Get('users/:id')
  @Header('Cache-Control', 'no-store')
  user(@Param() p: UserIdParam) {
    return this.admin.user(p.id);
  }

  @Get('log')
  @Header('Cache-Control', 'no-store')
  log() {
    return this.admin.log();
  }

  @Post('users/:id/pro')
  grantPro(
    @Req() req: AccountRequest,
    @Param() p: UserIdParam,
    @Body() dto: GrantProDto,
  ) {
    return this.admin.grantPro(adminOf(req), p.id, dto);
  }

  @Post('users/:id/pro/revoke')
  revokePro(@Req() req: AccountRequest, @Param() p: UserIdParam) {
    return this.admin.revokePro(adminOf(req), p.id);
  }

  @Post('users/:id/ban')
  ban(
    @Req() req: AccountRequest,
    @Param() p: UserIdParam,
    @Body() dto: BanDto,
  ) {
    return this.admin.ban(adminOf(req), p.id, dto);
  }

  @Post('users/:id/unban')
  unban(@Req() req: AccountRequest, @Param() p: UserIdParam) {
    return this.admin.unban(adminOf(req), p.id);
  }
}
