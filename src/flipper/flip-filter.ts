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
/**
 * Окно сделок для цены продажи (медиана), дней. Короткое: рынок быстро демпингуется,
 * и медиана за неделю завышала бы цену продажи (а с ней — прибыль флипа).
 */
export const FLIP_WINDOW_DAYS = 3;

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
  /** Ключевая характеристика модуля (marksman, sadist…); нет — у предмета вариантов нет */
  variant?: string;
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
  /** За сколько часов примерно уйдёт по медиане (очередь дешевле + скорость сделок); null — дольше 48 ч */
  sellHours: number | null;
  /** Прибыль в час с учётом времени продажи; null — если не продастся за 48 ч */
  profitPerHour: number | null;
  /**
   * Пакетный флип: таких выгодных лотов несколько — сколько из них скупить, чтобы всё ушло
   * за сутки (lots из total), общий выкуп и прибыль. Один на всю позицию; нет — пакета не набралось.
   */
  batch?: {
    lots: number;
    total: number;
    buyout: number;
    profit: number;
    sellHours: number;
  };
  /** Когда лот видели в последнем снимке */
  seenAt: string;
  /** Когда сборщик впервые увидел лот - для пометки «новый» на ленте; нет у старых данных */
  firstSeenAt?: string;
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
