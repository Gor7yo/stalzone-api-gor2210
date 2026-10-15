import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { UsersService } from 'src/users/users.service';
import { AccessService } from './access.service';
import { AccountGuard, type AccountRequest, telegramOf } from './account.guard';
import { AccountService } from './account.service';
import { ExboLoginService } from './exbo-login.service';
import { ProService } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';
import { WebLinkService } from './web-link.service';

class CompleteDto {
  @IsString()
  @Length(1, 2048)
  code!: string;

  @Matches(/^[A-Za-z0-9_-]{22}$/, { message: 'state: некорректный' })
  state!: string;
}

/** Вход через EXBO и выход. */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly login: ExboLoginService,
    private readonly accounts: AccountService,
    private readonly bot: TelegramBotService,
  ) {}

  /** Ссылка на вход в EXBO. Из мини-приложения (tma) Telegram привяжется к аккаунту. */
  @Post('exbo/start')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Header('Cache-Control', 'no-store')
  start(@Req() req: Request) {
    const tg = telegramOf(req, this.bot.botToken);
    return this.login.start(tg ? BigInt(tg.id) : null);
  }

  /** Страница возврата из EXBO: создаёт аккаунт и выдаёт токен сессии сайта. */
  @Post('exbo/complete')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Header('Cache-Control', 'no-store')
  complete(@Body() { code, state }: CompleteDto) {
    return this.login.complete(code, state);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request) {
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Bearer' && value) await this.accounts.logout(value);
  }
}

/** Текущий аккаунт: Pro, персонажи, привязанный Telegram. */
@Controller('api/me')
@UseGuards(AccountGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly access: AccessService,
    private readonly users: UsersService,
    private readonly accounts: AccountService,
    private readonly webLink: WebLinkService,
    private readonly bot: TelegramBotService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async me(@Req() req: AccountRequest) {
    const { userId, login, chatId } = req.account;
    const [status, characters, telegram] = await Promise.all([
      this.pro.status(userId),
      this.users.charactersOf(userId),
      chatId == null
        ? null
        : this.prisma.telegramSubscriber.findUnique({
            where: { chatId },
            select: { firstName: true, username: true, blocked: true },
          }),
    ]);
    return {
      login,
      ...status,
      ...characters,
      telegram: telegram && {
        firstName: telegram.firstName,
        username: telegram.username,
        /** заблокировал бота - уведомления не дойдут */
        blocked: telegram.blocked,
      },
      ...(this.access.isAdmin(chatId) && { admin: true }),
    };
  }

  /** Взять пробный Pro (один раз). Отдаёт новый статус. */
  @Post('trial')
  @Header('Cache-Control', 'no-store')
  trial(@Req() req: AccountRequest) {
    return this.pro.startTrial(req.account.userId);
  }

  @Post('characters/refresh')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Header('Cache-Control', 'no-store')
  async refresh(@Req() req: AccountRequest) {
    await this.users.syncCharacters(req.account.userId);
    return this.users.charactersOf(req.account.userId);
  }

  /** Ссылка на бота для привязки Telegram (подтверждение кнопкой в боте). */
  @Post('telegram')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Header('Cache-Control', 'no-store')
  linkTelegram(@Req() req: AccountRequest) {
    if (!this.bot.enabled)
      throw new ServiceUnavailableException('Бот отключён');
    return this.webLink.createCode(req.account.userId);
  }

  @Delete('telegram')
  @HttpCode(204)
  async unlinkTelegram(@Req() req: AccountRequest) {
    await this.accounts.unlinkChat(req.account.userId);
  }
}
