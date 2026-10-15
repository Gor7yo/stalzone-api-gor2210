import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AccountService } from './account.service';
import type { SubscriberInfo } from './alerts.service';
import { TelegramBotService } from './telegram-bot.service';

/** Сколько живёт код привязки: хватит открыть Telegram и нажать «Привязать». */
const CODE_TTL_MS = 10 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Формат кода в ссылке: base64url, 22 символа (16 байт). */
export const LINK_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Привязка Telegram к аккаунту (для алертов) через бота:
 * 1) аккаунт на сайте создаёт одноразовый код и открывает t.me/<бот>?start=link_<код>;
 * 2) пользователь подтверждает кнопкой в боте - чат сразу привязывается к аккаунту;
 * 3) сайт видит привязку в /api/me.
 * В БД лежит только хеш кода.
 */
@Injectable()
export class WebLinkService {
  private readonly logger = new Logger(WebLinkService.name);
  private botUsername?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly accounts: AccountService,
  ) {}

  async createCode(userId: string) {
    await this.prisma.telegramLinkCode.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const code = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.telegramLinkCode.create({
      data: { codeHash: sha256(code), userId, expiresAt },
    });
    const username = await this.username();
    return {
      url: `https://t.me/${username}?start=link_${code}`,
      expiresAt,
    };
  }

  /** Логин аккаунта, ждущего привязки по коду (для текста в боте); null - код устарел. */
  async pendingLogin(code: string) {
    const row = await this.prisma.telegramLinkCode.findUnique({
      where: { codeHash: sha256(code) },
    });
    if (!row?.userId || row.expiresAt < new Date()) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { login: true },
    });
    return user?.login ?? null;
  }

  /** Бот: пользователь подтвердил привязку. false - код просрочен, использован или не существует. */
  async confirm(code: string, from: SubscriberInfo) {
    const codeHash = sha256(code);
    const row = await this.prisma.telegramLinkCode.findUnique({
      where: { codeHash },
    });
    // код одноразовый: deleteMany вернёт 0, если параллельное нажатие успело раньше
    const { count } = await this.prisma.telegramLinkCode.deleteMany({
      where: { codeHash },
    });
    if (!row?.userId || !count || row.expiresAt < new Date()) return false;
    await this.accounts.linkChat(row.userId, BigInt(from.id));
    return true;
  }

  private async username() {
    this.botUsername ??= (
      await this.bot.call<{ username: string }>('getMe')
    ).username;
    return this.botUsername;
  }
}
