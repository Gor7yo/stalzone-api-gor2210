import type { Region } from 'src/api/dto/queries.dto';
import { variantLabel } from '../collector/module-stats';

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

/** Уровни заточки подряд сворачиваем: [1, 3, 4, 5] → «+1, +3…+5» (как во фронтенде). */
export function upgradesLabel(levels: number[]) {
  const runs: [number, number][] = [];
  for (const l of [...levels].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else runs.push([l, l]);
  }
  return runs.map(([a, b]) => (a === b ? `+${a}` : `+${a}…+${b}`)).join(', ');
}

/** «Комета · Легендарный +10», «Комета · Особый, Редкий +1, +5…+7», «Модуль «Снайпер» · Редкий» */
export function alertTitle(a: {
  itemName: string;
  quality: number | null;
  qualities?: number[];
  upgrade: number | null;
  upgrades?: number[];
  variant?: string;
}) {
  const name = a.variant
    ? `${a.itemName} ${variantLabel(a.variant)}`
    : a.itemName;
  const qualities = a.qualities?.length
    ? a.qualities
    : a.quality !== null
      ? [a.quality]
      : [];
  const quality = qualities.length
    ? qualities.map((q) => QUALITY_LABEL[q]).join(', ')
    : null;
  const levels = a.upgrades?.length
    ? a.upgrades
    : a.upgrade !== null
      ? [a.upgrade]
      : [];
  const upgrade = levels.length ? upgradesLabel(levels) : null;
  const variant = [quality, upgrade].filter(Boolean).join(' ');
  return variant ? `${name} · ${variant}` : name;
}

/** Диплинк t.me/<bot>/<app>?startapp=<путь в base64url> — формат как во фронтенде (lib/telegram.ts). */
export function deepLink(appUrl: string | undefined, path: string) {
  if (!appUrl) return undefined;
  return `${appUrl}?startapp=${Buffer.from(path).toString('base64url')}`;
}
