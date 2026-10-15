import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

const DAY = 86_400_000;

/** Пробный Pro: дней, один раз на аккаунт (и на Telegram). */
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

const statusOf = (
  proUntil: Date | null | undefined,
  trialUsedAt: Date | null | undefined,
): ProStatus => {
  const pro = isProActive(proUntil);
  return {
    pro,
    proUntil: proUntil?.toISOString() ?? null,
    limits: {
      priceAlerts: pro ? PRICE_ALERT_LIMIT.pro : PRICE_ALERT_LIMIT.free,
    },
    trialAvailable: !pro && !trialUsedAt,
  };
};

const proRequired = () =>
  new ForbiddenException({
    statusCode: 403,
    code: 'pro_required',
    message: 'Доступно в STALZONE INFO Pro',
  });

/**
 * Подписка Pro живёт на аккаунте (EXBO). Привязанному Telegram срок копируется:
 * по нему бот и отправщик алертов решают, что доступно чату.
 * Оплата с Telegram без аккаунта (Tribute) ждёт на чате и переезжает на аккаунт при привязке.
 */
@Injectable()
export class ProService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- аккаунт ----------

  async status(userId: string): Promise<ProStatus> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { proUntil: true, trialUsedAt: true },
    });
    return statusOf(u?.proUntil, u?.trialUsedAt);
  }

  /** Бросает 403 с кодом pro_required — фронтенд по нему показывает экран Pro. */
  async require(userId: string) {
    if (!(await this.status(userId)).pro) throw proRequired();
  }

  /**
   * Пробный Pro на TRIAL_DAYS. Отметка ставится условным update, так что
   * параллельные запросы не выдадут его дважды; Telegram, на котором уже брали пробный, - тоже.
   */
  async startTrial(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { proUntil: true, subscriber: { select: { trialUsedAt: true } } },
    });
    if (isProActive(user.proUntil)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'already_pro',
        message: 'Pro уже активен',
      });
    }
    const { count } = user.subscriber?.trialUsedAt
      ? { count: 0 }
      : await this.prisma.user.updateMany({
          where: { id: userId, trialUsedAt: null },
          data: { trialUsedAt: new Date() },
        });
    if (!count) {
      throw new ConflictException({
        statusCode: 409,
        code: 'trial_used',
        message: 'Пробный период уже использован',
      });
    }
    await this.grant(userId, TRIAL_DAYS);
    return this.status(userId);
  }

  /**
   * Продлить Pro на days дней (оплата, подарок, ручная выдача).
   * Неистёкший срок продлевается от его конца, истёкший — от сейчас.
   */
  async grant(userId: string, days: number) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { proUntil: true },
    });
    const from = Math.max(Date.now(), u.proUntil?.getTime() ?? 0);
    return this.setUntil(userId, new Date(from + days * DAY));
  }

  /** Pro как минимум до until (подписка Tribute сама знает дату окончания). */
  async extendTo(userId: string, until: Date) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { proUntil: true },
    });
    return this.setUntil(
      userId,
      new Date(Math.max(until.getTime(), u.proUntil?.getTime() ?? 0)),
    );
  }

  /** Ровно до until (админ); null — снять Pro. */
  async setUntil<T extends Date | null>(userId: string, until: T): Promise<T> {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { proUntil: until },
      select: { chatId: true, trialUsedAt: true },
    });
    if (u.chatId) {
      await this.prisma.telegramSubscriber.updateMany({
        where: { chatId: u.chatId },
        data: {
          proUntil: until,
          ...(u.trialUsedAt && { trialUsedAt: u.trialUsedAt }),
        },
      });
    }
    return until;
  }

  // ---------- оплата и выдача по Telegram (Tribute, X-Admin-Token) ----------

  /**
   * Продлить Pro владельцу Telegram: аккаунту, если Telegram привязан, иначе
   * самому чату - срок переедет на аккаунт при привязке.
   */
  async grantChat(chatId: bigint, days: number) {
    const userId = await this.userOfChat(chatId);
    if (userId) return { userId, until: await this.grant(userId, days) };
    const current = await this.chat(chatId);
    const from = Math.max(Date.now(), current?.proUntil?.getTime() ?? 0);
    return {
      userId,
      until: await this.setChat(chatId, new Date(from + days * DAY)),
    };
  }

  async extendChatTo(chatId: bigint, until: Date) {
    const userId = await this.userOfChat(chatId);
    if (userId) return { userId, until: await this.extendTo(userId, until) };
    const current = await this.chat(chatId);
    const proUntil = new Date(
      Math.max(until.getTime(), current?.proUntil?.getTime() ?? 0),
    );
    return { userId, until: await this.setChat(chatId, proUntil) };
  }

  /** Pro чата (копия аккаунта или ожидающая оплата) - для алертов в боте. */
  async chatStatus(chatId: bigint) {
    const c = await this.chat(chatId);
    return statusOf(c?.proUntil, c?.trialUsedAt);
  }

  async requireChat(chatId: bigint) {
    if (!(await this.chatStatus(chatId)).pro) throw proRequired();
  }

  private async userOfChat(chatId: bigint) {
    const u = await this.prisma.user.findUnique({
      where: { chatId },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  private chat(chatId: bigint) {
    return this.prisma.telegramSubscriber.findUnique({
      where: { chatId },
      select: { proUntil: true, trialUsedAt: true },
    });
  }

  private async setChat(chatId: bigint, proUntil: Date) {
    await this.prisma.telegramSubscriber.upsert({
      where: { chatId },
      create: { chatId, proUntil },
      update: { proUntil },
    });
    return proUntil;
  }
}
