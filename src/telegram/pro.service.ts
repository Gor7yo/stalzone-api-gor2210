import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

const DAY = 86_400_000;

/** Пробный Pro: дней, один раз на Telegram. */
export const TRIAL_DAYS = 3;

/** Ценовых алертов: бесплатно / в Pro. */
export const PRICE_ALERT_LIMIT = { free: 1, pro: 20 } as const;

export interface ProStatus {
  pro: boolean;
  /** До какого момента действует Pro (ISO); null — не оформлен */
  proUntil: string | null;
  limits: { priceAlerts: number };
  /** Можно взять пробный период (ещё не брал и Pro сейчас не активен) */
  trialAvailable: boolean;
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
      select: { proUntil: true, trialUsedAt: true },
    });
    const pro = isProActive(s?.proUntil);
    return {
      pro,
      proUntil: s?.proUntil?.toISOString() ?? null,
      limits: {
        priceAlerts: pro ? PRICE_ALERT_LIMIT.pro : PRICE_ALERT_LIMIT.free,
      },
      trialAvailable: !pro && !s?.trialUsedAt,
    };
  }

  /**
   * Пробный Pro на TRIAL_DAYS. Отметка ставится условным update, так что
   * параллельные запросы не выдадут его дважды.
   */
  async startTrial(chatId: number | bigint) {
    const id = BigInt(chatId);
    const st = await this.status(id);
    if (st.pro) {
      throw new ConflictException({
        statusCode: 409,
        code: 'already_pro',
        message: 'Pro уже активен',
      });
    }
    await this.prisma.telegramSubscriber.upsert({
      where: { chatId: id },
      create: { chatId: id },
      update: {},
    });
    const { count } = await this.prisma.telegramSubscriber.updateMany({
      where: { chatId: id, trialUsedAt: null },
      data: { trialUsedAt: new Date() },
    });
    if (!count) {
      throw new ConflictException({
        statusCode: 409,
        code: 'trial_used',
        message: 'Пробный период уже использован',
      });
    }
    await this.grant(id, TRIAL_DAYS);
    return this.status(id);
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

  /** Ровно до until (админ); null — снять Pro. */
  async setUntil(chatId: number | bigint, until: Date | null) {
    const id = BigInt(chatId);
    await this.prisma.telegramSubscriber.upsert({
      where: { chatId: id },
      create: { chatId: id, proUntil: until },
      update: { proUntil: until },
    });
    return until;
  }

  /** Pro как минимум до until (подписка Tribute сама знает дату окончания). */
  async extendTo(chatId: number | bigint, until: Date) {
    const id = BigInt(chatId);
    const current = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: id },
      select: { proUntil: true },
    });
    const proUntil = new Date(
      Math.max(until.getTime(), current?.proUntil?.getTime() ?? 0),
    );
    await this.prisma.telegramSubscriber.upsert({
      where: { chatId: id },
      create: { chatId: id, proUntil },
      update: { proUntil },
    });
    return proUntil;
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
