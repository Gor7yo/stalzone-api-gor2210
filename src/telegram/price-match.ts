import type { AuctionItemLotsResponse } from 'src/api/api.constants';
import { variantOf } from '../collector/variant';
import type { FlipGone } from './flip-notify';
import { escapeHtml, formatPrice, formatShort } from './format';

type Lot = AuctionItemLotsResponse['lots'][number];

export interface AlertCriteria {
  /** Одно качество (старые алерты) */
  quality: number | null;
  /** Набор качеств; если не пуст — главнее quality */
  qualities?: number[];
  /** Один уровень заточки (старые алерты) */
  upgrade: number | null;
  /** Набор уровней заточки; если не пуст — главнее upgrade */
  upgrades?: number[];
  /** Ключевая характеристика модуля; пусто — любая */
  variant?: string;
  maxPrice: number;
  lastLotKey: string | null;
  lastNotifiedAt: Date | null;
}

/** Повторно о другом лоте по той же цене — не чаще раза в 30 минут. */
export const RENOTIFY_MS = 30 * 60_000;

export const unitPrice = (lot: Pick<Lot, 'buyoutPrice' | 'amount'>) =>
  lot.buyoutPrice > 0 ? lot.buyoutPrice / Math.max(1, lot.amount) : 0;

/** Как во фронтенде: qlt — качество 0–5, ptn — заточка (поля нет → +0). */
export const qualityOf = (lot: Lot) =>
  typeof lot.additional?.qlt === 'number' ? lot.additional.qlt : null;
export const upgradeOf = (lot: Lot) =>
  typeof lot.additional?.ptn === 'number' ? lot.additional.ptn : 0;

/** Ключ лота: startTime + цена выкупа + количество (у лота нет своего id в API). */
export const lotKey = (lot: Lot) =>
  `${lot.startTime}|${lot.buyoutPrice}|${lot.amount}|${unitPrice(lot)}`;
const priceFromKey = (key: string) => Number(key.split('|')[3]);

/** Самый дешёвый (за штуку) лот с выкупом, подходящий под качество, заточку и характеристику алерта. */
export function cheapestMatching(lots: Lot[], alert: AlertCriteria) {
  let best: Lot | null = null;
  for (const lot of lots) {
    const price = unitPrice(lot);
    if (!price) continue;
    const q = qualityOf(lot);
    if (alert.qualities?.length) {
      if (q === null || !alert.qualities.includes(q)) continue;
    } else if (alert.quality !== null && q !== alert.quality) continue;
    const u = upgradeOf(lot);
    if (alert.upgrades?.length) {
      if (!alert.upgrades.includes(u)) continue;
    } else if (alert.upgrade !== null && u !== alert.upgrade) continue;
    if (alert.variant && variantOf(lot.additional) !== alert.variant) continue;
    if (!best || price < unitPrice(best)) best = lot;
  }
  return best;
}

/**
 * Решение по алерту: прислать уведомление о лоте, сбросить память (подходящих лотов нет)
 * или ничего не делать (об этом лоте уже сообщали / недавно сообщали о такой же цене).
 */
export function decide(
  lots: Lot[],
  alert: AlertCriteria,
  now = Date.now(),
):
  | { action: 'notify'; lot: Lot; key: string }
  | { action: 'reset' }
  | { action: 'none' } {
  const lot = cheapestMatching(lots, alert);
  if (!lot || unitPrice(lot) > alert.maxPrice) {
    return alert.lastLotKey ? { action: 'reset' } : { action: 'none' };
  }

  const key = lotKey(lot);
  if (key === alert.lastLotKey) return { action: 'none' };

  // другой лот: шлём, если он дешевле прошлого или прошло достаточно времени
  const cheaper =
    !alert.lastLotKey || unitPrice(lot) < priceFromKey(alert.lastLotKey);
  const stale =
    !alert.lastNotifiedAt ||
    now - alert.lastNotifiedAt.getTime() >= RENOTIFY_MS;
  return cheaper || stale ? { action: 'notify', lot, key } : { action: 'none' };
}

/**
 * Сообщение алерта по цене. gone - лот ушёл с рынка: сообщение правим (без нового
 * уведомления), название зачёркнуто, цена лота остаётся.
 */
export function priceMessage(
  title: string,
  region: string,
  maxPrice: number,
  lot: Pick<Lot, 'amount' | 'buyoutPrice'>,
  gone?: FlipGone,
) {
  const price = `<b>${formatShort(unitPrice(lot))}</b>${lot.amount > 1 ? ' / шт.' : ''}`;
  const threshold = formatShort(maxPrice);
  return [
    gone
      ? `🔔 <s>${escapeHtml(title)}</s> · ${region}`
      : `🔔 <b>${escapeHtml(title)}</b> · ${region}`,
    gone === 'sold'
      ? `⛔ Выкупили за ${price} (порог ${threshold})`
      : gone === 'expired'
        ? `⌛ Время лота вышло, выкуп был ${price} (порог ${threshold})`
        : `Лот за ${price} - порог ${threshold}`,
    lot.amount > 1
      ? `${lot.amount} шт. · выкуп ${formatPrice(lot.buyoutPrice)}`
      : `Выкуп ${formatPrice(lot.buyoutPrice)}`,
  ].join('\n');
}
