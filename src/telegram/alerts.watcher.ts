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
import {
  alertTitle,
  deepLink,
  escapeHtml,
  formatPrice,
  formatShort,
  REGION_LABEL,
} from './format';
import { MAX_SENT_KEYS } from './alerts.service';
import {
  FLIPS_PER_MESSAGE,
  flipMessage,
  pickNewFlips,
  type FlipGone,
} from './flip-notify';
import { decide, unitPrice } from './price-match';
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
/** Отправленные флип-алерты правим («уже выкупили») столько времени после отправки. */
const FLIP_TRACK_MS = 2 * 60 * 60_000;

/** Отправленный флип-алерт: чтобы зачеркнуть лоты, которых уже нет на рынке. */
interface SentFlips {
  chatId: bigint;
  messageId: number;
  region: Region;
  offers: ReturnType<typeof pickNewFlips>['offers'];
  buttons: InlineButton[][];
  gone: Map<string, FlipGone>;
  at: number;
}
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
  private sentFlips: SentFlips[] = [];

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
      const link = deepLink(this.appUrl, '/emission');
      for (const { chatId } of recipients) {
        await this.bot.send(
          chatId,
          `☢️ <b>Выброс начался</b> · ${REGION_LABEL[region]}\nСкорее в укрытие!`,
          link ? [[{ text: 'Открыть таймер', url: link }]] : [],
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

    for (const alert of alerts) {
      const feed = feeds.get(alert.region);
      if (!feed) continue;
      if (
        alert.lastNotifiedAt &&
        Date.now() - alert.lastNotifiedAt.getTime() < FLIP_MESSAGE_GAP_MS
      ) {
        continue;
      }
      const { keys, offers } = pickNewFlips(
        feed.flips,
        {
          minProfit: alert.minProfit,
          minPct: alert.minPct,
          minConfidence: alert.minConfidence as Confidence,
          maxBudget: alert.maxBudget,
          groups: alert.groups,
        },
        new Set(alert.sentKeys),
      );
      if (!offers.length) continue;

      const link = deepLink(this.appUrl, '/flips');
      const buttons: InlineButton[][] = [
        [
          ...(link ? [{ text: 'Открыть флиппер', url: link }] : []),
          { text: 'Отключить', callback_data: `fdel:${alert.region}` },
        ],
      ];
      const messageId = await this.bot.sendWithId(
        alert.chatId,
        flipMessage(alert.region as Region, offers),
        buttons,
      );
      if (messageId !== null) {
        this.sentFlips.push({
          chatId: alert.chatId,
          messageId,
          region: alert.region as Region,
          offers,
          buttons,
          gone: new Map(),
          at: Date.now(),
        });
        await this.prisma.flipAlert.updateMany({
          where: { id: alert.id },
          data: {
            sentKeys: [...keys, ...alert.sentKeys].slice(0, MAX_SENT_KEYS),
            lastNotifiedAt: new Date(),
          },
        });
      }
      await sleep(SEND_GAP_MS);
    }
    await this.markGoneFlips();
  }

  /**
   * Отправленные за 2 часа флип-алерты: лоты, которых уже нет на рынке, зачёркиваем
   * («уже выкупили» / «время лота вышло»), чтобы не бежать за ушедшим. Сверяемся с базой сборщика.
   */
  private async markGoneFlips() {
    const now = Date.now();
    this.sentFlips = this.sentFlips.filter((s) => now - s.at < FLIP_TRACK_MS);
    for (const s of this.sentFlips) {
      let changed = false;
      for (const { flip: f } of s.offers.slice(0, FLIPS_PER_MESSAGE)) {
        if (s.gone.has(f.key)) continue;
        const status = await this.lotStatus(s.region, f, now);
        if (status) {
          s.gone.set(f.key, status);
          changed = true;
        }
      }
      if (!changed) continue;
      await this.bot.editText(
        s.chatId,
        s.messageId,
        flipMessage(s.region, s.offers, s.gone),
        s.buttons,
      );
      await sleep(SEND_GAP_MS);
    }
    // всё зачёркнуто — больше не следим
    this.sentFlips = this.sentFlips.filter(
      (s) => s.gone.size < Math.min(s.offers.length, FLIPS_PER_MESSAGE),
    );
  }

  /** Лот флипа ушёл с рынка? sold — пропал до конца срока, expired — срок вышел; null — ещё висит. */
  private async lotStatus(
    region: Region,
    f: Flip,
    now: number,
  ): Promise<FlipGone | null> {
    const end = new Date(f.endTime);
    const lot = await this.prisma.auctionLot.findFirst({
      where: {
        region,
        itemId: f.itemId,
        quality: f.quality,
        upgrade: f.upgrade,
        variant: f.variant ?? '',
        amount: f.amount,
        buyoutPrice: BigInt(f.buyout),
        // в ключе флипа время без миллисекунд
        endTime: { gte: end, lt: new Date(end.getTime() + 1000) },
      },
      select: { goneAt: true },
    });
    if (lot?.goneAt) return lot.goneAt < end ? 'sold' : 'expired';
    return now >= end.getTime() ? 'expired' : null;
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
        const price = unitPrice(lot);
        const lines = [
          `🔔 <b>${escapeHtml(alertTitle(alert))}</b> · ${REGION_LABEL[region as Region] ?? region}`,
          `Лот за <b>${formatShort(price)}</b>${lot.amount > 1 ? ' / шт.' : ''} — порог ${formatShort(alert.maxPrice)}`,
          lot.amount > 1
            ? `${lot.amount} шт. · выкуп ${formatPrice(lot.buyoutPrice)}`
            : `Выкуп ${formatPrice(lot.buyoutPrice)}`,
        ];
        const link = deepLink(
          this.appUrl,
          `/auction/${itemId}${alert.variant ? `?v=${alert.variant}` : ''}`,
        );
        const buttons: InlineButton[][] = [
          [
            ...(link ? [{ text: 'Открыть предмет', url: link }] : []),
            { text: 'Удалить алерт', callback_data: `del:${alert.id}` },
          ],
        ];

        const sent = await this.bot.send(
          alert.chatId,
          lines.join('\n'),
          buttons,
        );
        if (sent) {
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
