import { Injectable } from '@nestjs/common';
import { TokenCipher } from 'src/common/crypto/token-cipher';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalzoneUser } from 'src/stalzone/oauth/stalzone-oauth.service';

interface TokenCredentials {
  accessToken: string;
  refreshToken: string;
  /** срок жизни access-токена в секундах (как отдаёт EXBO) */
  expiresIn: number;
}

/** Поля пользователя, которые безопасно отдавать наружу. */
const PUBLIC_USER = {
  id: true,
  uuid: true,
  login: true,
  stalzoneId: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
  ) {}

  /** Создаёт пользователя при первом входе или обновляет логин/дистрибьютора при повторном. */
  upsertFromStalzone(user: StalzoneUser) {
    const data = {
      uuid: user.uuid,
      login: user.login,
      distributor: user.distributor,
      distributor_id: user.distributor_id,
    };
    return this.prisma.user.upsert({
      where: { stalzoneId: user.id },
      create: { ...data, stalzoneId: user.id },
      update: data,
      select: PUBLIC_USER,
    });
  }

  async saveStalzoneTokens(userId: string, tokens: TokenCredentials) {
    const data = {
      accessToken: this.cipher.encrypt(tokens.accessToken),
      refreshToken: this.cipher.encrypt(tokens.refreshToken),
      // храним момент истечения (unix-секунды), а не длительность
      expiresAt: Math.floor(Date.now() / 1000) + Number(tokens.expiresIn || 0),
    };
    await this.prisma.stalzoneAccount.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
}
