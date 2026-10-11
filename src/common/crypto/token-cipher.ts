import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Шифрование OAuth-токенов игроков перед записью в БД (AES-256-GCM).
 * Утечка базы не даёт доступа к аккаунтам EXBO без ключа из .env.
 * Формат: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
@Injectable()
export class TokenCipher {
  private readonly key?: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('TOKEN_ENCRYPTION_KEY');
    this.key = raw ? Buffer.from(raw, 'base64') : undefined;
  }

  encrypt(plain: string): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string): string {
    const key = this.requireKey();
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !data)
      throw new Error('Неизвестный формат токена');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new InternalServerErrorException(
        'TOKEN_ENCRYPTION_KEY не задан — вход через EXBO отключён (openssl rand -base64 32)',
      );
    }
    return this.key;
  }
}
