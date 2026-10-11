import { createHash, randomBytes } from 'node:crypto';
import { GoneException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type { SubscriberInfo } from './alerts.service';
import { TelegramBotService } from './telegram-bot.service';

/** Сколько живёт код привязки: хватит открыть Telegram и нажать «Подтвердить». */
const CODE_TTL_MS = 5 * 60_000;
/** Сессию сайта, которой не пользовались полгода, считаем брошенной. */
const SESSION_IDLE_MS = 180 * 86_400_000;
/** lastUsedAt обновляем не чаще раза в час — не пишем в БД на каждый запрос. */
const TOUCH_EVERY_MS = 60 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes: number) => randomBytes(bytes).toString('base64url');

/** Формат кода в ссылке: base64url, 22 символа (16 байт). */
export const LINK_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Привязка сайта (обычного браузера) к Telegram без логина и пароля:
 * 1) сайт создаёт одноразовый код и открывает t.me/<бот>?start=link_<код>;
 * 2) пользователь подтверждает привязку кнопкой в боте;
 * 3) сайт, опрашивая claim(), получает токен сессии.
 * В БД лежат только хеши кода и токена.
 */
@Injectable()
export class WebLinkService {
  private readonly logger = new Logger(WebLinkService.name);
  private botUsername?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  async createCode() {
    await this.prisma.telegramLinkCode.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const code = token(16);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.telegramLinkCode.create({
      data: { codeHash: sha256(code), expiresAt },
    });
    const username = await this.username();
    return {
      code,
      url: `https://t.me/${username}?start=link_${code}`,
      expiresAt,
    };
  }

  /** Бот: пользователь подтвердил привязку. false — код просрочен или не существует. */
  async confirm(code: string, user: SubscriberInfo) {
    const { count } = await this.prisma.telegramLinkCode.updateMany({
      where: {
        codeHash: sha256(code),
        chatId: null,
        expiresAt: { gt: new Date() },
      },
      data: { chatId: BigInt(user.id) },
    });
    return count > 0;
  }

  /** Сайт: забрать сессию по подтверждённому коду. Код одноразовый — после выдачи удаляется. */
  async claim(code: string) {
    const codeHash = sha256(code);
    const row = await this.prisma.telegramLinkCode.findUnique({
      where: { codeHash },
    });
    if (!row || row.expiresAt < new Date()) {
      throw new GoneException('Код привязки устарел — начните заново');
    }
    if (row.chatId === null) return { status: 'pending' as const };

    // deleteMany вернёт 0, если параллельный запрос успел забрать код раньше
    const { count } = await this.prisma.telegramLinkCode.deleteMany({
      where: { codeHash },
    });
    if (!count) throw new GoneException('Код привязки уже использован');

    const sessionToken = token(32);
    await this.prisma.webSession.create({
      data: { tokenHash: sha256(sessionToken), chatId: row.chatId },
    });
    const user = await this.prisma.telegramSubscriber.findUnique({
      where: { chatId: row.chatId },
      select: { firstName: true, username: true },
    });
    this.logger.log(`Сайт привязан к Telegram-чату ${row.chatId}`);
    return { status: 'linked' as const, token: sessionToken, user };
  }

  /** Пользователь Telegram по токену сессии сайта (или null). */
  async resolve(sessionToken: string): Promise<SubscriberInfo | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const session = await this.prisma.webSession.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { subscriber: { select: { firstName: true, username: true } } },
    });
    if (!session) return null;

    const idle = Date.now() - session.lastUsedAt.getTime();
    if (idle > SESSION_IDLE_MS) {
      await this.prisma.webSession.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (idle > TOUCH_EVERY_MS) {
      await this.prisma.webSession.updateMany({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return {
      id: Number(session.chatId),
      first_name: session.subscriber.firstName ?? undefined,
      username: session.subscriber.username ?? undefined,
    };
  }

  async logout(sessionToken: string) {
    await this.prisma.webSession.deleteMany({
      where: { tokenHash: sha256(sessionToken) },
    });
  }

  private async username() {
    this.botUsername ??= (
      await this.bot.call<{ username: string }>('getMe')
    ).username;
    return this.botUsername;
  }
}
