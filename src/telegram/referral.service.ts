import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { escapeHtml } from './format';
import { ProService, TRIAL_DAYS } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';

/** Пригласившему — дней Pro за каждого друга. */
export const REFERRAL_BONUS_DAYS = 1;
/** Не больше стольких начислений за 30 дней (дальше друзья всё равно получают пробный). */
export const REFERRAL_MONTH_LIMIT = 10;
const MONTH_MS = 30 * 86_400_000;

export const REF_CODE_RE = /^[A-Za-z0-9_-]{8}$/;

/**
 * Реферальная программа: t.me/<бот>?start=ref_<код>.
 * Друг открывает бота по ссылке (запоминаем, кто пригласил), входит на сайте через EXBO
 * и привязывает этот Telegram — тогда ему сразу включается пробный Pro, а пригласившему +1 день.
 * Если друг уже брал пробный (на аккаунте или на этом Telegram) — не получает никто.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly bot: TelegramBotService,
  ) {}

  /** Код ссылки аккаунта — создаётся при первом запросе. */
  async codeOf(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { refCode: true },
    });
    if (user.refCode) return user.refCode;
    for (;;) {
      const code = randomBytes(6).toString('base64url');
      const { count } = await this.prisma.user.updateMany({
        where: { id: userId, refCode: null },
        data: { refCode: code },
      });
      if (count) return code;
      // параллельный запрос успел раньше — берём его код
      const again = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { refCode: true },
      });
      if (again.refCode) return again.refCode;
    }
  }

  link(code: string) {
    return `https://t.me/${this.bot.username}?start=ref_${code}`;
  }

  /** Ссылка и счётчики для сайта и бота. */
  async stats(userId: string) {
    const code = await this.codeOf(userId);
    const since = new Date(Date.now() - MONTH_MS);
    const [total, month] = await Promise.all([
      this.prisma.referral.count({ where: { inviterId: userId } }),
      this.prisma.referral.count({
        where: { inviterId: userId, rewarded: true, createdAt: { gte: since } },
      }),
    ]);
    return {
      link: this.link(code),
      invited: total,
      rewardedMonth: month,
      monthLimit: REFERRAL_MONTH_LIMIT,
      bonusDays: REFERRAL_BONUS_DAYS,
      trialDays: TRIAL_DAYS,
    };
  }

  /**
   * /start ref_<код>: запомнить, кто пригласил. Только для «нового» Telegram:
   * не привязан к аккаунту, пробный не брал, ещё никем не приглашён, и не сам себя.
   * Возвращает логин пригласившего (для приветствия) или null.
   */
  async remember(chatId: number, code: string) {
    if (!REF_CODE_RE.test(code)) return null;
    const inviter = await this.prisma.user.findUnique({
      where: { refCode: code },
      select: { id: true, login: true, chatId: true },
    });
    if (!inviter || inviter.chatId === BigInt(chatId)) return null;
    const { count } = await this.prisma.telegramSubscriber.updateMany({
      where: {
        chatId: BigInt(chatId),
        referredBy: null,
        trialUsedAt: null,
        exboUser: { is: null },
      },
      data: { referredBy: inviter.id },
    });
    return count ? inviter.login : null;
  }

  /**
   * Telegram привязан к аккаунту (вызывает AccountService.linkChat): если он пришёл по ссылке —
   * пробный другу и день Pro пригласившему. Повторно не срабатывает (Referral.inviteeId уникален).
   */
  async onLinked(userId: string, chatId: bigint) {
    const sub = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId },
      select: { referredBy: true },
    });
    const inviterId = sub?.referredBy;
    if (!inviterId || inviterId === userId) return;
    // ссылка использована — дальше этот Telegram ни к кому не «приглашён»
    await this.prisma.telegramSubscriber.update({
      where: { chatId },
      data: { referredBy: null },
    });
    if (await this.prisma.referral.findUnique({ where: { inviteeId: userId } }))
      return;

    // пробный — как обычный: один на аккаунт и на Telegram (условные update, без гонок)
    const now = new Date();
    const trial = await this.prisma
      .$transaction(async (tx) => {
        const chat = await tx.telegramSubscriber.updateMany({
          where: { chatId, trialUsedAt: null },
          data: { trialUsedAt: now },
        });
        const own = await tx.user.updateMany({
          where: { id: userId, trialUsedAt: null },
          data: { trialUsedAt: now },
        });
        if (!chat.count || !own.count) throw new NoTrial();
      })
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof NoTrial) return false;
        throw e;
      });
    if (!trial) return;

    await this.pro.grant(userId, TRIAL_DAYS);
    const since = new Date(Date.now() - MONTH_MS);
    const rewardedMonth = await this.prisma.referral.count({
      where: { inviterId, rewarded: true, createdAt: { gte: since } },
    });
    const rewarded = rewardedMonth < REFERRAL_MONTH_LIMIT;
    await this.prisma.referral.create({
      data: { inviterId, inviteeId: userId, chatId, rewarded },
    });
    if (rewarded) await this.pro.grant(inviterId, REFERRAL_BONUS_DAYS);
    this.logger.log(
      `реферал: ${inviterId} пригласил ${userId}${rewarded ? '' : ' (лимит за месяц)'}`,
    );
    await this.notify(userId, inviterId, chatId, rewarded);
  }

  private async notify(
    inviteeId: string,
    inviterId: string,
    chatId: bigint,
    rewarded: boolean,
  ) {
    const [invitee, inviter] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: inviteeId },
        select: { login: true },
      }),
      this.prisma.user.findUnique({
        where: { id: inviterId },
        select: { login: true, chatId: true },
      }),
    ]);
    await this.bot.send(
      chatId,
      `🎁 <b>Pro включён на ${TRIAL_DAYS} дня</b> - по приглашению ${escapeHtml(inviter?.login ?? 'друга')}. Флиппер, флип-алерты и 20 ценовых алертов уже доступны.`,
    );
    if (inviter?.chatId) {
      await this.bot.send(
        inviter.chatId,
        rewarded
          ? `🤝 По вашей ссылке пришёл ${escapeHtml(invitee?.login ?? 'друг')} - вам +${REFERRAL_BONUS_DAYS} день Pro!`
          : `🤝 По вашей ссылке пришёл ${escapeHtml(invitee?.login ?? 'друг')}. Бонус не начислен: за 30 дней уже ${REFERRAL_MONTH_LIMIT} приглашений - это максимум.`,
      );
    }
  }
}

/** Откат транзакции пробного: на аккаунте или Telegram он уже был. */
class NoTrial extends Error {}
