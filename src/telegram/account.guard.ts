import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from './access.service';
import { type Account, AccountService } from './account.service';
import type { SubscriberInfo } from './alerts.service';
import { verifyInitData } from './init-data';
import { TelegramBotService } from './telegram-bot.service';

export type AccountRequest = Request & {
  account: Account;
  /** Пользователь Telegram, если запрос из мини-приложения */
  tgUser?: SubscriberInfo;
};

/** Telegram из подписанного initData мини-приложения (`Authorization: tma …`), иначе null. */
export function telegramOf(req: Request, botToken: string | undefined) {
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'tma' || !value || !botToken) return null;
  return verifyInitData(value, botToken);
}

/**
 * Кто делает запрос - аккаунт (EXBO):
 * - сайт: `Authorization: Bearer <токен>` сессии, выданной после входа через EXBO;
 * - мини-приложение: `Authorization: tma <initData>` - аккаунт, к которому привязан этот Telegram.
 * Без аккаунта - 401 code=login_required (фронт показывает «Войти через EXBO»).
 */
@Injectable()
export class AccountGuard implements CanActivate {
  constructor(
    private readonly accounts: AccountService,
    private readonly access: AccessService,
    private readonly bot: TelegramBotService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AccountRequest>();
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    let account: Account | null = null;
    if (scheme === 'Bearer' && value) {
      account = await this.accounts.resolveSession(value);
    } else {
      const tg = telegramOf(req, this.bot.botToken);
      if (tg) {
        this.access.touchChat(tg);
        req.tgUser = tg;
        account = await this.accounts.byChat(BigInt(tg.id));
      }
    }
    if (!account) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'login_required',
        message: 'Войдите через EXBO',
      });
    }
    await this.access.check(account);
    req.account = account;
    return true;
  }
}

/** Telegram аккаунта для алертов; не привязан - 409 code=telegram_required. */
export function chatOf(account: Account): bigint {
  if (account.chatId == null) {
    throw new ConflictException({
      statusCode: 409,
      code: 'telegram_required',
      message: 'Привяжите Telegram - уведомления приходят в бота',
    });
  }
  return account.chatId;
}
