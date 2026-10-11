import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuctionItemLotsResponse } from 'src/api/api.constants';
import type { Region } from 'src/api/dto/queries.dto';
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
import { decide, unitPrice } from './price-match';
import { InlineButton, TelegramBotService } from './telegram-bot.service';

const EMISSION_EVERY_MS = 30_000;
const PRICES_EVERY_MS = 60_000;
/** О выбросе, начавшемся раньше, не сообщаем (например, сервер только что запустился). */
const EMISSION_FRESH_MS = 10 * 60_000;
/** Пауза между сообщениями при рассылке — лимит Telegram ~30 сообщений/с. */
const SEND_GAP_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EmissionResponse {
  currentStart?: string | null;
}

/**
 * Фоновые проверки: раз в 30 с — выброс, раз в минуту — цены на аукционе.
 * Запросы к STALCRAFT идут через общий клиент с кешем, поэтому одинаковые
 * запросы мини-приложения и проверок не удваиваются.
 */
@Injectable()
export class AlertsWatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertsWatcher.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private readonly appUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    private readonly bot: TelegramBotService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('TELEGRAM_APP_URL')?.trim() || undefined;
  }

  onApplicationBootstrap() {
    if (!this.bot.enabled || process.env.NODE_ENV === 'test') return;
    this.every('emission', EMISSION_EVERY_MS, () => this.checkEmission());
    this.every('prices', PRICES_EVERY_MS, () => this.checkPrices());
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
      where: { blocked: false, NOT: { emissionRegions: { isEmpty: true } } },
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
          `☢️ <b>Выброс начался</b> · ${REGION_LABEL[region]}\nСкорее в укрытие, сталкер!`,
          link ? [[{ text: 'Открыть таймер', url: link }]] : [],
        );
        await sleep(SEND_GAP_MS);
      }
    }
  }

  // ---------- цены ----------

  async checkPrices() {
    const alerts = await this.prisma.priceAlert.findMany({
      where: { subscriber: { blocked: false } },
    });

    // один запрос лотов на пару «регион + предмет», сколько бы алертов на неё ни было
    const groups = new Map<string, typeof alerts>();
    for (const alert of alerts) {
      const key = `${alert.region}:${alert.itemId}`;
      groups.set(key, [...(groups.get(key) ?? []), alert]);
    }

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
        const link = deepLink(this.appUrl, `/auction/${itemId}`);
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
   * Лоты без выкупа (0) EXBO ставит в начало, а нужное качество может быть
   * глубже первых 200 лотов — поэтому листаем страницы (не больше 5).
   */
  private async lotsUpTo(region: string, itemId: string, ceiling: number) {
    const PAGE = 200;
    const lots: AuctionItemLotsResponse['lots'] = [];
    for (let page = 0; page < 5; page++) {
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
