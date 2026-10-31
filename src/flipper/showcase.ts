// Витрина флиппера для бесплатной версии: что нашёл флиппер и что уже упустили. Без зависимостей (тесты).

const MIN = 60_000;

/** Строка журнала флипов (FlipLog) - то, что нужно витрине. */
export interface LogRow {
  key: string;
  itemId: string;
  quality: number;
  upgrade: number;
  variant: string;
  amount: number;
  buyout: bigint;
  sellUnit: bigint;
  profit: bigint;
  pct: number;
  confidence: string;
  deals: number;
  endTime: Date;
  seenAt: Date;
}

/** Флип на витрине: всё, что видит Pro, плюс за сколько минут лот выкупили. */
export interface ShowcaseFlip {
  itemId: string;
  quality: number;
  upgrade: number;
  variant?: string;
  amount: number;
  buyout: number;
  sellUnit: number;
  profit: number;
  pct: number;
  confidence: string;
  deals: number;
  seenAt: string;
  /** через сколько минут после появления лот выкупили; null - не выкупили (время вышло) или неизвестно */
  boughtInMin: number | null;
}

export interface Showcase {
  region: string;
  /** флипов за сутки (надёжность средняя и выше - как в ленте по умолчанию) */
  count: number;
  /** сколько на них можно было заработать */
  profit: number;
  best: ShowcaseFlip | null;
  /** уже ушедшие с рынка флипы целиком - живые бесплатно не показываем */
  examples: ShowcaseFlip[];
}

/** Ключ сверки с базой сборщика: в ключе флипа время без миллисекунд, в базе - с ними. */
export const lotId = (
  itemId: string,
  amount: number,
  buyout: bigint | number,
  end: Date,
) => `${itemId}|${amount}|${buyout}|${Math.floor(end.getTime() / 1000)}`;

export function toShowcase(r: LogRow, goneAt?: Date | null): ShowcaseFlip {
  const sold = goneAt && goneAt < r.endTime;
  return {
    itemId: r.itemId,
    quality: r.quality,
    upgrade: r.upgrade,
    ...(r.variant && { variant: r.variant }),
    amount: r.amount,
    buyout: Number(r.buyout),
    sellUnit: Number(r.sellUnit),
    profit: Number(r.profit),
    pct: r.pct,
    confidence: r.confidence,
    deals: r.deals,
    seenAt: r.seenAt.toISOString(),
    boughtInMin: sold
      ? Math.max(1, Math.round((goneAt.getTime() - r.seenAt.getTime()) / MIN))
      : null,
  };
}

/**
 * Примеры для витрины: самые прибыльные из лотов, которых на рынке уже нет (выкупили или время
 * вышло). Сначала выкупленные - «кто-то забрал за 4 минуты» продаёт Pro лучше всего;
 * одинаковые предметы не повторяем. rows - по убыванию прибыли.
 */
export function pickExamples(
  rows: LogRow[],
  goneAt: ReadonlyMap<string, Date>,
  now: number,
  take = 2,
) {
  const gone = rows
    .map((r) => ({
      r,
      at: goneAt.get(lotId(r.itemId, r.amount, r.buyout, r.endTime)) ?? null,
    }))
    .filter(({ r, at }) => at || r.endTime.getTime() <= now);
  const sold = gone.filter(({ r, at }) => at && at < r.endTime);
  const out: ShowcaseFlip[] = [];
  const items = new Set<string>();
  for (const { r, at } of [...sold, ...gone]) {
    if (out.length >= take) break;
    if (items.has(r.itemId)) continue;
    items.add(r.itemId);
    out.push(toShowcase(r, at));
  }
  return out;
}
