import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuctionItemHistoryResponse,
  AuctionItemLotsResponse,
} from 'src/api/api.constants';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import {
  BudgetExhaustedError,
  type Priority,
} from 'src/stalzone/api/token-budget';
import type { Prisma, TrackedItem } from 'generated/prisma/client';
import { SEED_ITEMS } from './seed-items';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const PAGE = 200;
/** Как далеко назад догружаем историю для нового предмета. */
const BACKFILL_DAYS = 30;
/** Предмет «нужен», пока его открывали или трогали алерт не дольше этого. */
const WANTED_MS = 30 * MIN;
/** Как часто сборщик смотрит, нет ли просроченной задачи. */
const TICK_MS = 1_000;
/** Сколько задач одновременно: EXBO отвечает 2–3 с, по одной квота бы простаивала. */
const CONCURRENCY = 3;
/** Бронь задачи на время выполнения: если процесс упадёт, через 2 мин её возьмут снова. */
const LEASE_MS = 2 * MIN;
/**
 * Порядок видов задач. Догрузка истории получает каждый пятый ход, даже когда
 * есть просроченные снимки, — иначе при нехватке квоты она не начнётся никогда.
 */
const ROTATION = ['lots', 'sales', 'lots', 'sales', 'backfill'] as const;
/** Начало «всей истории» для historyFrom. */
const EPOCH = new Date(0);

type Sale = AuctionItemHistoryResponse['prices'][number];
type Lot = AuctionItemLotsResponse['lots'][number];
type Kind = (typeof ROTATION)[number];
type ItemKey = Pick<TrackedItem, 'region' | 'itemId'>;

const qualityOf = (a?: Record<string, unknown>) =>
  typeof a?.qlt === 'number' ? a.qlt : -1;
const upgradeOf = (a?: Record<string, unknown>) =>
  typeof a?.ptn === 'number' ? a.ptn : 0;
const keyOf = (item: ItemKey) => `${item.region}:${item.itemId}`;
const where = (item: ItemKey) => ({
  region_itemId: { region: item.region, itemId: item.itemId },
});

/**
 * Сборщик аукциона: держит в нашей БД свежие лоты и историю продаж,
 * чтобы сайт, алерты и флиппер читали из БД, а не тратили квоту EXBO.
 *
 * Квота общая с пользовательскими запросами (StalcraftApiClient.budget): сборщик
 * берёт только остаток сверх резерва и при нехватке просто пропускает ход.
 * Задачи — снимок лотов, новые продажи, догрузка старой истории; сначала берутся
 * предметы, которые сейчас смотрят люди или на которые стоят алерты.
 */
@Injectable()
export class CollectorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CollectorService.name);
  private readonly regions: Region[];
  readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  /** сколько задач сейчас выполняется */
  private running = 0;
  private ticking = false;
  /** позиция в ROTATION: с какого вида задач начинаем следующий поиск */
  private turn = 0;
  /** «регион:предмет» с алертами — их лоты обновляем каждую минуту (ставит AlertsWatcher) */
  private alerted = new Set<string>();
  /** предметы, чья история сейчас догружается (чтобы два хода не взяли один) */
  private readonly backfilling = new Set<string>();
  /** идущие запросы снимков: сборщик и пользователь не запрашивают один предмет дважды */
  private readonly inflight = new Map<string, Promise<void>>();
  /** счётчики для /api/collector/status */
  private readonly stats = {
    startedAt: new Date(),
    lotsJobs: 0,
    salesJobs: 0,
    backfillJobs: 0,
    userRefreshes: 0,
    newSales: 0,
    skippedNoBudget: 0,
    errors: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    config: ConfigService,
  ) {
    const regions = String(config.get('COLLECTOR_REGIONS') ?? 'ru')
      .split(',')
      .map((r) => r.trim())
      .filter((r): r is Region => (REGIONS as readonly string[]).includes(r));
    this.regions = regions.length ? regions : ['ru'];
    this.enabled =
      config.get<string>('COLLECTOR_ENABLED') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  async onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('Сборщик выключен (COLLECTOR_ENABLED=false)');
      return;
    }
    const data = this.regions.flatMap((region) =>
      SEED_ITEMS.map((s) => ({ region, itemId: s.id, source: 'seed' })),
    );
    const { count } = await this.prisma.trackedItem.createMany({
      data,
      skipDuplicates: true,
    });
    this.logger.log(
      `Сборщик запущен: регионы ${this.regions.join(', ')}, новых предметов в списке ${count}`,
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Интервалы обновления (лоты, продажи) по ликвидности и интересу пользователей. */
  private intervals(item: TrackedItem) {
    const wanted =
      item.wantedAt && Date.now() - item.wantedAt.getTime() < WANTED_MS;
    const s = item.salesPerDay;
    const base =
      s >= 100
        ? { lots: 3 * MIN, sales: 5 * MIN }
        : s >= 20
          ? { lots: 10 * MIN, sales: 15 * MIN }
          : s >= 2
            ? { lots: 30 * MIN, sales: 45 * MIN }
            : { lots: 120 * MIN, sales: 180 * MIN };
    return {
      lots: wanted || this.alerted.has(keyOf(item)) ? 1 * MIN : base.lots,
      sales: wanted ? 2 * MIN : base.sales,
    };
  }

  /**
   * Пользователь открыл предмет ('view') или поставил на него алерт ('alert'):
   * обновлять чаще и, если предмета не было в списке, — добавить.
   * 'list' — цену предмета показали в списке: только добавить, чаще не обновлять.
   */
  async touch(
    region: string,
    itemId: string,
    source: 'view' | 'alert' | 'list',
  ) {
    if (!this.enabled || !(REGIONS as readonly string[]).includes(region)) {
      return;
    }
    const wantedAt = source === 'list' ? undefined : new Date();
    await this.prisma.trackedItem
      .upsert({
        where: where({ region, itemId }),
        create: { region, itemId, source, wantedAt },
        update: wantedAt ? { wantedAt } : {},
      })
      .catch(() => {});
  }

  /** Предметы с алертами: их лоты сборщик держит свежими (не старше минуты). */
  setAlertItems(items: ItemKey[]) {
    this.alerted = new Set(items.map(keyOf));
  }

  /**
   * Свежий снимок лотов прямо сейчас (для запроса пользователя). Если сборщик
   * уже снимает этот предмет — ждём его снимок вместо второго запроса.
   */
  refreshLots(region: string, itemId: string, priority: Priority = 'user') {
    return this.once(`lots:${region}:${itemId}`, async () => {
      this.stats.userRefreshes++;
      await this.collectLots(await this.ensure(region, itemId), priority);
    });
  }

  /** Новые продажи прямо сейчас (для запроса пользователя). */
  refreshSales(region: string, itemId: string, priority: Priority = 'user') {
    return this.once(`sales:${region}:${itemId}`, async () => {
      this.stats.userRefreshes++;
      await this.collectSales(await this.ensure(region, itemId), priority);
    });
  }

  private once(key: string, job: () => Promise<void>) {
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = job().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Строка предмета в списке сборщика (частоту обновления задаёт touch). */
  private ensure(region: string, itemId: string) {
    return (
      this.prisma.trackedItem
        .upsert({
          where: where({ region, itemId }),
          create: { region, itemId, source: 'view' },
          update: {},
        })
        // параллельный touch успел создать строку
        .catch(() =>
          this.prisma.trackedItem.findUniqueOrThrow({
            where: where({ region, itemId }),
          }),
        )
    );
  }

  /**
   * Ход сборщика: запускает задачи, пока есть свободные «потоки» и квота.
   * EXBO отвечает 2–3 с, поэтому задачи идут параллельно (до CONCURRENCY).
   */
  private async tick() {
    // ходы таймера не пересекаются — иначе задач стало бы больше CONCURRENCY
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.running < CONCURRENCY) {
        // не берём задачу, если квоты сверх резерва на неё уже нет
        const { available, blocked } = this.stalcraft.budget.status();
        if (blocked || available - 2 < this.stalcraft.budget.reserve) return;

        const job = await this.claim().catch(() => null);
        if (!job) return;
        void this.track(this.run(job.item, job.kind));
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Учёт параллельных задач + общий перехват ошибок хода. */
  private async track(task: Promise<unknown>) {
    this.running++;
    try {
      await task;
    } catch (error) {
      if (!(error instanceof BudgetExhaustedError)) {
        this.stats.errors++;
        this.logger.warn(`ход сборщика: ${String(error)}`);
      }
    } finally {
      this.running--;
    }
  }

  /**
   * Следующая задача: сначала по предметам, которые сейчас нужны людям
   * (открыты на сайте или под алертом), потом по остальным. Виды задач
   * чередуются по ROTATION.
   */
  private async claim(): Promise<{ item: TrackedItem; kind: Kind } | null> {
    this.turn = (this.turn + 1) % ROTATION.length;
    const kinds = [
      ...new Set([
        ...ROTATION.slice(this.turn),
        ...ROTATION.slice(0, this.turn),
      ]),
    ];
    const wanted: Prisma.TrackedItemWhereInput = {
      OR: [
        { wantedAt: { gte: new Date(Date.now() - WANTED_MS) } },
        ...[...this.alerted].map((k) => {
          const [region, itemId] = k.split(':');
          return { region, itemId };
        }),
      ],
    };
    for (const filter of [wanted, {}]) {
      for (const kind of kinds) {
        const item =
          kind === 'backfill'
            ? await this.claimBackfill(filter)
            : await this.claimDue(kind, filter);
        if (item) return { item, kind };
      }
    }
    return null;
  }

  /**
   * Самая просроченная задача вида kind с «бронью»: срок сдвигается на LEASE_MS,
   * чтобы параллельный ход её не взял. Бронь снимается, когда задача отработает.
   */
  private async claimDue(
    kind: 'lots' | 'sales',
    filter: Prisma.TrackedItemWhereInput,
  ) {
    const now = new Date();
    const field = kind === 'lots' ? 'nextLotsAt' : 'nextSalesAt';
    const item = await this.prisma.trackedItem.findFirst({
      where: { ...filter, [field]: { lte: now } },
      orderBy: { [field]: 'asc' },
    });
    if (!item) return null;
    // бронь сработает, только если срок не успел поменять другой ход
    const { count } = await this.prisma.trackedItem.updateMany({
      where: { region: item.region, itemId: item.itemId, [field]: item[field] },
      data: { [field]: new Date(now.getTime() + LEASE_MS) },
    });
    return count === 1 ? item : null;
  }

  /** Предмет, чью историю пора догружать (нужные людям и ликвидные — первыми). */
  private async claimBackfill(filter: Prisma.TrackedItemWhereInput) {
    const items = await this.prisma.trackedItem.findMany({
      where: { ...filter, backfillOffset: { gt: 0 } },
      orderBy: [
        { wantedAt: { sort: 'desc', nulls: 'last' } },
        { salesPerDay: 'desc' },
      ],
      take: CONCURRENCY + 1,
    });
    const item = items.find((i) => !this.backfilling.has(keyOf(i)));
    if (item) this.backfilling.add(keyOf(item));
    return item ?? null;
  }

  private async run(item: TrackedItem, kind: Kind) {
    if (kind === 'backfill') {
      try {
        await this.backfill(item);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) this.stats.skippedNoBudget++;
        else throw error;
      } finally {
        this.backfilling.delete(keyOf(item));
      }
      return;
    }
    const field = kind === 'sales' ? 'nextSalesAt' : 'nextLotsAt';
    try {
      const key = `${kind}:${keyOf(item)}`;
      await this.once(key, () =>
        kind === 'sales'
          ? this.collectSales(item, 'background')
          : this.collectLots(item, 'background'),
      );
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        // квоты нет — снимаем бронь, задача снова первая в очереди на следующий ход
        this.stats.skippedNoBudget++;
        await this.prisma.trackedItem.update({
          where: where(item),
          data: { [field]: item[field] },
        });
        return;
      }
      // ошибка EXBO по предмету (404 и т.п.) — откладываем с нарастающей паузой
      const failures = item.failures + 1;
      const delay = Math.min(
        6 * 60 * MIN,
        5 * MIN * 2 ** Math.min(failures, 6),
      );
      await this.prisma.trackedItem.update({
        where: where(item),
        data: {
          failures,
          lastError: String(error).slice(0, 300),
          [field]: new Date(Date.now() + delay),
        },
      });
      this.stats.errors++;
    }
  }

  private history(item: ItemKey, offset: number, priority: Priority) {
    return this.stalcraft.get<AuctionItemHistoryResponse>(
      [item.region, 'auction', item.itemId, 'history'],
      { additional: 'true', limit: PAGE, offset },
      0,
      priority,
    );
  }

  /** Записывает продажи, уже записанные пропускает. Возвращает, сколько новых. */
  private async saveSales(item: ItemKey, sales: Sale[]) {
    if (!sales.length) return 0;
    const { count } = await this.prisma.auctionSale.createMany({
      data: sales.map((s) => ({
        region: item.region,
        itemId: item.itemId,
        time: new Date(s.time),
        price: BigInt(Math.round(s.price)),
        amount: Number(s.amount) || 1,
        quality: qualityOf(s.additional),
        upgrade: upgradeOf(s.additional),
      })),
      skipDuplicates: true,
    });
    this.stats.newSales += count;
    return count;
  }

  /** С какого момента история полная после того, как догрузка закончилась. */
  private async coveredFrom(item: ItemKey, reachedEnd: boolean) {
    if (reachedEnd) return EPOCH;
    const { _min } = await this.prisma.auctionSale.aggregate({
      where: { region: item.region, itemId: item.itemId },
      _min: { time: true },
    });
    return _min.time ?? new Date();
  }

  /** Новые продажи: первая страница истории (последние 200 сделок). */
  private async collectSales(item: TrackedItem, priority: Priority) {
    const page = await this.history(item, 0, priority);
    const inserted = await this.saveSales(item, page.prices);
    this.stats.salesJobs++;

    // ликвидность по этой странице: продаж за сутки (или экстраполяция, если страница короче суток)
    const times = page.prices.map((s) => new Date(s.time).getTime());
    const oldest = times.length ? Math.min(...times) : Date.now();
    const lastDay = times.filter((t) => t >= Date.now() - DAY).length;
    const salesPerDay =
      times.length === PAGE && oldest > Date.now() - DAY
        ? (PAGE / Math.max(1, Date.now() - oldest)) * DAY
        : lastDay;

    const full = page.prices.length === PAGE;
    // вся страница новая — между ней и тем, что уже есть, может быть дыра: догрузим глубже,
    // а пока история в БД неполная
    const gap = full && inserted === PAGE && item.backfillOffset === null;
    const first = item.backfillOffset === 0;
    await this.prisma.trackedItem.update({
      where: where(item),
      data: {
        salesPerDay,
        lastSalesAt: new Date(),
        nextSalesAt: new Date(
          Date.now() + this.intervals({ ...item, salesPerDay }).sales,
        ),
        failures: 0,
        lastError: null,
        ...(gap && { backfillOffset: PAGE, historyFrom: null }),
        ...(first && {
          backfillOffset: full ? PAGE : null,
          // вся история уместилась в одну страницу
          historyFrom: full ? null : EPOCH,
        }),
      },
    });
  }

  /** Догрузка истории назад, по странице за ход, пока не встретим уже записанное или 30 дней. */
  private async backfill(item: TrackedItem) {
    if (!item.backfillOffset) return;
    const page = await this.history(item, item.backfillOffset, 'background');
    const inserted = await this.saveSales(item, page.prices);
    this.stats.backfillJobs++;
    const oldest = page.prices.length
      ? Math.min(...page.prices.map((s) => new Date(s.time).getTime()))
      : 0;
    const reachedEnd = page.prices.length < PAGE;
    const done =
      reachedEnd || inserted === 0 || oldest < Date.now() - BACKFILL_DAYS * DAY;
    await this.prisma.trackedItem.update({
      where: where(item),
      data: done
        ? {
            backfillOffset: null,
            historyFrom: await this.coveredFrom(item, reachedEnd),
          }
        : { backfillOffset: item.backfillOffset + PAGE },
    });
  }

  /**
   * Снимок лотов: новые записываем, увиденные продлеваем, пропавшие помечаем goneAt.
   * Берём 200 самых дешёвых по выкупу — флипперу и «лучшей цене» важны именно они.
   * Лоты последнего снимка — те, у кого lastSeenAt = lastLotsAt предмета.
   */
  private async collectLots(item: TrackedItem, priority: Priority) {
    const res = await this.stalcraft.get<AuctionItemLotsResponse>(
      [item.region, 'auction', item.itemId, 'lots'],
      {
        additional: 'true',
        limit: PAGE,
        offset: 0,
        sort: 'buyout_price',
        order: 'asc',
      },
      0,
      priority,
    );
    this.stats.lotsJobs++;
    const now = new Date();
    const key = (l: {
      startTime: Date;
      amount: number;
      startPrice: bigint;
      buyoutPrice: bigint;
      quality: number;
      upgrade: number;
    }) =>
      `${l.startTime.getTime()}|${l.amount}|${l.startPrice}|${l.buyoutPrice}|${l.quality}|${l.upgrade}`;

    const seen = res.lots.map((l: Lot) => ({
      region: item.region,
      itemId: item.itemId,
      startTime: new Date(l.startTime),
      endTime: new Date(l.endTime),
      amount: Number(l.amount) || 1,
      startPrice: BigInt(Math.round(l.startPrice)),
      currentPrice:
        typeof l.currentPrice === 'number'
          ? BigInt(Math.round(l.currentPrice))
          : null,
      buyoutPrice: BigInt(Math.round(l.buyoutPrice)),
      quality: qualityOf(l.additional),
      upgrade: upgradeOf(l.additional),
    }));

    const active = await this.prisma.auctionLot.findMany({
      where: { region: item.region, itemId: item.itemId, goneAt: null },
      select: {
        id: true,
        startTime: true,
        amount: true,
        startPrice: true,
        buyoutPrice: true,
        quality: true,
        upgrade: true,
        currentPrice: true,
      },
    });
    const activeByKey = new Map(active.map((a) => [key(a), a]));
    const seenKeys = new Set(seen.map(key));

    const fresh = seen
      .filter((l) => !activeByKey.has(key(l)))
      .map((l) => ({ ...l, firstSeenAt: now, lastSeenAt: now }));
    const stillThere = active.filter((a) => seenKeys.has(key(a)));
    // пропавшим считаем только лот, который точно попал бы в эту страницу:
    // снимок полный (лотов ≤ 200) или лот дешевле самого дорогого из полученных
    const complete = res.total <= PAGE;
    const maxBuyout = seen.reduce(
      (m, l) => (l.buyoutPrice > m ? l.buyoutPrice : m),
      0n,
    );
    const gone = active.filter(
      (a) => !seenKeys.has(key(a)) && (complete || a.buyoutPrice <= maxBuyout),
    );

    await this.prisma.$transaction([
      this.prisma.auctionLot.createMany({ data: fresh, skipDuplicates: true }),
      this.prisma.auctionLot.updateMany({
        where: { id: { in: stillThere.map((a) => a.id) } },
        data: { lastSeenAt: now },
      }),
      this.prisma.auctionLot.updateMany({
        where: { id: { in: gone.map((a) => a.id) } },
        data: { goneAt: now },
      }),
      // ставка на лот могла вырасти
      ...seen
        .filter((l) => {
          const a = activeByKey.get(key(l));
          return (
            a && l.currentPrice !== null && a.currentPrice !== l.currentPrice
          );
        })
        .map((l) =>
          this.prisma.auctionLot.updateMany({
            where: { id: activeByKey.get(key(l))!.id },
            data: { currentPrice: l.currentPrice },
          }),
        ),
      // лоты, у которых истекло время, — ушли в любом случае
      this.prisma.auctionLot.updateMany({
        where: {
          region: item.region,
          itemId: item.itemId,
          goneAt: null,
          endTime: { lt: now },
        },
        data: { goneAt: now },
      }),
      this.prisma.trackedItem.update({
        where: where(item),
        data: {
          lastLotsAt: now,
          lotsTotal: res.total,
          nextLotsAt: new Date(now.getTime() + this.intervals(item).lots),
          failures: 0,
          lastError: null,
        },
      }),
    ]);
  }

  /** Состояние для /api/collector/status. */
  async status() {
    const now = new Date();
    const [tracked, overdueLots, overdueSales, backfilling, sales, activeLots] =
      await Promise.all([
        this.prisma.trackedItem.count(),
        this.prisma.trackedItem.count({ where: { nextLotsAt: { lte: now } } }),
        this.prisma.trackedItem.count({ where: { nextSalesAt: { lte: now } } }),
        this.prisma.trackedItem.count({ where: { backfillOffset: { gt: 0 } } }),
        this.prisma.auctionSale.count(),
        this.prisma.auctionLot.count({ where: { goneAt: null } }),
      ]);
    return {
      enabled: this.enabled,
      regions: this.regions,
      budget: this.stalcraft.budget.status(),
      tracked,
      overdue: { lots: overdueLots, sales: overdueSales },
      backfilling,
      alerted: this.alerted.size,
      stored: { sales, activeLots },
      since: this.stats.startedAt,
      jobs: { ...this.stats, startedAt: undefined },
    };
  }
}
