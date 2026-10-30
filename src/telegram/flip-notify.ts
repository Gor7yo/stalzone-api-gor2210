import type { Region } from 'src/api/dto/queries.dto';
import {
  type Confidence,
  type Flip,
  type FlipFilter,
  FLIP_WINDOW_DAYS,
  matchesFlip,
} from '../flipper/flip-filter';
import { variantLabel } from '../collector/module-stats';
import {
  escapeHtml,
  formatShort,
  lotUrl,
  QUALITY_LABEL,
  REGION_LABEL,
} from './format';
import type { InlineButton } from './telegram-bot.service';

/** О лоте из снимка старше этого не сообщаем: его, скорее всего, уже выкупили. */
export const FLIP_FRESH_MS = 15 * 60_000;
/** Сколько флипов показываем в одном сообщении. */
export const FLIPS_PER_MESSAGE = 5;

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '🟢 надёжно',
  medium: '🟡 средне',
  low: '🔴 рискованно',
};

/** Кандидаты в алерт: подходят под условия, лот свежий и о нём ещё не сообщали. */
export function newFlips(
  flips: Flip[],
  filter: FlipFilter,
  sent: ReadonlySet<string>,
  now = Date.now(),
) {
  return flips.filter(
    (f) =>
      !sent.has(f.key) &&
      now - new Date(f.seenAt).getTime() <= FLIP_FRESH_MS &&
      matchesFlip(f, filter),
  );
}

/**
 * Новые флипы для алерта (см. newFlips). Одинаковые лоты (предмет + качество + заточка) —
 * одной строкой, с самым выгодным. gone — лоты, которых в базе сборщика уже нет: о них
 * не пишем вовсе (лента бывает старше базы, и сообщение пришло бы сразу с «уже выкупили»).
 * keys — все подходящие ключи, и ушедшие тоже (их запоминаем, даже если в сообщение не влезли).
 */
export function pickNewFlips(
  flips: Flip[],
  filter: FlipFilter,
  sent: ReadonlySet<string>,
  now = Date.now(),
  gone: ReadonlySet<string> = new Set(),
) {
  const fresh = newFlips(flips, filter, sent, now);
  const best = new Map<string, { flip: Flip; lots: number }>();
  for (const f of fresh) {
    if (gone.has(f.key)) continue;
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

/** Только название предмета - его копируют в поиск аукциона в игре. */
export const flipName = (f: Flip) => f.name ?? `Предмет ${f.itemId}`;

/** «Редкий +15», «Редкий «Снайпер»», «×20»; пусто - у предмета нет ни качества, ни заточки. */
function flipVariant(f: Flip) {
  return [
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
}

/** «Висмут · Редкий +15», «Оружейный модуль · Редкий «Снайпер»» */
export function flipTitle(f: Flip) {
  const variant = flipVariant(f);
  return variant ? `${flipName(f)} · ${variant}` : flipName(f);
}

/** «2 лота», «5 лотов» */
const lotsWord = (n: number) =>
  n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
    ? 'лота'
    : 'лотов';

/** «уйдёт за ~3 ч», «уйдёт меньше чем за час»; null — дольше 48 ч, не пишем */
export function sellTimeLabel(hours: number | null) {
  if (hours === null) return null;
  return hours < 1
    ? 'уйдёт меньше чем за час'
    : `уйдёт за ~${Math.round(hours)} ч`;
}

/** Что стало с лотом из алерта: выкупили или время лота вышло. */
export type FlipGone = 'sold' | 'expired';

/** Цена лота словами для зачёркнутой строки: «4,5кк», «120к (6к/шт)». */
const lotPrice = (f: { buyout: number; unitPrice: number; amount: number }) =>
  `<b>${formatShort(f.buyout)}</b>${f.amount > 1 ? ` (${formatShort(f.unitPrice)}/шт)` : ''}`;

/** Пометка ушедшего лота - с ценой: «⛔ выкупили за 4,5кк», «⌛ время лота вышло, выкуп был 4,5кк». */
export function goneLabel(
  status: FlipGone,
  lot: { buyout: number; unitPrice: number; amount: number },
) {
  return status === 'sold'
    ? `⛔ выкупили за ${lotPrice(lot)}`
    : `⌛ время лота вышло, выкуп был ${lotPrice(lot)}`;
}

type Offers = ReturnType<typeof pickNewFlips>['offers'];

/**
 * Сообщение флип-алерта. gone — лоты, которых на рынке уже нет (по ключу флипа):
 * их строка зачёркнута с пометкой и ценой. Новых сообщений об этом не шлём -
 * правим это же (правка в Telegram приходит без уведомления).
 */
export function flipMessage(
  region: Region,
  offers: Offers,
  gone: ReadonlyMap<string, FlipGone> = new Map(),
) {
  const shown = offers.slice(0, FLIPS_PER_MESSAGE);
  const lines = [
    `💰 <b>${offers.length === 1 ? 'Новый флип' : 'Новые флипы'}</b> · ${REGION_LABEL[region] ?? region}`,
    '',
    ...shown.flatMap(({ flip: f, lots }) => {
      const title = `<b>${escapeHtml(flipTitle(f))}</b>${lots > 1 ? ` (${lots} ${lotsWord(lots)})` : ''}`;
      const status = gone.get(f.key);
      // ушедший лот — одной зачёркнутой строкой с ценой, остальное уже не нужно
      if (status) return [`<s>${title}</s> · ${goneLabel(status, f)}`, ''];
      return flipLines(f, title);
    }),
  ];
  if (offers.length > shown.length) {
    lines.push(`…и ещё ${offers.length - shown.length} - во флиппере`);
  }
  return lines.join('\n').trim();
}

/** Обрезаем длинное название на кнопке (Telegram сам обрежет, но некрасиво - посередине). */
const short = (s: string, max = 28) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * Кнопки флип-алерта: на каждый лот, который ещё на рынке, - «скопировать название»
 * (в поиск аукциона в игре) и страница предмета на сайте с его качеством и заточкой;
 * снизу - флиппер и «Отключить». Ушедшие лоты своих кнопок лишаются при правке.
 */
export function flipButtons(
  site: string,
  region: Region,
  offers: Offers,
  gone: ReadonlyMap<string, FlipGone> = new Map(),
  flipper = `${site}/flips`,
): InlineButton[][] {
  const single = offers.length === 1;
  const rows: InlineButton[][] = offers
    .slice(0, FLIPS_PER_MESSAGE)
    .filter(({ flip: f }) => !gone.has(f.key))
    .map(({ flip: f }) => [
      {
        text: single ? '📋 Скопировать название' : `📋 ${short(flipName(f))}`,
        copy_text: { text: flipName(f) },
      },
      {
        text: single
          ? '🌐 На сайте'
          : `🌐 ${short(flipVariant(f) || 'На сайте')}`,
        url: lotUrl(site, f),
      },
    ]);
  rows.push([
    { text: 'Открыть флиппер', url: flipper },
    { text: 'Отключить', callback_data: `fdel:${region}` },
  ]);
  return rows;
}

function flipLines(f: Flip, title: string) {
  return [
    title,
    `выкуп ${formatShort(f.unitPrice)} → ~${formatShort(f.sellUnit)}${f.amount > 1 ? ' /шт' : ''} · <b>+${formatShort(f.profit)}</b> (${f.pct.toLocaleString('ru-RU')} %)`,
    [
      CONFIDENCE_LABEL[f.confidence],
      `${f.deals} сделок за ${FLIP_WINDOW_DAYS} дня`,
      sellTimeLabel(f.sellHours),
    ]
      .filter(Boolean)
      .join(' · '),
    '',
  ];
}
