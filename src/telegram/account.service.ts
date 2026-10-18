import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ReferralService } from './referral.service';

/** Сессию сайта, которой не пользовались полгода, считаем брошенной. */
const SESSION_IDLE_MS = 180 * 86_400_000;
/** lastUsedAt обновляем не чаще раза в час — не пишем в БД на каждый запрос. */
const TOUCH_EVERY_MS = 60 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Токен сессии: base64url, 43 символа (32 байта). */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Кто делает запрос: аккаунт EXBO и (если привязан) его Telegram. */
export interface Account {
  userId: string;
  login: string;
  /** Привязанный Telegram; null - алерты недоступны, пока не привяжут */
  chatId: bigint | null;
}

const ACCOUNT_SELECT = { id: true, login: true, chatId: true } as const;
const toAccount = (u: {
  id: string;
  login: string;
  chatId: bigint | null;
}) => ({
  userId: u.id,
  login: u.login,
  chatId: u.chatId,
});

/** Аккаунты сайта: сессии после входа через EXBO и привязка Telegram для алертов. */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly referrals: ReferralService,
  ) {}

  // ---------- сессии ----------

  async createSession(userId: string) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.accountSession.create({
      data: { tokenHash: sha256(token), userId },
    });
    return token;
  }

  async resolveSession(token: string): Promise<Account | null> {
    if (!SESSION_TOKEN_RE.test(token)) return null;
    const session = await this.prisma.accountSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: ACCOUNT_SELECT } },
    });
    if (!session) return null;

    const idle = Date.now() - session.lastUsedAt.getTime();
    if (idle > SESSION_IDLE_MS) {
      await this.prisma.accountSession.deleteMany({
        where: { id: session.id },
      });
      return null;
    }
    if (idle > TOUCH_EVERY_MS) {
      await this.prisma.accountSession.updateMany({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return toAccount(session.user);
  }

  async logout(token: string) {
    await this.prisma.accountSession.deleteMany({
      where: { tokenHash: sha256(token) },
    });
  }

  /** Мини-приложение: аккаунт, к которому привязан этот Telegram. */
  async byChat(chatId: bigint): Promise<Account | null> {
    const u = await this.prisma.user.findUnique({
      where: { chatId },
      select: ACCOUNT_SELECT,
    });
    return u && toAccount(u);
  }

  // ---------- Telegram ----------

  /**
   * Привязать Telegram к аккаунту. Telegram мог быть привязан к другому аккаунту -
   * переезжает (подтвердил в боте или вошёл из мини-приложения - значит, его).
   * Pro и пробный период, оплаченные на этот Telegram до аккаунта, переходят на аккаунт;
   * затем Pro и бан аккаунта копируются на чат.
   */
  async linkChat(userId: string, chatId: bigint) {
    await this.prisma.$transaction(async (tx) => {
      const chat = await tx.telegramSubscriber.upsert({
        where: { chatId },
        create: { chatId },
        update: {},
        include: { exboUser: { select: { id: true } } },
      });
      if (chat.exboUser?.id === userId) return;
      // сроки чата - собственные (оплата до аккаунта), только если он ни к кому не был привязан;
      // иначе это копия Pro прежнего аккаунта и переносить её нельзя
      const own = !chat.exboUser;

      if (chat.exboUser) {
        await tx.user.update({
          where: { id: chat.exboUser.id },
          data: { chatId: null },
        });
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          chatId: true,
          proUntil: true,
          trialUsedAt: true,
          bannedUntil: true,
          banReason: true,
        },
      });
      // прежний Telegram аккаунта больше не получает его Pro
      if (user.chatId) {
        await tx.telegramSubscriber.updateMany({
          where: { chatId: user.chatId },
          data: { proUntil: null },
        });
      }

      const latest = (a?: Date | null, b?: Date | null) =>
        a && b ? (a > b ? a : b) : (a ?? b ?? null);
      const proUntil = own
        ? latest(user.proUntil, chat.proUntil)
        : user.proUntil;
      const trialUsedAt = user.trialUsedAt ?? chat.trialUsedAt;
      const chatBanned =
        own && chat.bannedUntil && chat.bannedUntil > new Date();
      const bannedUntil = chatBanned
        ? latest(user.bannedUntil, chat.bannedUntil)
        : user.bannedUntil;
      const banReason = chatBanned
        ? (user.banReason ?? chat.banReason)
        : user.banReason;

      await tx.user.update({
        where: { id: userId },
        data: { chatId, proUntil, trialUsedAt, bannedUntil, banReason },
      });
      await tx.telegramSubscriber.update({
        where: { chatId },
        data: { proUntil, trialUsedAt, bannedUntil, banReason },
      });
    });
    this.logger.log(`Telegram привязан к аккаунту ${userId}`);
    // пришёл по реферальной ссылке — пробный другу и день Pro пригласившему
    await this.referrals
      .onLinked(userId, chatId)
      .catch((e: Error) => this.logger.error(`реферал: ${e.message}`, e.stack));
  }

  /** Отвязать Telegram: Pro аккаунта с чата снимается, алерты чата остаются (без Pro - в бесплатных лимитах). */
  async unlinkChat(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { chatId: true },
    });
    if (!user.chatId) return;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { chatId: null },
      }),
      this.prisma.telegramSubscriber.update({
        where: { chatId: user.chatId },
        data: { proUntil: null },
      }),
    ]);
  }

  /** Бан аккаунта (админ); копируется на привязанный Telegram, чтобы бот тоже молчал. */
  async setBan(userId: string, until: Date | null, reason: string | null) {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { bannedUntil: until, banReason: reason },
      select: { chatId: true },
    });
    if (u.chatId) {
      await this.prisma.telegramSubscriber.updateMany({
        where: { chatId: u.chatId },
        data: { bannedUntil: until, banReason: reason },
      });
    }
  }
}
