import type { Region } from 'src/api/dto/queries.dto';

export const REGION_LABEL: Record<Region, string> = {
  ru: 'RU',
  eu: 'EU',
  na: 'NA',
  sea: 'SEA',
};

/** Совпадает с QUALITY во фронтенде (additional.qlt 0–5). */
export const QUALITY_LABEL = [
  'Обычный',
  'Необычный',
  'Особый',
  'Редкий',
  'Исключительный',
  'Легендарный',
];

const nf = new Intl.NumberFormat('ru-RU');

export const formatPrice = (value: number) =>
  `${nf.format(Math.round(value))} ₽`;

/** Игровой формат: 14 800 → «14,8к», 3 500 000 → «3,5кк». */
export function formatShort(value: number) {
  const fmt = (n: number) =>
    n.toLocaleString('ru-RU', { maximumFractionDigits: n < 100 ? 1 : 0 });
  if (value >= 1_000_000) return `${fmt(value / 1_000_000)}кк`;
  if (value >= 1_000) return `${fmt(value / 1_000)}к`;
  return fmt(value);
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** «Комета · Легендарный +10» */
export function alertTitle(a: {
  itemName: string;
  quality: number | null;
  upgrade: number | null;
}) {
  const variant = [
    a.quality !== null ? QUALITY_LABEL[a.quality] : null,
    a.upgrade !== null ? `+${a.upgrade}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return variant ? `${a.itemName} · ${variant}` : a.itemName;
}

/** Диплинк t.me/<bot>/<app>?startapp=<путь в base64url> — формат как во фронтенде (lib/telegram.ts). */
export function deepLink(appUrl: string | undefined, path: string) {
  if (!appUrl) return undefined;
  return `${appUrl}?startapp=${Buffer.from(path).toString('base64url')}`;
}
