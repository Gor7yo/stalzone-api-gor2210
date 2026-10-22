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
import { escapeHtml } from './format';
import { MonitorService } from './monitor.service';
import { ProService } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';
import {
  tributeAction,
  verifyTributeSignature,
  type TributeWebhook,
} from './tribute';

/** События, за которыми стоят деньги: пропуск такого — тревога админам. */
const PAYMENT_EVENTS = new Set([
  'new_digital_product',
  'new_subscription',
  'renewed_subscription',
]);

/**
 * Оплата Pro через Tribute: вебхук покупки/подписки → продление Pro.
 * Неверная подпись, незнакомый формат, пропущенная оплата или ошибка — тревога в мониторинг.
 */
@Controller('api/payments/tribute')
export class TributeController {
  private readonly logger = new Logger(TributeController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly bot: TelegramBotService,
    private readonly monitor: MonitorService,
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
      void this.monitor.alert(
        'tribute:signature',
        `<b>Tribute: вебхук с неверной подписью</b>\nЕсли это настоящая оплата - Pro не выдан. Проверьте TRIBUTE_API_KEY в .env (ключ в кабинете Tribute мог смениться).`,
      );
      throw new UnauthorizedException('bad signature');
    }

    try {
      return await this.handle(req.rawBody);
    } catch (e) {
      void this.monitor.alert(
        'tribute:error',
        `<b>Tribute: ошибка при обработке оплаты</b>\n${escapeHtml((e as Error).message).slice(0, 500)}\nTribute повторит вебхук; если не пройдёт - выдайте Pro вручную.`,
      );
      throw e;
    }
  }

  private async handle(rawBody: Buffer) {
    const hook = JSON.parse(rawBody.toString('utf8')) as TributeWebhook & {
      test_event?: unknown;
    };
    // кнопка «тестовый вебхук» в Tribute: {"test_event":"test_event"}
    if (hook.test_event) {
      this.logger.log('Tribute: тестовый вебхук получен, подпись верна');
      return { ok: true };
    }
    const action = tributeAction(hook, {
      productId: this.config.get<string>('TRIBUTE_PRODUCT_ID') || undefined,
      subscriptionId:
        this.config.get<string>('TRIBUTE_SUBSCRIPTION_ID') || undefined,
    });
    if (action.kind === 'ignore') {
      this.logger.log(`Tribute ${hook.name}: пропуск (${action.reason})`);
      // незнакомый формат — пишем тело (подпись уже проверена, ключей API в нём нет)
      if (!hook.name || !hook.payload) {
        this.logger.warn(
          `Tribute: неизвестный формат: ${rawBody.toString('utf8').slice(0, 1500)}`,
        );
        void this.monitor.alert(
          'tribute:format',
          `<b>Tribute: вебхук незнакомого формата</b>\nПодпись верна, но разобрать не смогли - тело в логе stalzone-api.`,
        );
      } else if (PAYMENT_EVENTS.has(hook.name)) {
        void this.monitor.alert(
          `tribute:skip:${action.reason}`,
          `<b>Tribute: оплата пришла, но Pro не выдан</b>\n${escapeHtml(hook.name)}: ${escapeHtml(action.reason)}. Проверьте TRIBUTE_PRODUCT_ID / TRIBUTE_SUBSCRIPTION_ID или выдайте Pro вручную.`,
        );
      }
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

    // Telegram привязан к аккаунту - Pro аккаунту; нет - ждёт на чате до привязки
    const { userId, until } =
      action.kind === 'grant'
        ? await this.pro.grantChat(action.chatId, action.days)
        : await this.pro.extendChatTo(action.chatId, action.until);
    if (userId) {
      await this.prisma.proPayment.update({
        where: { id: action.key },
        data: { userId },
      });
    }
    this.logger.log(
      `Tribute ${hook.name}: Pro для ${action.chatId} (аккаунт ${userId ?? 'не привязан'}) до ${until.toISOString()}`,
    );

    const date = until.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    });
    await this.bot.send(
      action.chatId,
      userId
        ? `⭐ <b>STALZONE INFO Pro активен</b> до ${date}.\nСпасибо за поддержку! Флиппер, графики и флип-алерты уже открыты.`
        : `⭐ <b>STALZONE INFO Pro оплачен</b> до ${date}. Спасибо за поддержку!\nВойдите в приложении через EXBO - Pro перейдёт на ваш аккаунт и откроется.`,
    );
    return { ok: true };
  }
}
