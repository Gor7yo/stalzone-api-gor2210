import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
}

/** initData старше суток не принимаем — защита от повторного использования утёкшей строки. */
export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Проверка подписи initData мини-приложения:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Возвращает пользователя Telegram или null, если строка подделана/устарела.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  now = Math.floor(Date.now() / 1000),
): TelegramUser | null {
  if (!initData || initData.length > 4096) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now - authDate > INIT_DATA_MAX_AGE_SEC)
    return null;

  try {
    const user = JSON.parse(params.get('user') ?? '') as TelegramUser;
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}
