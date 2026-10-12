import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ProService } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';
import {
  tributeAction,
  verifyTributeSignature,
  type TributeWebhook,
} from './tribute';

/** Оплата Pro через Tribute: вебхук покупки/подписки → продление Pro. */
@Controller('api/payments/tribute')
export class TributeController {
  private readonly logger = new Logger(TributeController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly bot: TelegramBotService,
  ) {}

  @Post()
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('trbt-signature') signature?: string,
  ) {
    const apiKey = this.config.get<string>('TRIBUTE_API_KEY') ?? '';
    if (
      !req.rawBody ||
      !verifyTributeSignature(req.rawBody, signature, apiKey)
    ) {
      this.logger.warn('Вебхук Tribute с неверной подписью');
      throw new UnauthorizedException('bad signature');
    }

    const hook = JSON.parse(req.rawBody.toString('utf8')) as TributeWebhook;
    const action = tributeAction(hook, {
      productId: this.config.get<string>('TRIBUTE_PRODUCT_ID') || undefined,
      subscriptionId:
        this.config.get<string>('TRIBUTE_SUBSCRIPTION_ID') || undefined,
    });
    if (action.kind === 'ignore') {
      this.logger.log(`Tribute ${hook.name}: пропуск (${action.reason})`);
      // незнакомый формат — пишем тело (подпись уже проверена, ключей API в нём нет)
      if (!hook.name || !hook.payload)
        this.logger.warn(
          `Tribute: неизвестный формат: ${req.rawBody.toString('utf8').slice(0, 1500)}`,
        );
      return { ok: true };
    }

    // повтор того же вебхука — Pro уже выдан
    try {
      const p = hook.payload ?? {};
      await this.prisma.proPayment.create({
        data: {
          id: action.key,
          chatId: action.chatId,
          event: hook.name,
          amount: typeof p.amount === 'number' ? p.amount : null,
          currency: typeof p.currency === 'string' ? p.currency : null,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return { ok: true, duplicate: true };
      throw e;
    }

    const until =
      action.kind === 'grant'
        ? await this.pro.grant(action.chatId, action.days)
        : await this.pro.extendTo(action.chatId, action.until);
    this.logger.log(
      `Tribute ${hook.name}: Pro для ${action.chatId} до ${until.toISOString()}`,
    );

    const date = until.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    });
    await this.bot.send(
      action.chatId,
      `⭐ <b>STALZONE INFO Pro активен</b> до ${date}.\nСпасибо за поддержку! Флиппер, графики и флип-алерты уже открыты.`,
    );
    return { ok: true };
  }
}
