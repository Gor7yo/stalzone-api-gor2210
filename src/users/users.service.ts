import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { REGIONS } from 'src/api/dto/queries.dto';
import { TokenCipher } from 'src/common/crypto/token-cipher';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  StalcraftApiClient,
  UserTokenRevokedError,
} from 'src/stalzone/api/stalcraft-api.client';
import {
  StalzoneOAuthService,
  type StalzoneTokenResponse,
  type StalzoneUser,
} from 'src/stalzone/oauth/stalzone-oauth.service';
import { type ExboCharacter, parseCharacters } from './exbo-characters';

/** Токен игрока живёт год; обновляем, когда до конца осталось меньше недели. */
const REFRESH_BEFORE_S = 7 * 86_400;

/** Персонажи аккаунта EXBO - как их видит сайт. */
export interface ExboCharactersView {
  characters: ExboCharacter[];
  charactersAt: string | null;
  /** EXBO отозвал доступ - персонажи не обновятся, пока игрок не войдёт заново */
  revoked: boolean;
}

/** Аккаунты EXBO игроков: вход, токены (зашифрованы) и персонажи. */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly oauth: StalzoneOAuthService,
    private readonly api: StalcraftApiClient,
  ) {}

  /** Вход через EXBO завершён: аккаунт создаётся или обновляется, токены сохраняются. */
  async upsertFromExbo(user: StalzoneUser, token: StalzoneTokenResponse) {
    const data = {
      uuid: user.uuid,
      login: user.login,
      distributor: user.distributor,
      distributor_id: user.distributor_id,
    };
    const tokens = this.encryptTokens(token);
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.upsert({
        where: { stalzoneId: user.id },
        create: { ...data, stalzoneId: user.id },
        update: data,
        select: { id: true },
      });
      await tx.stalzoneAccount.upsert({
        where: { userId: row.id },
        create: { userId: row.id, ...tokens },
        update: tokens,
      });
      return row;
    });
    await this.syncCharacters(saved.id).catch((error: unknown) =>
      this.logger.warn(`Персонажи EXBO не загрузились: ${String(error)}`),
    );
    return saved.id;
  }

  async charactersOf(userId: string): Promise<ExboCharactersView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        characters: true,
        charactersAt: true,
        stalzoneAccount: { select: { expiresAt: true } },
      },
    });
    return {
      characters: (user.characters as ExboCharacter[] | null) ?? [],
      charactersAt: user.charactersAt?.toISOString() ?? null,
      revoked: !user.stalzoneAccount,
    };
  }

  /** Перечитать персонажей из EXBO. false - доступ отозван, нужен повторный вход. */
  async syncCharacters(userId: string) {
    const token = await this.accessToken(userId);
    if (!token) return false;

    const characters: ExboCharacter[] = [];
    try {
      for (const region of REGIONS) {
        const data = await this.api.getAsUser<unknown>(
          [region, 'characters'],
          token,
        );
        characters.push(...parseCharacters(region, data));
      }
    } catch (error) {
      if (!(error instanceof UserTokenRevokedError)) throw error;
      // токен отозван в EXBO: забываем его, персонажи остаются до повторного входа
      await this.prisma.stalzoneAccount.deleteMany({ where: { userId } });
      return false;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        characters: characters as unknown as Prisma.InputJsonValue,
        charactersAt: new Date(),
      },
    });
    return true;
  }

  /** Действующий токен игрока (с обновлением по refresh_token); null - токена нет. */
  private async accessToken(userId: string) {
    const account = await this.prisma.stalzoneAccount.findUnique({
      where: { userId },
    });
    if (!account) return null;

    const now = Math.floor(Date.now() / 1000);
    if (account.expiresAt - REFRESH_BEFORE_S > now) {
      return this.cipher.decrypt(account.accessToken);
    }
    const refresh = account.refreshToken
      ? this.cipher.decrypt(account.refreshToken)
      : '';
    if (!refresh) return null;
    try {
      const token = await this.oauth.refreshUserToken(refresh);
      await this.prisma.stalzoneAccount.update({
        where: { userId },
        data: this.encryptTokens({
          ...token,
          refresh_token: token.refresh_token ?? refresh,
        }),
      });
      return token.access_token;
    } catch {
      await this.prisma.stalzoneAccount.deleteMany({ where: { userId } });
      return null;
    }
  }

  private encryptTokens(token: StalzoneTokenResponse) {
    return {
      accessToken: this.cipher.encrypt(token.access_token),
      refreshToken: this.cipher.encrypt(token.refresh_token ?? ''),
      // храним момент истечения (unix-секунды), а не длительность
      expiresAt: Math.floor(Date.now() / 1000) + Number(token.expires_in ?? 0),
    };
  }
}
