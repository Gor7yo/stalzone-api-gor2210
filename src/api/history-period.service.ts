import { Injectable } from '@nestjs/common';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import type { AuctionItemHistoryResponse } from './api.constants';
import type { HistoryPeriod, HistoryPeriodQueryDto } from './dto/queries.dto';

type Sale = AuctionItemHistoryResponse['prices'][number];

const PAGE = 200;
const DAYS: Record<HistoryPeriod, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};
/** Период до стольких страниц читаем целиком, длиннее — выборкой. */
const MAX_CONTIGUOUS_PAGES = 12;
/** При выборке: сколько свежих страниц читаем подряд (сделки за последние сутки и правый край графика). */
const RECENT_PAGES = 3;
/** При выборке: сколько страниц равномерно берём из остальной части периода. */
const SAMPLE_PAGES = 12;
/** Одновременных запросов к EXBO на одну сборку: быстро, но без залпа на квоту. */
const CONCURRENCY = 6;
/** Сколько живёт собранная история: чем длиннее период, тем реже она заметно меняется. */
const TTL_MS: Record<HistoryPeriod, number> = {
  day: 60_000,
  week: 2 * 60_000,
  month: 5 * 60_000,
  year: 30 * 60_000,
};

export interface HistoryPeriodResponse {
  period: HistoryPeriod;
  since: string;
  /** Сколько сделок было за период (точно или оценка по позиции в истории) */
  total: number;
  /** true — период длинный, в ответе выборка сделок, а не все */
  sampled: boolean;
  prices: Sale[];
}

const time = (s: Sale) => new Date(s.time).getTime();

/** Оставляем только то, что нужно приложению: качество и заточку. */
const compact = (s: Sale): Sale => {
  const a = s.additional ?? {};
  const additional: Record<string, number> = {};
  if (typeof a.qlt === 'number') additional.qlt = a.qlt;
  if (typeof a.ptn === 'number') additional.ptn = a.ptn;
  return { amount: s.amount, price: s.price, time: s.time, additional };
};

/** Смещения страниц: [from, from+200, …) до to. */
const between = (from: number, to: number) =>
  Array.from(
    { length: Math.max(0, Math.ceil((to - from) / PAGE)) },
    (_, i) => from + i * PAGE,
  );

/** Пул: не больше `size` запросов одновременно, следующий стартует сразу, как освободилось место. */
async function inPool<T, R>(
  items: T[],
  size: number,
  fn: (x: T) => Promise<R>,
) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return out;
}

/**
 * История продаж за день/неделю/месяц/год одним ответом.
 *
 * EXBO отдаёт историю от новых сделок к старым по 200 штук. По первой странице
 * оцениваем темп продаж и где в истории начинается период; короткий период
 * читаем целиком, длинный (год, популярный предмет) — свежие страницы подряд
 * плюс SAMPLE_PAGES страниц равномерно по периоду. Это честная выборка для
 * графика и медианы за 2 «раунда» запросов, а не сотни.
 */
@Injectable()
export class HistoryPeriodService {
  private readonly cache = new TtlCache<HistoryPeriodResponse>(500);

  constructor(private readonly stalcraft: StalcraftApiClient) {}

  get(q: HistoryPeriodQueryDto) {
    return this.cache.getOrLoad(
      `${q.region}:${q.item}:${q.period}`,
      TTL_MS[q.period],
      () => this.load(q),
    );
  }

  private page(q: HistoryPeriodQueryDto, offset: number, limit = PAGE) {
    return this.stalcraft.get<AuctionItemHistoryResponse>(
      [q.region, 'auction', q.item, 'history'],
      { additional: 'true', limit, offset },
      60_000,
    );
  }

  private async load(q: HistoryPeriodQueryDto): Promise<HistoryPeriodResponse> {
    const since = Date.now() - DAYS[q.period] * 86_400_000;
    const done = (sales: Sale[], total: number, sampled: boolean) => ({
      period: q.period,
      since: new Date(since).toISOString(),
      total,
      sampled,
      prices: sales.filter((s) => time(s) >= since).map(compact),
    });

    // EXBO отвечает ~1–3 с на страницу, поэтому никаких цепочек запросов:
    // 1) первая страница → 2) оценка, где в истории начало периода → все страницы разом
    const first = await this.page(q, 0);
    const sales = [...first.prices];
    const oldest = sales[sales.length - 1];
    if (!oldest || time(oldest) < since || sales.length >= first.total) {
      return done(sales, sales.filter((s) => time(s) >= since).length, false);
    }

    // темп продаж по первой странице → примерная позиция начала периода (с запасом 30%)
    const now = Date.now();
    const perMs = sales.length / Math.max(1, now - time(oldest));
    const estimate = Math.min(
      first.total,
      Math.ceil(perMs * (now - since) * 1.3),
    );

    let offsets: number[];
    let sampled = false;
    if (estimate <= MAX_CONTIGUOUS_PAGES * PAGE) {
      // период влезает целиком — читаем подряд
      offsets = between(PAGE, estimate);
    } else {
      // длинный период: свежие сделки подряд (для «за 24 ч» и правого края графика)
      // + равномерная выборка страниц по остальной части периода
      const head = between(PAGE, RECENT_PAGES * PAGE);
      const from = RECENT_PAGES * PAGE;
      const step = Math.max(PAGE, Math.floor((estimate - from) / SAMPLE_PAGES));
      const tail: number[] = [];
      for (
        let o = from;
        o < estimate && tail.length < SAMPLE_PAGES;
        o += step
      ) {
        tail.push(o);
      }
      offsets = [...head, ...tail];
      sampled = true;
    }

    const pages = await inPool(offsets, CONCURRENCY, (o) =>
      this.page(q, o).catch(() => null),
    );
    pages.forEach((p) => p && sales.push(...p.prices));
    // при полном чтении total — точное число сделок за период, при выборке — оценка
    const total = sampled
      ? estimate
      : sales.filter((s) => time(s) >= since).length;
    return done(sales, total, sampled);
  }
}
