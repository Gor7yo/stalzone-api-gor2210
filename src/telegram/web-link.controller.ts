import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Matches } from 'class-validator';
import { TelegramAuthGuard, type TelegramRequest } from './telegram-auth.guard';
import { TelegramBotService } from './telegram-bot.service';
import { LINK_CODE_RE, WebLinkService } from './web-link.service';

class LinkCodeParam {
  @Matches(LINK_CODE_RE, { message: 'code: некорректный код' })
  code!: string;
}

/** Привязка сайта к Telegram через бота (см. WebLinkService). */
@Controller('api/tg-link')
export class WebLinkController {
  constructor(
    private readonly webLink: WebLinkService,
    private readonly bot: TelegramBotService,
  ) {}

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create() {
    if (!this.bot.enabled)
      throw new ServiceUnavailableException('Алерты отключены');
    return this.webLink.createCode();
  }

  /** Сайт опрашивает раз в 2 с, пока пользователь подтверждает в боте. */
  @Post(':code/claim')
  @Header('Cache-Control', 'no-store')
  claim(@Param() { code }: LinkCodeParam) {
    return this.webLink.claim(code);
  }

  @Get('me')
  @UseGuards(TelegramAuthGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() req: TelegramRequest) {
    const { first_name, username } = req.tgUser;
    return { firstName: first_name ?? null, username: username ?? null };
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Req() req: TelegramRequest) {
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Bearer' && value) await this.webLink.logout(value);
  }
}
