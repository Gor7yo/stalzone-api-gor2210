/**
 * Проверка переменных окружения при старте: сервер не поднимется
 * с неполным .env и сразу скажет, чего не хватает.
 */
const REQUIRED = [
  'STALZONE_CLIENT_ID',
  'STALZONE_CLIENT_SECRET',
  'STALZONE_OAUTH_URL',
  'STALZONE_API_URL',
] as const;

const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';

export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED.filter((key) => !str(config[key]).trim());
  if (missing.length) {
    throw new Error(`В .env не заданы: ${missing.join(', ')}`);
  }

  for (const key of ['STALZONE_OAUTH_URL', 'STALZONE_API_URL']) {
    const value = str(config[key]);
    if (!/^https:\/\//.test(value)) {
      throw new Error(`${key} должен начинаться с https:// (сейчас: ${value})`);
    }
  }

  const port = Number(config.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `PORT должен быть числом 1–65535 (сейчас: ${str(config.PORT)})`,
    );
  }

  const key = str(config.TOKEN_ENCRYPTION_KEY);
  if (key && Buffer.from(key, 'base64').length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY должен быть 32 байта в base64 (сгенерировать: openssl rand -base64 32)',
    );
  }

  return { ...config, PORT: port };
}

/** CORS_PATHS="https://a.com,https://b.com" → массив origin'ов. */
export function corsOrigins(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length ? list : ['http://localhost:3000'];
}
