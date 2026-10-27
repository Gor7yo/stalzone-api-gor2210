import { Injectable, Logger } from '@nestjs/common';
import { AuctionStore } from 'src/collector/auction-store.service';
import { CollectorService } from 'src/collector/collector.service';
import { variantOf } from 'src/collector/variant';
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
/**
 * Одновременных запросов к EXBO на одну сборку. EXBO отвечает ~2 с независимо от того,
 * 1 запрос или 15 параллельно (замерено), поэтому весь план (≤ 15 страниц) уходит одной волной.
 */
const CONCURRENCY = 16;
/** Сколько живёт собранная история: чем длиннее период, тем реже она заметно меняется. */
const TTL_MS: Record<HistoryPeriod, number> = {
  day: 60_000,
  week: 2 * 60_000,
  month: 5 * 60_000,
  year: 30 * 60_000,
};
/** Насколько старые продажи из БД отдаём (открытый предмет сборщик обновляет раз в 2 мин). */
const SALES_MAX_AGE = { view: 3 * 60_000, fresh: 15_000 } as const;

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

/** Оставляем только то, что нужно приложению: качество, заточку и ключевую характеристику модуля. */
const compact = (s: Sale): Sale => {
  const a = s.additional ?? {};
  const additional: Record<string, unknown> = {};
  if (typeof a.qlt === 'number') additional.qlt = a.qlt;
  if (typeof a.ptn === 'number') additional.ptn = a.ptn;
  const variant = variantOf(a);
  if (variant) additional.attributes = [{ type: 2, definitionId: variant }];
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

/** Устаревший ответ ещё столько отдаём мгновенно, обновляя его в фоне. */
const STALE_MS = 6 * 60 * 60_000;
/**
 * Сколько ответов держим в памяти. Один ответ - до ~15 страниц по 200 сделок (мегабайт и больше),
 * при прежней 1000 записей кеш съедал всю память сервера и процесс падал.
 */
const MAX_ENTRIES = 100;
/** Для предмета, о котором ещё ничего не знаем: первая страница + столько «на всякий случай». */
const SPECULATIVE_PAGES = 2;
const ORDER: HistoryPeriod[] = ['day', 'week', 'month', 'year'];

/** Map помнит порядок вставки — первая запись самая старая. */
function dropOldest<K, V>(map: Map<K, V>) {
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

interface Plan {
  offsets: number[];
  sampled: boolean;
  /** примерная позиция начала периода в истории */
  estimate: number;
}

/**
 * Какие страницы читать: короткий период — подряд с начала,
 * длинный — свежие страницы подряд + равномерная выборка по периоду.
 */
function plan(perMs: number, total: number, since: number): Plan {
  const estimate = Math.min(
    total,
    Math.ceil(perMs * (Date.now() - since) * 1.3) + PAGE,
  );
  if (estimate <= MAX_CONTIGUOUS_PAGES * PAGE) {
    return { offsets: between(0, estimate), sampled: false, estimate };
  }
  const from = RECENT_PAGES * PAGE;
  const step = Math.max(PAGE, Math.floor((estimate - from) / SAMPLE_PAGES));
  const tail: number[] = [];
  for (let o = from; o < estimate && tail.length < SAMPLE_PAGES; o += step) {
    tail.push(o);
  }
  return { offsets: [...between(0, from), ...tail], sampled: true, estimate };
}

/**
 * История продаж за день/неделю/месяц/год одним ответом.
 *
 * Основной путь — БД сборщика (AuctionStore.sales). Ниже — запасной путь через EXBO
 * для предметов, чья история за период ещё не догружена.
 *
 * EXBO отвечает 1,5–3 с на любой запрос, поэтому время ответа = число
 * последовательных «раундов» запросов. Чтобы их было как можно меньше:
 * - темп продаж каждого предмета запоминаем → в следующий раз все нужные
 *   страницы запрашиваем сразу, одним параллельным раундом;
 * - устаревший ответ отдаём мгновенно и обновляем в фоне (stale-while-revalidate);
 * - короткий период вырезаем из уже собранного длинного (месяц → неделя → день).
 * Длинный период популярного предмета — честная выборка страниц, а не сотни запросов.
 */
@Injectable()
export class HistoryPeriodService {
  private readonly logger = new Logger(HistoryPeriodService.name);
  private readonly entries = new Map<
    string,
    { value: HistoryPeriodResponse; at: number }
  >();
  private readonly inflight = new Map<string, Promise<HistoryPeriodResponse>>();
  /** region:item → продаж в мс (по последней сборке) */
  private readonly rates = new Map<string, { perMs: number; total: number }>();

  constructor(
    private readonly stalcraft: StalcraftApiClient,
    private readonly collector: CollectorService,
    private readonly store: AuctionStore,
  ) {}

  async get(q: HistoryPeriodQueryDto): Promise<HistoryPeriodResponse> {
    // сначала наша БД: если сборщик уже накопил историю за период, EXBO не нужен
    void this.collector.touch(q.region, q.item, 'view');
    const since = new Date(Date.now() - DAYS[q.period] * 86_400_000);
    const stored = await this.store
      .sales(
        q.region,
        q.item,
        since,
        q.fresh === 'true' ? SALES_MAX_AGE.fresh : SALES_MAX_AGE.view,
      )
      .catch((e: Error) => {
        this.logger.warn(`история из БД ${q.region}:${q.item}: ${e.message}`);
        return null;
      });
    if (stored) {
      return { period: q.period, since: since.toISOString(), ...stored };
    }

    // история ещё догружается — по-старому, страницами EXBO
    const key = `${q.region}:${q.item}:${q.period}`;
    const hit = this.entries.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < TTL_MS[q.period]) return hit.value;

    const derived = this.fromLonger(q);
    if (derived) return derived;

    if (hit && age < STALE_MS) {
      // старое — сразу, свежее — в фоне к следующему запросу
      this.refresh(q, key).catch((e: Error) =>
        this.logger.warn(`фоновое обновление ${key}: ${e.message}`),
      );
      return hit.value;
    }
    return this.refresh(q, key);
  }

  /** День/неделя из уже собранного целиком (не выборкой) более длинного периода. */
  private fromLonger(q: HistoryPeriodQueryDto): HistoryPeriodResponse | null {
    const since = Date.now() - DAYS[q.period] * 86_400_000;
    for (const longer of ORDER.slice(ORDER.indexOf(q.period) + 1)) {
      const e = this.entries.get(`${q.region}:${q.item}:${longer}`);
      if (!e || e.value.sampled || Date.now() - e.at >= TTL_MS[q.period]) {
        continue;
      }
      const prices = e.value.prices.filter((s) => time(s) >= since);
      return {
        period: q.period,
        since: new Date(since).toISOString(),
        total: prices.length,
        sampled: false,
        prices,
      };
    }
    return null;
  }

  private refresh(q: HistoryPeriodQueryDto, key: string) {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.load(q)
      .then((value) => {
        const now = Date.now();
        // протухшие (старше STALE_MS) уже никому не отдадим - выкидываем
        for (const [k, e] of this.entries)
          if (now - e.at >= STALE_MS) this.entries.delete(k);
        this.entries.delete(key);
        this.entries.set(key, { value, at: now });
        // вытесняем самые старые записи
        while (this.entries.size > MAX_ENTRIES) dropOldest(this.entries);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private page(q: HistoryPeriodQueryDto, offset: number) {
    return this.stalcraft
      .get<AuctionItemHistoryResponse>(
        [q.region, 'auction', q.item, 'history'],
        { additional: 'true', limit: PAGE, offset },
        60_000,
      )
      .catch(() => null);
  }

  private async load(q: HistoryPeriodQueryDto): Promise<HistoryPeriodResponse> {
    const since = Date.now() - DAYS[q.period] * 86_400_000;
    const itemKey = `${q.region}:${q.item}`;
    const pages = new Map<number, AuctionItemHistoryResponse>();
    const fetch = async (offsets: number[]) => {
      const todo = [...new Set(offsets)].filter((o) => !pages.has(o));
      const got = await inPool(todo, CONCURRENCY, (o) => this.page(q, o));
      got.forEach((p, i) => p && pages.set(todo[i], p));
    };

    // раунд 1: если темп продаж известен — сразу все нужные страницы,
    // иначе первая страница и пара следующих наугад
    const known = this.rates.get(itemKey);
    await fetch(
      known
        ? plan(known.perMs, known.total, since).offsets
        : between(0, (SPECULATIVE_PAGES + 1) * PAGE),
    );
    const first = pages.get(0);
    if (!first) throw new Error('EXBO не отдал историю');

    // темп по первой странице — на будущее и для плана раунда 2
    const head = first.prices;
    const oldestHead = head[head.length - 1];
    const perMs = oldestHead
      ? head.length / Math.max(1, Date.now() - time(oldestHead))
      : 0;
    this.rates.delete(itemKey);
    this.rates.set(itemKey, { perMs, total: first.total });
    if (this.rates.size > 5000) dropOldest(this.rates);

    let p = plan(perMs, first.total, since);
    // раунд 2 — только если прочитанного не хватило (новый предмет или темп вырос)
    const contiguous = () => {
      const sales: AuctionItemHistoryResponse['prices'] = [];
      for (let o = 0; pages.has(o); o += PAGE)
        sales.push(...pages.get(o)!.prices);
      return sales;
    };
    const covered = () => {
      const sales = contiguous();
      const last = sales[sales.length - 1];
      return !last || time(last) < since || sales.length >= first.total;
    };
    if (!covered()) {
      await fetch(p.offsets);
    } else {
      p = { offsets: [], sampled: false, estimate: 0 };
    }

    const sales = p.sampled
      ? [...pages.entries()]
          .sort(([a], [b]) => a - b)
          .flatMap(([, page]) => page.prices)
      : contiguous();
    const prices = sales.filter((s) => time(s) >= since).map(compact);
    return {
      period: q.period,
      since: new Date(since).toISOString(),
      // при полном чтении — точное число сделок за период, при выборке — оценка
      total: p.sampled ? p.estimate : prices.length,
      sampled: p.sampled,
      prices,
    };
  }
}
