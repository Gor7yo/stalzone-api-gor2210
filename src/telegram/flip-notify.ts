import type { Region } from 'src/api/dto/queries.dto';
import {
  type Confidence,
  type Flip,
  type FlipFilter,
  FLIP_WINDOW_DAYS,
  matchesFlip,
} from '../flipper/flip-filter';
import { variantLabel } from '../collector/module-stats';
import { escapeHtml, formatShort, QUALITY_LABEL, REGION_LABEL } from './format';

/** О лоте из снимка старше этого не сообщаем: его, скорее всего, уже выкупили. */
export const FLIP_FRESH_MS = 15 * 60_000;
/** Сколько флипов показываем в одном сообщении. */
export const FLIPS_PER_MESSAGE = 5;

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '🟢 надёжно',
  medium: '🟡 средне',
  low: '🔴 рискованно',
};

/**
 * Новые флипы для алерта: подходят под условия, лот свежий и о нём ещё не сообщали.
 * Одинаковые лоты (предмет + качество + заточка) — одной строкой, с самым выгодным.
 * keys — все подходящие ключи (их запоминаем, даже если в сообщение не влезли).
 */
export function pickNewFlips(
  flips: Flip[],
  filter: FlipFilter,
  sent: ReadonlySet<string>,
  now = Date.now(),
) {
  const fresh = flips.filter(
    (f) =>
      !sent.has(f.key) &&
      now - new Date(f.seenAt).getTime() <= FLIP_FRESH_MS &&
      matchesFlip(f, filter),
  );
  const best = new Map<string, { flip: Flip; lots: number }>();
  for (const f of fresh) {
    const variant = `${f.itemId}|${f.quality}|${f.upgrade}|${f.variant ?? ''}`;
    const cur = best.get(variant);
    if (!cur) best.set(variant, { flip: f, lots: 1 });
    else {
      cur.lots++;
      if (f.profit > cur.flip.profit) cur.flip = f;
    }
  }
  return {
    keys: fresh.map((f) => f.key),
    offers: [...best.values()].sort((a, b) => b.flip.profit - a.flip.profit),
  };
}

/** «Висмут · Редкий +15», «Оружейный модуль · Редкий «Снайпер»» */
export function flipTitle(f: Flip) {
  const variant = [
    f.quality >= 0 ? QUALITY_LABEL[f.quality] : null,
    f.variant
      ? variantLabel(f.variant)
      : f.upgrade > 0 || f.quality >= 0
        ? `+${f.upgrade}`
        : null,
    f.amount > 1 ? `×${f.amount}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const name = f.name ?? `Предмет ${f.itemId}`;
  return variant ? `${name} · ${variant}` : name;
}

export function flipMessage(
  region: Region,
  offers: ReturnType<typeof pickNewFlips>['offers'],
) {
  const shown = offers.slice(0, FLIPS_PER_MESSAGE);
  const lines = [
    `💰 <b>${offers.length === 1 ? 'Новый флип' : 'Новые флипы'}</b> · ${REGION_LABEL[region] ?? region}`,
    '',
    ...shown.flatMap(({ flip: f, lots }) => [
      `<b>${escapeHtml(flipTitle(f))}</b>${lots > 1 ? ` (${lots} лота)` : ''}`,
      `выкуп ${formatShort(f.unitPrice)} → ~${formatShort(f.sellUnit)}${f.amount > 1 ? ' /шт' : ''} · <b>+${formatShort(f.profit)}</b> (${f.pct.toLocaleString('ru-RU')} %)`,
      `${CONFIDENCE_LABEL[f.confidence]} · ${f.deals} сделок за ${FLIP_WINDOW_DAYS} дня`,
      '',
    ]),
  ];
  if (offers.length > shown.length) {
    lines.push(`…и ещё ${offers.length - shown.length} — во флиппере`);
  }
  return lines.join('\n').trim();
}
