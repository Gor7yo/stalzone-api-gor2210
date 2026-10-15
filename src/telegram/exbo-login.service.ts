import { createHash, randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  GoneException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  StalzoneOAuthService,
  type StalzoneTokenResponse,
  type StalzoneUser,
} from 'src/stalzone/oauth/stalzone-oauth.service';
import { UsersService } from 'src/users/users.service';
import { AccountService } from './account.service';

/** Сколько живёт state: хватит войти в EXBO и подтвердить доступ. */
const STATE_TTL_MS = 10 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Вход через EXBO (основной аккаунт):
 * 1) сайт просит ссылку входа; из мини-приложения state запоминает Telegram;
 * 2) игрок входит в EXBO, EXBO возвращает на страницу сайта с code и state;
 * 3) страница отдаёт их в complete(): аккаунт создаётся/обновляется, выдаётся сессия сайта,
 *    Telegram из мини-приложения привязывается к аккаунту.
 * Сайт дополнительно сверяет state со своим (localStorage) - чужую ссылку входа не подсунуть.
 */
@Injectable()
export class ExboLoginService {
  private readonly logger = new Logger(ExboLoginService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: StalzoneOAuthService,
    private readonly users: UsersService,
    private readonly accounts: AccountService,
  ) {}

  async start(chatId: bigint | null) {
    await this.prisma.exboLinkState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const state = randomBytes(16).toString('base64url');
    await this.prisma.exboLinkState.create({
      data: {
        stateHash: sha256(state),
        chatId,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    return { state, url: this.oauth.getAuthorizationUrl(state) };
  }

  async complete(code: string, state: string) {
    const stateHash = sha256(state);
    const saved = await this.prisma.exboLinkState.findUnique({
      where: { stateHash },
    });
    // state одноразовый: удаляем сразу; count 0 - его уже использовал параллельный запрос
    const { count } = await this.prisma.exboLinkState.deleteMany({
      where: { stateHash },
    });
    if (!saved || !count || saved.expiresAt < new Date()) {
      throw new GoneException('Ссылка входа устарела - войдите заново');
    }

    let token: StalzoneTokenResponse;
    let exbo: StalzoneUser;
    try {
      token = await this.oauth.exchangeCode(code);
      exbo = await this.oauth.getUser(token.access_token);
    } catch {
      // детали ответа EXBO уже в логе (без тела) - наружу только понятный текст
      throw new BadGatewayException(
        'EXBO не подтвердил вход - попробуйте ещё раз',
      );
    }
    const userId = await this.users.upsertFromExbo(exbo, token);
    if (saved.chatId != null)
      await this.accounts.linkChat(userId, saved.chatId);
    this.logger.log(`Вход через EXBO: ${exbo.login}`);
    return {
      token: await this.accounts.createSession(userId),
      login: exbo.login,
    };
  }
}
