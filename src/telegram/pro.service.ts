import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

const DAY = 86_400_000;

/** Ценовых алертов: бесплатно / в Pro. */
export const PRICE_ALERT_LIMIT = { free: 1, pro: 20 } as const;

export interface ProStatus {
  pro: boolean;
  /** До какого момента действует Pro (ISO); null — не оформлен */
  proUntil: string | null;
  limits: { priceAlerts: number };
}

export const isProActive = (
  proUntil: Date | null | undefined,
  now = Date.now(),
) => !!proUntil && proUntil.getTime() > now;

/**
 * Подписка Pro. Привязана к аккаунту Telegram: и мини-приложение, и сайт
 * (через привязку Telegram) видят один и тот же статус.
 */
@Injectable()
export class ProService {
  constructor(private readonly prisma: PrismaService) {}

  async status(chatId: number | bigint): Promise<ProStatus> {
    const s = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { proUntil: true },
    });
    const pro = isProActive(s?.proUntil);
    return {
      pro,
      proUntil: s?.proUntil?.toISOString() ?? null,
      limits: {
        priceAlerts: pro ? PRICE_ALERT_LIMIT.pro : PRICE_ALERT_LIMIT.free,
      },
    };
  }

  async isPro(chatId: number | bigint) {
    return (await this.status(chatId)).pro;
  }

  /** Бросает 403 с кодом pro_required — фронтенд по нему показывает экран Pro. */
  async require(chatId: number | bigint) {
    if (!(await this.isPro(chatId))) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'pro_required',
        message: 'Доступно в Stalzone Pro',
      });
    }
  }

  /**
   * Продлить Pro на days дней (оплата, подарок, ручная выдача).
   * Неистёкший срок продлевается от его конца, истёкший — от сейчас.
   */
  async grant(chatId: number | bigint, days: number) {
    const id = BigInt(chatId);
    const current = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: id },
      select: { proUntil: true },
    });
    const from = Math.max(Date.now(), current?.proUntil?.getTime() ?? 0);
    const proUntil = new Date(from + days * DAY);
    await this.prisma.telegramSubscriber.upsert({
      where: { chatId: id },
      create: { chatId: id, proUntil },
      update: { proUntil },
    });
    return proUntil;
  }
}
