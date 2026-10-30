import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuctionItemLotsResponse } from 'src/api/api.constants';
import type { Region } from 'src/api/dto/queries.dto';
import { AuctionStore } from 'src/collector/auction-store.service';
import { CollectorService } from 'src/collector/collector.service';
import {
  type Confidence,
  type Flip,
  FlipperService,
} from 'src/flipper/flipper.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { alertTitle, deepLink, lotUrl, REGION_LABEL } from './format';
import { MAX_SENT_KEYS } from './alerts.service';
import {
  FLIPS_PER_MESSAGE,
  flipButtons,
  flipMessage,
  newFlips,
  pickNewFlips,
  type FlipGone,
} from './flip-notify';
import {
  decide,
  lotKey,
  priceMessage,
  qualityOf,
  upgradeOf,
} from './price-match';
import { isProActive, PRICE_ALERT_LIMIT } from './pro.service';
import { InlineButton, TelegramBotService } from './telegram-bot.service';

/** Забаненным админом уведомления не шлём. */
const notBanned = () => ({
  OR: [{ bannedUntil: null }, { bannedUntil: { lte: new Date() } }],
});

const EMISSION_EVERY_MS = 30_000;
const PRICES_EVERY_MS = 60_000;
/** Лента флиппера пересчитывается раз в минуту — чаще проверять нет смысла. */
/** Флип-алерты: лента пересчитывается раз в 15 с — проверяем так же часто, чтобы успеть раньше покупателей. */
const FLIPS_EVERY_MS = 15_000;
/** Не чаще одного сообщения о флипах на человека за столько (остальное придёт следующим). */
const FLIP_MESSAGE_GAP_MS = 5 * 60_000;
/** Отправленные алерты о лотах правим («выкупили за …») столько времени после отправки. */
const TRACK_MS = 2 * 60 * 60_000;
/** Сверка с базой сборщика - пачками по столько лотов в одном запросе. */
const GONE_BATCH = 200;

/** Лот из алерта для сверки с базой сборщика: у EXBO нет id - узнаём по цене и времени окончания. */
interface LotRef {
  key: string;
  itemId: string;
  amount: number;
  buyout: number;
  endTime: string;
}

/**
 * Отправленное сообщение о лотах (флип-алерт или алерт по цене): когда лот уходит с рынка,
 * правим это же сообщение - нового уведомления не шлём. render собирает текст и кнопки заново.
 */
interface Tracked {
  chatId: bigint;
  messageId: number;
  region: Region;
  lots: LotRef[];
  gone: Map<string, FlipGone>;
  render: (gone: ReadonlyMap<string, FlipGone>) => {
    text: string;
    buttons: InlineButton[][];
  };
  at: number;
}

const flipRef = (f: Flip): LotRef => ({
  key: f.key,
  itemId: f.itemId,
  amount: f.amount,
  buyout: f.buyout,
  endTime: f.endTime,
});

/** Ключ сверки: в ключе флипа время без миллисекунд, в базе - с ними. */
const refId = (itemId: string, amount: number, buyout: number, end: number) =>
  `${itemId}|${amount}|${buyout}|${Math.floor(end / 1000)}`;
/** Снимок лотов старше этого — сначала обновляем (сборщик снимает предметы с алертами раз в минуту). */
const LOTS_MAX_AGE_MS = 90_000;
/** О выбросе, начавшемся раньше, не сообщаем (например, сервер только что запустился). */
const EMISSION_FRESH_MS = 10 * 60_000;
/** Пауза между сообщениями при рассылке — лимит Telegram ~30 сообщений/с. */
const SEND_GAP_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EmissionResponse {
  currentStart?: string | null;
}

/**
 * Фоновые проверки: раз в 30 с — выброс, раз в минуту — цены на аукционе и флипы.
 * Цены берутся из снимков лотов сборщика в БД (общих с сайтом), выброс — через
 * общий клиент STALCRAFT с кешем.
 */
@Injectable()
export class AlertsWatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertsWatcher.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private readonly appUrl?: string;
  /** в памяти: после перезапуска старые сообщения просто перестают обновляться */
  private tracked: Tracked[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    private readonly store: AuctionStore,
    private readonly collector: CollectorService,
    private readonly flipper: FlipperService,
    private readonly bot: TelegramBotService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('TELEGRAM_APP_URL')?.trim() || undefined;
  }

  onApplicationBootstrap() {
    if (!this.bot.enabled || process.env.NODE_ENV === 'test') return;
    this.every('emission', EMISSION_EVERY_MS, () => this.checkEmission());
    this.every('prices', PRICES_EVERY_MS, () => this.checkPrices());
    this.every('flips', FLIPS_EVERY_MS, () => this.checkFlips());
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** Ссылка из кнопки: в мини-приложение, если оно настроено (TELEGRAM_APP_URL), иначе на сайт. */
  private link(path: string) {
    return deepLink(this.appUrl, path) ?? `${this.bot.siteUrl}${path}`;
  }

  /** Запуск по таймеру без наложений: следующая проверка не стартует, пока идёт предыдущая. */
  private every(name: string, ms: number, job: () => Promise<void>) {
    const run = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (error) {
        this.logger.error(`${name}: ${String(error)}`);
      } finally {
        this.running.delete(name);
      }
    };
    setTimeout(() => void run(), 5_000);
    this.timers.push(setInterval(() => void run(), ms));
  }

  // ---------- выброс ----------

  async checkEmission() {
    const subscribers = await this.prisma.telegramSubscriber.findMany({
      where: {
        blocked: false,
        ...notBanned(),
        NOT: { emissionRegions: { isEmpty: true } },
      },
      select: { chatId: true, emissionRegions: true },
    });
    const regions = new Set(subscribers.flatMap((s) => s.emissionRegions));

    for (const region of regions as Set<Region>) {
      const data = await this.stalcraft
        .get<EmissionResponse>([region, 'emission'], {}, 10_000)
        .catch(() => null);
      const start = data?.currentStart;
      if (!start) continue;

      const key = `emission:${region}`;
      const seen = await this.prisma.appState.findUnique({ where: { key } });
      if (seen?.value === start) continue;
      // сначала запоминаем, потом рассылаем — при сбое лучше пропустить, чем заспамить
      await this.prisma.appState.upsert({
        where: { key },
        create: { key, value: start },
        update: { value: start },
      });
      if (Date.now() - new Date(start).getTime() > EMISSION_FRESH_MS) continue;

      const recipients = subscribers.filter((s) =>
        s.emissionRegions.includes(region),
      );
      this.logger.log(`Выброс ${region}: уведомляем ${recipients.length} чел.`);
      const link = this.link('/emission');
      for (const { chatId } of recipients) {
        await this.bot.send(
          chatId,
          `☢️ <b>Выброс начался</b> · ${REGION_LABEL[region]}\nСкорее в укрытие!`,
          [[{ text: 'Открыть таймер', url: link }]],
        );
        await sleep(SEND_GAP_MS);
      }
    }
  }

  // ---------- флипы ----------

  async checkFlips() {
    // флип-алерты — функция Pro: у кого подписка кончилась, алерт молча ждёт продления
    const alerts = await this.prisma.flipAlert.findMany({
      where: {
        subscriber: {
          blocked: false,
          ...notBanned(),
          proUntil: { gt: new Date() },
        },
      },
    });
    const regions = [...new Set(alerts.map((a) => a.region))];
    const feeds = new Map(
      await Promise.all(
        regions.map(
          async (r) =>
            [r, await this.flipper.feed(r).catch(() => null)] as const,
        ),
      ),
    );

    const site = this.bot.siteUrl;
    const flipper = this.link('/flips');
    // ушёл ли лот - один раз за проверку: один лот подходит под алерты многих людей
    const goneKnown = new Map<string, boolean>();
    for (const alert of alerts) {
      const feed = feeds.get(alert.region);
      if (!feed) continue;
      if (
        alert.lastNotifiedAt &&
        Date.now() - alert.lastNotifiedAt.getTime() < FLIP_MESSAGE_GAP_MS
      ) {
        continue;
      }
      const region = alert.region as Region;
      const filter = {
        minProfit: alert.minProfit,
        minPct: alert.minPct,
        minConfidence: alert.minConfidence as Confidence,
        maxBudget: alert.maxBudget,
        groups: alert.groups,
      };
      const sent = new Set(alert.sentKeys);
      const now = Date.now();
      const candidates = newFlips(feed.flips, filter, sent, now);
      if (!candidates.length) continue;

      // лента бывает старше базы сборщика: о лоте, который там уже ушёл, не пишем вовсе -
      // иначе приходит уведомление, а в сообщении сразу «выкупили»
      const unknown = candidates.filter(
        (f) => !goneKnown.has(`${region}|${f.key}`),
      );
      const states = await this.goneLots(region, unknown.map(flipRef), now);
      for (const f of unknown)
        goneKnown.set(`${region}|${f.key}`, states.has(f.key));
      const gone = new Set(
        candidates
          .filter((f) => goneKnown.get(`${region}|${f.key}`))
          .map((f) => f.key),
      );

      const { keys, offers } = pickNewFlips(
        feed.flips,
        filter,
        sent,
        now,
        gone,
      );
      const remember = [...keys, ...alert.sentKeys].slice(0, MAX_SENT_KEYS);
      if (!offers.length) {
        // все новые уже ушли: запоминаем, чтобы не сверять снова, но молчим
        await this.prisma.flipAlert.updateMany({
          where: { id: alert.id },
          data: { sentKeys: remember },
        });
        continue;
      }

      const render = (g: ReadonlyMap<string, FlipGone>) => ({
        text: flipMessage(region, offers, g),
        buttons: flipButtons(site, region, offers, g, flipper),
      });
      const first = render(new Map());
      const messageId = await this.bot.sendWithId(
        alert.chatId,
        first.text,
        first.buttons,
      );
      if (messageId !== null) {
        this.tracked.push({
          chatId: alert.chatId,
          messageId,
          region,
          lots: offers
            .slice(0, FLIPS_PER_MESSAGE)
            .map(({ flip }) => flipRef(flip)),
          gone: new Map(),
          render,
          at: Date.now(),
        });
        await this.prisma.flipAlert.updateMany({
          where: { id: alert.id },
          data: { sentKeys: remember, lastNotifiedAt: new Date() },
        });
      }
      await sleep(SEND_GAP_MS);
    }
    await this.markGone();
  }

  /**
   * Отправленные за 2 часа алерты о лотах (флипы и цены): ушедший с рынка лот зачёркиваем
   * в том же сообщении с ценой («выкупили за …» / «время лота вышло»). Новых сообщений
   * об этом не шлём - правка в Telegram приходит без уведомления.
   */
  private async markGone() {
    const now = Date.now();
    this.tracked = this.tracked.filter((s) => now - s.at < TRACK_MS);
    // одним запросом на регион, сколько бы сообщений ни ждало
    const byRegion = new Map<Region, Map<string, LotRef>>();
    for (const s of this.tracked) {
      const refs = byRegion.get(s.region) ?? new Map<string, LotRef>();
      for (const l of s.lots) if (!s.gone.has(l.key)) refs.set(l.key, l);
      byRegion.set(s.region, refs);
    }
    const states = new Map<string, FlipGone>();
    for (const [region, refs] of byRegion) {
      for (const [k, v] of await this.goneLots(region, [...refs.values()], now))
        states.set(`${region}|${k}`, v);
    }

    for (const s of this.tracked) {
      let changed = false;
      for (const l of s.lots) {
        const status = states.get(`${s.region}|${l.key}`);
        if (status && !s.gone.has(l.key)) {
          s.gone.set(l.key, status);
          changed = true;
        }
      }
      if (!changed) continue;
      const { text, buttons } = s.render(s.gone);
      await this.bot.editText(s.chatId, s.messageId, text, buttons);
      await sleep(SEND_GAP_MS);
    }
    // всё зачёркнуто — больше не следим
    this.tracked = this.tracked.filter((s) => s.gone.size < s.lots.length);
  }

  /**
   * Какие из лотов ушли с рынка (по базе сборщика): sold — пропал до конца срока,
   * expired — срок вышел. Лотов, которые ещё висят, в ответе нет.
   */
  private async goneLots(
    region: Region,
    refs: LotRef[],
    now: number,
  ): Promise<Map<string, FlipGone>> {
    const out = new Map<string, FlipGone>();
    for (let i = 0; i < refs.length; i += GONE_BATCH) {
      const batch = refs.slice(i, i + GONE_BATCH);
      const rows = await this.prisma.auctionLot.findMany({
        where: {
          region,
          goneAt: { not: null },
          OR: batch.map((r) => {
            const end = Math.floor(Date.parse(r.endTime) / 1000) * 1000;
            return {
              itemId: r.itemId,
              amount: r.amount,
              buyoutPrice: BigInt(r.buyout),
              endTime: { gte: new Date(end), lt: new Date(end + 1000) },
            };
          }),
        },
        select: {
          itemId: true,
          amount: true,
          buyoutPrice: true,
          endTime: true,
          goneAt: true,
        },
      });
      const gone = new Map(
        rows.map((l) => [
          refId(l.itemId, l.amount, Number(l.buyoutPrice), l.endTime.getTime()),
          l.goneAt,
        ]),
      );
      for (const r of batch) {
        const end = Date.parse(r.endTime);
        const goneAt = gone.get(refId(r.itemId, r.amount, r.buyout, end));
        if (goneAt) out.set(r.key, goneAt.getTime() < end ? 'sold' : 'expired');
        else if (now >= end) out.set(r.key, 'expired');
      }
    }
    return out;
  }

  // ---------- цены ----------

  async checkPrices() {
    const all = await this.prisma.priceAlert.findMany({
      where: { subscriber: { blocked: false, ...notBanned() } },
      orderBy: { createdAt: 'asc' },
      include: { subscriber: { select: { proUntil: true } } },
    });
    // без Pro работает только первый алерт (остальные остались с прошлой подписки)
    const perChat = new Map<bigint, number>();
    const alerts = all.filter((a) => {
      const n = (perChat.get(a.chatId) ?? 0) + 1;
      perChat.set(a.chatId, n);
      return isProActive(a.subscriber.proUntil) || n <= PRICE_ALERT_LIMIT.free;
    });

    // один снимок лотов на пару «регион + предмет», сколько бы алертов на неё ни было
    const groups = new Map<string, typeof alerts>();
    for (const alert of alerts) {
      const key = `${alert.region}:${alert.itemId}`;
      groups.set(key, [...(groups.get(key) ?? []), alert]);
    }
    // сборщик держит лоты этих предметов свежими (раз в минуту)
    this.collector.setAlertItems(
      [...groups.values()].map(([a]) => ({
        region: a.region,
        itemId: a.itemId,
      })),
    );

    for (const group of groups.values()) {
      const { region, itemId } = group[0];
      const ceiling = Math.max(...group.map((a) => a.maxPrice));
      let lots: AuctionItemLotsResponse['lots'];
      try {
        lots = await this.lotsUpTo(region, itemId, ceiling);
      } catch {
        continue; // EXBO недоступен — попробуем в следующую минуту
      }

      for (const alert of group) {
        const result = decide(lots, alert);
        if (result.action === 'none') continue;
        if (result.action === 'reset') {
          await this.prisma.priceAlert.updateMany({
            where: { id: alert.id },
            data: { lastLotKey: null },
          });
          continue;
        }

        const { lot } = result;
        const title = alertTitle(alert);
        const regionLabel = REGION_LABEL[region as Region] ?? region;
        // страница предмета сразу с качеством и заточкой этого лота
        const buttons: InlineButton[][] = [
          [
            {
              text: '📋 Скопировать название',
              copy_text: { text: alert.itemName },
            },
            {
              text: '🌐 На сайте',
              url: lotUrl(this.bot.siteUrl, {
                itemId,
                quality: qualityOf(lot) ?? -1,
                upgrade: upgradeOf(lot),
                variant: alert.variant || undefined,
              }),
            },
          ],
          [{ text: 'Удалить алерт', callback_data: `del:${alert.id}` }],
        ];

        const messageId = await this.bot.sendWithId(
          alert.chatId,
          priceMessage(title, regionLabel, alert.maxPrice, lot),
          buttons,
        );
        if (messageId !== null) {
          // лот выкупят - поправим это сообщение, а не пришлём новое
          const ref: LotRef = {
            key: lotKey(lot),
            itemId,
            amount: lot.amount,
            buyout: lot.buyoutPrice,
            endTime: lot.endTime,
          };
          this.tracked.push({
            chatId: alert.chatId,
            messageId,
            region: region as Region,
            lots: [ref],
            gone: new Map(),
            render: (g) => ({
              text: priceMessage(
                title,
                regionLabel,
                alert.maxPrice,
                lot,
                g.get(ref.key),
              ),
              buttons,
            }),
            at: Date.now(),
          });
          await this.prisma.priceAlert.updateMany({
            where: { id: alert.id },
            data: { lastLotKey: result.key, lastNotifiedAt: new Date() },
          });
        }
        await sleep(SEND_GAP_MS);
      }
    }
  }

  /**
   * Лоты по возрастанию цены выкупа, пока она не превысит порог.
   * Первые 200 — из снимка сборщика в БД. Лоты без выкупа (0) EXBO ставит в начало,
   * а нужное качество может быть глубже первых 200 лотов — поэтому, если снимок
   * неполный и порог выше его последнего лота, дочитываем страницы EXBO (всего не больше 5).
   */
  private async lotsUpTo(region: string, itemId: string, ceiling: number) {
    const PAGE = 200;
    const lots: AuctionItemLotsResponse['lots'] = [];
    let first = 0;
    const snap = await this.store.cheapestLots(region, itemId, LOTS_MAX_AGE_MS);
    if (snap) {
      lots.push(...snap.lots);
      const last = snap.lots.at(-1);
      if (snap.complete || !last || last.buyoutPrice > ceiling) return lots;
      first = 1;
    }
    for (let page = first; page < 5; page++) {
      const res = await this.stalcraft.get<AuctionItemLotsResponse>(
        [region, 'auction', itemId, 'lots'],
        {
          additional: 'true',
          limit: PAGE,
          offset: page * PAGE,
          sort: 'buyout_price',
          order: 'asc',
        },
        20_000,
      );
      lots.push(...res.lots);
      const last = res.lots.at(-1);
      if (res.lots.length < PAGE || !last || last.buyoutPrice > ceiling) break;
    }
    return lots;
  }
}
