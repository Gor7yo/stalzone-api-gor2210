import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from './access.service';
import type { SubscriberInfo } from './alerts.service';
import { verifyInitData } from './init-data';
import { TelegramBotService } from './telegram-bot.service';
import { WebLinkService } from './web-link.service';

export type TelegramRequest = Request & { tgUser: SubscriberInfo };

/**
 * Кто делает запрос к алертам:
 * - мини-приложение: `Authorization: tma <initData>` с валидной подписью бота;
 * - сайт в браузере: `Authorization: Bearer <токен>`, полученный при привязке через бота.
 */
@Injectable()
export class TelegramAuthGuard implements CanActivate {
  constructor(
    private readonly bot: TelegramBotService,
    private readonly webLink: WebLinkService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const botToken = this.bot.botToken;
    if (!botToken) throw new ServiceUnavailableException('Алерты отключены');

    const req = context.switchToHttp().getRequest<TelegramRequest>();
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    let user: SubscriberInfo | null = null;
    if (scheme === 'tma' && value) user = verifyInitData(value, botToken);
    if (scheme === 'Bearer' && value) user = await this.webLink.resolve(value);
    if (!user) throw new UnauthorizedException('Привяжите Telegram');

    await this.access.check(user);
    req.tgUser = user;
    return true;
  }
}
