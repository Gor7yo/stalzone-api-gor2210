// Помощник продажи: по какой цене выставить лот, чтобы он ушёл за N часов. Без зависимостей (тесты).

/**
 * Модель очереди: покупатели берут самые дешёвые лоты, так что лот продастся, когда
 * выкупят всё, что дешевле него. За час рынок выкупает ratePerHour штук позиции
 * (средняя скорость сделок за окно), но по цене P — только доля покупателей,
 * готовых столько платить (demandShare: оцениваем по ценам прошлых сделок).
 * Часть спроса уходит на лоты, которые выставят после нас дешевле, —
 * поэтому от скорости берём COMPETITION.
 */
export const COMPETITION = 0.7;
/** Сроки, для которых даём цену, ч. Дольше 48 ч лот на аукционе не живёт. */
export const SELL_TARGETS = [1, 6, 24, 48] as const;
export const MAX_LOT_HOURS = 48;

/** Лот на рынке: цена за штуку и сколько штук. */
export interface LadderStep {
  unit: number;
  amount: number;
}

/** Цены сделок за штуку за окно. */
export interface SalePrices {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface SellMarket {
  /** Лоты позиции, по возрастанию цены за штуку */
  ladder: LadderStep[];
  /** Сколько штук позиции покупают в час */
  ratePerHour: number;
  sales: SalePrices;
}

/** Шаг цены: от 1 ₽ у дешёвых предметов до 1000 ₽ у дорогих. */
export const priceStep = (price: number) =>
  price < 1_000 ? 1 : price < 100_000 ? 10 : price < 10_000_000 ? 100 : 1_000;

/** Ближайшая «круглая» цена строго ниже price — перебить лот. */
export const undercut = (price: number) => {
  const step = priceStep(price);
  return Math.max(1, Math.ceil(price / step) * step - step);
};

/** Округлить вниз до шага цены. */
const roundDown = (price: number) => {
  const step = priceStep(price);
  return Math.max(1, Math.floor(price / step) * step);
};

/** Сколько штук на рынке выкупят раньше лота по этой цене (такие же по цене — выставлены раньше). */
export const unitsAhead = (ladder: LadderStep[], price: number) =>
  ladder.reduce((n, l) => (l.unit <= price ? n + l.amount : n), 0);

/** Точки кривой «цена → доля сделок не дешевле» по перцентилям. */
const curve = (s: SalePrices): [number, number][] => [
  [s.p10, 0.9],
  [s.p25, 0.75],
  [s.median, 0.5],
  [s.p75, 0.25],
  [s.p90, 0.1],
];

/**
 * Доля покупателей, готовых заплатить price: 1 — дешевле почти всех сделок, 0 — дороже всех.
 * Между перцентилями — линейно, за краями — продолжение крайних отрезков до 1 и 0.
 */
export function demandShare(s: SalePrices, price: number): number {
  const pts = curve(s);
  const lerp = ([x0, y0]: [number, number], [x1, y1]: [number, number]) =>
    x1 > x0
      ? y0 + ((price - x0) / (x1 - x0)) * (y1 - y0)
      : price < x1
        ? y0
        : y1;
  let y: number;
  if (price <= pts[0][0]) y = lerp(pts[0], pts[1]);
  else if (price >= pts[4][0]) y = lerp(pts[3], pts[4]);
  else {
    const i = pts.findIndex(([x]) => x > price);
    y = lerp(pts[i - 1], pts[i]);
  }
  return Math.min(1, Math.max(0, y));
}

/** Самая высокая цена, при которой доля готовых платить не ниже share. */
function priceForShare(s: SalePrices, share: number): number {
  const pts = curve(s);
  // за краями — продолжение крайних отрезков (как в demandShare)
  const seg = (a: [number, number], b: [number, number]) =>
    a[1] === b[1]
      ? a[0]
      : a[0] + ((share - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
  if (share >= pts[0][1]) return seg(pts[0], pts[1]);
  if (share <= pts[4][1]) return seg(pts[3], pts[4]);
  const i = pts.findIndex(([, y]) => y < share);
  return seg(pts[i - 1], pts[i]);
}

/**
 * Примерное время продажи amount штук по цене price, ч; null — вряд ли продастся
 * за срок жизни лота.
 */
export function hoursToSell(
  m: SellMarket,
  price: number,
  amount = 1,
): number | null {
  const rate = m.ratePerHour * COMPETITION * demandShare(m.sales, price);
  if (rate <= 0) return null;
  const hours = (unitsAhead(m.ladder, price) + amount) / rate;
  return hours > MAX_LOT_HOURS ? null : hours;
}

/** Прибыль в час считаем минимум за полчаса: выставить лот тоже занимает время. */
export const MIN_FLIP_HOURS = 0.5;

/**
 * Флип: за сколько часов перепродать купленное по медиане и сколько это прибыли в час.
 * hours: null — вряд ли продастся за срок жизни лота (тогда и в час не считаем).
 */
export function flipTiming(m: SellMarket, amount: number, profit: number) {
  const hours = hoursToSell(m, m.sales.median, amount);
  if (hours === null) return { hours: null, perHour: null };
  return {
    hours: Math.round(hours * 10) / 10,
    perHour: Math.round(profit / Math.max(MIN_FLIP_HOURS, hours)),
  };
}

/** Пакетный флип — за сколько часов должны уйти все скупленные лоты. */
export const BATCH_HOURS = 24;

export interface BatchLot {
  amount: number;
  buyout: number;
  profit: number;
}

/**
 * Пакетный флип: несколько выгодных лотов одной позиции. Скупаем от дешёвых к дорогим,
 * пока всё купленное реально продать по медиане за сутки (очередь дешевле + скорость сделок).
 * m.ladder — лоты позиции без этих флипов. null — меньше двух лотов набирается.
 */
export function flipBatch(m: SellMarket, flips: BatchLot[]) {
  const sorted = [...flips].sort(
    (a, b) => a.buyout / a.amount - b.buyout / b.amount,
  );
  const picked: BatchLot[] = [];
  let units = 0;
  for (const f of sorted) {
    const hours = hoursToSell(m, m.sales.median, units + f.amount);
    if (hours === null || hours > BATCH_HOURS) break;
    picked.push(f);
    units += f.amount;
  }
  if (picked.length < 2) return null;
  const sum = (k: keyof BatchLot) => picked.reduce((s, f) => s + f[k], 0);
  return {
    lots: picked.length,
    total: flips.length,
    buyout: sum('buyout'),
    profit: sum('profit'),
    sellHours:
      Math.round((hoursToSell(m, m.sales.median, units) ?? 0) * 10) / 10,
  };
}

/**
 * Самая высокая цена за штуку, при которой amount штук уйдут примерно за hours часов;
 * null — за этот срок не продать даже дешевле всех.
 *
 * Идём по «ступеням» между лотами: на ступени перед k-м лотом впереди нас k лотов,
 * и цена ограничена спросом (нужная доля покупателей) и ценой k-го лота (перебиваем его).
 */
export function priceForHours(
  m: SellMarket,
  hours: number,
  amount = 1,
): number | null {
  const capacity = m.ratePerHour * COMPETITION * hours;
  if (capacity <= 0) return null;
  let best: number | null = null;
  let ahead = 0;
  for (let k = 0; k <= m.ladder.length; k++) {
    const need = (ahead + amount) / capacity;
    if (need > 1) break;
    const floor = k > 0 ? m.ladder[k - 1].unit : 0;
    let price = roundDown(priceForShare(m.sales, need));
    if (k < m.ladder.length)
      price = Math.min(price, undercut(m.ladder[k].unit));
    // цена должна быть не ниже предыдущего лота, иначе мы на другой ступени
    if (price >= floor && price > 0) best = Math.max(best ?? 0, price);
    // дальше спрос только меньше — выше не поднимемся
    else if (k > 0 && priceForShare(m.sales, need) < floor) break;
    if (k < m.ladder.length) ahead += m.ladder[k].amount;
  }
  return best;
}
