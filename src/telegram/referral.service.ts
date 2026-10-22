import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PlayersService } from 'src/players/players.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { escapeHtml } from './format';
import { ProService, TRIAL_DAYS } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';

/** Пригласившему — дней Pro за каждого друга. */
export const REFERRAL_BONUS_DAYS = 1;
/** Не больше стольких начислений за 30 дней (дальше друзья всё равно получают пробный). */
export const REFERRAL_MONTH_LIMIT = 10;
/** Бонус — только если у друга столько часов в игре (против вторых аккаунтов). */
export const REFERRAL_MIN_HOURS = 5;
/** Сколько ждём, что друг наиграет нужные часы. */
export const REFERRAL_WAIT_DAYS = 30;
const MONTH_MS = 30 * 86_400_000;
const HOUR_MS = 3_600_000;

export const REF_CODE_RE = /^[A-Za-z0-9_-]{8}$/;

/**
 * Реферальная программа: t.me/<бот>?start=ref_<код>.
 * Друг открывает бота по ссылке (запоминаем, кто пригласил), входит на сайте через EXBO
 * и привязывает этот Telegram — тогда ему сразу включается пробный Pro.
 * Пригласившему +1 день — когда у друга 5+ часов в игре: сразу или, если пока меньше,
 * как только наиграет (проверяем раз в час по снимкам статистики, ждём 30 дней).
 * Если друг уже брал пробный (на аккаунте или на этом Telegram) — не получает никто.
 */
@Injectable()
export class ReferralService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReferralService.name);
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pro: ProService,
    private readonly bot: TelegramBotService,
    private readonly players: PlayersService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.checkPending(), HOUR_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

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
        where: { inviterId: userId, rewardedAt: { gte: since } },
      }),
    ]);
    return {
      link: this.link(code),
      invited: total,
      rewardedMonth: month,
      monthLimit: REFERRAL_MONTH_LIMIT,
      bonusDays: REFERRAL_BONUS_DAYS,
      trialDays: TRIAL_DAYS,
      minHours: REFERRAL_MIN_HOURS,
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
    const hours = await this.players.accountHours(userId, true).catch(() => 0);
    const { id } = await this.prisma.referral.create({
      data: {
        inviterId,
        inviteeId: userId,
        chatId,
        rewarded: false,
        pendingUntil: new Date(Date.now() + REFERRAL_WAIT_DAYS * 86_400_000),
      },
    });
    const [invitee, inviter] = await this.logins(userId, inviterId);
    await this.bot.send(
      chatId,
      `🎁 <b>Pro включён на ${TRIAL_DAYS} дня</b> - по приглашению ${escapeHtml(inviter?.login ?? 'друга')}. Флиппер, флип-алерты и 20 ценовых алертов уже доступны.`,
    );
    if (hours >= REFERRAL_MIN_HOURS) {
      await this.reward(id, inviterId, userId, false);
      return;
    }
    this.logger.log(
      `реферал: ${inviterId} пригласил ${userId} (ждём ${REFERRAL_MIN_HOURS} ч в игре, сейчас ${hours.toFixed(1)})`,
    );
    if (inviter?.chatId) {
      await this.bot.send(
        inviter.chatId,
        `🤝 По вашей ссылке пришёл ${escapeHtml(invitee?.login ?? 'друг')}. +${REFERRAL_BONUS_DAYS} день Pro начислим, когда у него будет ${REFERRAL_MIN_HOURS} часов в игре (ждём до ${REFERRAL_WAIT_DAYS} дней).`,
      );
    }
  }

  /**
   * Раз в час: друзья, у которых было меньше 5 часов, — наиграли ли (по снимкам, без квоты EXBO).
   * Кто не наиграл за 30 дней — бонуса не будет.
   */
  async checkPending() {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = new Date();
      await this.prisma.referral.updateMany({
        where: { pendingUntil: { lte: now } },
        data: { pendingUntil: null },
      });
      const pending = await this.prisma.referral.findMany({
        where: { pendingUntil: { gt: now } },
        select: { id: true, inviterId: true, inviteeId: true },
      });
      for (const r of pending) {
        const hours = await this.players.accountHours(r.inviteeId, false);
        if (hours >= REFERRAL_MIN_HOURS)
          await this.reward(r.id, r.inviterId, r.inviteeId, true);
      }
    } catch (e) {
      this.logger.warn(`Проверка рефералов: ${(e as Error).message}`);
    } finally {
      this.checking = false;
    }
  }

  /** Друг наиграл 5 часов: +1 день пригласившему, если не упёрся в лимит за 30 дней. */
  private async reward(
    id: string,
    inviterId: string,
    inviteeId: string,
    later: boolean,
  ) {
    const now = new Date();
    const rewardedMonth = await this.prisma.referral.count({
      where: {
        inviterId,
        rewardedAt: { gte: new Date(now.getTime() - MONTH_MS) },
      },
    });
    const rewarded = rewardedMonth < REFERRAL_MONTH_LIMIT;
    // условный update: параллельная проверка не начислит второй раз
    const { count } = await this.prisma.referral.updateMany({
      where: { id, pendingUntil: { not: null } },
      data: { rewarded, rewardedAt: rewarded ? now : null, pendingUntil: null },
    });
    if (!count) return;
    if (rewarded) await this.pro.grant(inviterId, REFERRAL_BONUS_DAYS);
    this.logger.log(
      `реферал: бонус ${inviterId} за ${inviteeId}${rewarded ? '' : ' не начислен (лимит за месяц)'}`,
    );
    const [invitee, inviter] = await this.logins(inviteeId, inviterId);
    if (!inviter?.chatId) return;
    const who = escapeHtml(invitee?.login ?? 'друг');
    const intro = later
      ? `🤝 ${who} наиграл ${REFERRAL_MIN_HOURS} часов`
      : `🤝 По вашей ссылке пришёл ${who}`;
    await this.bot.send(
      inviter.chatId,
      rewarded
        ? `${intro} - вам +${REFERRAL_BONUS_DAYS} день Pro!`
        : `${intro}. Бонус не начислен: за 30 дней уже ${REFERRAL_MONTH_LIMIT} приглашений - это максимум.`,
    );
  }

  private logins(inviteeId: string, inviterId: string) {
    return Promise.all([
      this.prisma.user.findUnique({
        where: { id: inviteeId },
        select: { login: true },
      }),
      this.prisma.user.findUnique({
        where: { id: inviterId },
        select: { login: true, chatId: true },
      }),
    ]);
  }
}

/** Откат транзакции пробного: на аккаунте или Telegram он уже был. */
class NoTrial extends Error {}
