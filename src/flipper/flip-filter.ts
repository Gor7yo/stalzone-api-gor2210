// Типы флипа и фильтр ленты — без зависимостей (их используют лента, алерты и тесты).

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Порог ленты: прибыль не меньше MIN_PROFIT и не меньше MIN_PCT % от выкупа.
 * Мягкий — строже фильтрует сам пользователь (фильтры ленты и флип-алертов).
 */
export const MIN_PROFIT = 20_000;
export const MIN_PCT = 5;
/** Комиссия аукциона с продажи. */
export const FEE = 0.05;
/** Меньше стольких сделок за окно — цене не верим. */
export const MIN_DEALS = 5;

export interface Flip {
  /** Ключ лота (у EXBO нет id) — чтобы не сообщать об одном лоте дважды */
  key: string;
  itemId: string;
  /** Название и категория из стартового списка сборщика (у остальных предметов — нет) */
  name?: string;
  group?: string;
  /** -1 — у предмета нет качества */
  quality: number;
  upgrade: number;
  amount: number;
  /** Выкуп всего лота */
  buyout: number;
  /** Выкуп за штуку */
  unitPrice: number;
  /** Ожидаемая цена продажи за штуку (медиана сделок) */
  sellUnit: number;
  /** Прибыль после комиссии, весь лот */
  profit: number;
  /** Прибыль в % от выкупа */
  pct: number;
  /** Прибыль, если продать по нижнему квартилю сделок */
  profitLow: number;
  /** На чём оценка: те же качество и заточка или ступень заточки */
  basis: 'exact' | 'tier';
  /** Сделок за окно и в сутки (по той же группе, что и оценка) */
  deals: number;
  perDay: number;
  confidence: Confidence;
  /** Когда лот видели в последнем снимке */
  seenAt: string;
  endTime: string;
  lastSale: string;
}

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Фильтры ленты (они же — условия флип-алерта). */
export interface FlipFilter {
  minProfit: number;
  minPct: number;
  minConfidence: Confidence;
  /** 0 — любой */
  maxBudget: number;
  /** пусто — любые категории */
  groups: string[];
}

export const matchesFlip = (f: Flip, filter: FlipFilter) =>
  f.profit >= filter.minProfit &&
  f.pct >= filter.minPct &&
  CONFIDENCE_RANK[f.confidence] >= CONFIDENCE_RANK[filter.minConfidence] &&
  (!filter.maxBudget || f.buyout <= filter.maxBudget) &&
  (!filter.groups.length || (!!f.group && filter.groups.includes(f.group)));
