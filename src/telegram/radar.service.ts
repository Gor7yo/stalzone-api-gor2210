import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Region } from 'src/api/dto/queries.dto';
import { ITEM_INFO } from 'src/collector/item-info';
import { variantLabel } from 'src/collector/module-stats';
import { PrismaService } from 'src/prisma/prisma.service';
import { escapeHtml, formatShort, QUALITY_LABEL, REGION_LABEL } from './format';
import {
  freshSignals,
  radarKey,
  radarSignals,
  type RadarRow,
  type RadarSignal,
} from './radar';
import { TelegramBotService } from './telegram-bot.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Проверка раз в 10 минут: скачок за час заметим, пока он ещё актуален. */
const EVERY_MS = 10 * MIN;
/** Ходовые позиции региона — столько самых торгуемых за 3 дня, от TOP_MIN_DEALS сделок. */
const TOP_POSITIONS = 200;
const TOP_MIN_DEALS = 30;
/** Сигналов в одном сообщении — самые сильные. */
const PER_MESSAGE = 8;
const SEND_GAP_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SqlRow {
  itemId: string;
  variant: string;
  quality: number;
  upgrade: number;
  hour_median: number | null;
  hour_n: number;
  base_median: number | null;
  base_n: number;
  d3: number | null;
  d2: number | null;
  d1: number | null;
  d0: number | null;
}

/**
 * Радар рынка (Pro): раз в 10 минут ищет резкие движения цен по 200 ходовым позициям
 * региона — скачок медианы за час на ±25 % и рост несколько суток подряд — и пишет тем,
 * кто включил радар этого региона. Один сигнал по позиции — не чаще раза в 12 часов.
 */
@Injectable()
export class RadarService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RadarService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** о чём уже сообщали: регион|позиция|вид → когда (в памяти: после перезапуска возможен повтор) */
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  onApplicationBootstrap() {
    if (!this.bot.enabled || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const subscribers = await this.prisma.telegramSubscriber.findMany({
        where: {
          blocked: false,
          proUntil: { gt: new Date() },
          OR: [{ bannedUntil: null }, { bannedUntil: { lte: new Date() } }],
          NOT: { radarRegions: { isEmpty: true } },
        },
        select: { chatId: true, radarRegions: true },
      });
      const regions = new Set(subscribers.flatMap((s) => s.radarRegions));
      for (const region of regions as Set<Region>) {
        const now = Date.now();
        const signals = (await this.rows(region, now)).flatMap(radarSignals);
        const prefix = `${region}|`;
        const fresh = freshSignals(signals, this.sent, now, prefix)
          .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
          .slice(0, PER_MESSAGE);
        if (!fresh.length) continue;
        for (const s of fresh)
          this.sent.set(prefix + radarKey(s.row, s.kind), now);

        const text = radarMessage(region, fresh);
        const recipients = subscribers.filter((s) =>
          s.radarRegions.includes(region),
        );
        this.logger.log(
          `Радар ${region}: ${fresh.length} сигн. → ${recipients.length} чел.`,
        );
        for (const { chatId } of recipients) {
          await this.bot.send(chatId, text, [
            [{ text: 'Отключить радар', callback_data: `rdel:${region}` }],
          ]);
          await sleep(SEND_GAP_MS);
        }
      }
      // старые отметки больше не нужны
      const old = Date.now() - DAY;
      for (const [k, at] of this.sent) if (at < old) this.sent.delete(k);
    } catch (e) {
      this.logger.warn(`Радар: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Ходовые позиции региона с медианами: последний час, 3 дня без него и по суткам за 4 дня. */
  private async rows(region: string, now: number): Promise<RadarRow[]> {
    const t = (ms: number) => new Date(now - ms);
    const rows = await this.prisma.$queryRaw<SqlRow[]>`
      WITH s AS (
        SELECT "itemId", "variant", "quality", "upgrade", "time",
               "price"::float8 / GREATEST("amount", 1) AS unit
        FROM "auction_sales"
        WHERE "region" = ${region} AND "time" >= ${t(4 * DAY)} AND "price" > 0
      ),
      top AS (
        SELECT "itemId", "variant", "quality", "upgrade"
        FROM s WHERE "time" >= ${t(3 * DAY)}
        GROUP BY 1, 2, 3, 4
        HAVING count(*) >= ${TOP_MIN_DEALS}
        ORDER BY count(*) DESC
        LIMIT ${TOP_POSITIONS}
      )
      SELECT s."itemId", s."variant", s."quality", s."upgrade",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) FILTER (WHERE "time" >= ${t(HOUR)}) AS hour_median,
        count(*) FILTER (WHERE "time" >= ${t(HOUR)})::int AS hour_n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit)
          FILTER (WHERE "time" >= ${t(3 * DAY)} AND "time" < ${t(HOUR)}) AS base_median,
        count(*) FILTER (WHERE "time" >= ${t(3 * DAY)} AND "time" < ${t(HOUR)})::int AS base_n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) FILTER (WHERE "time" < ${t(3 * DAY)}) AS d3,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit)
          FILTER (WHERE "time" >= ${t(3 * DAY)} AND "time" < ${t(2 * DAY)}) AS d2,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit)
          FILTER (WHERE "time" >= ${t(2 * DAY)} AND "time" < ${t(DAY)}) AS d1,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) FILTER (WHERE "time" >= ${t(DAY)}) AS d0
      FROM s JOIN top USING ("itemId", "variant", "quality", "upgrade")
      GROUP BY 1, 2, 3, 4`;
    return rows.map((r) => ({
      itemId: r.itemId,
      variant: r.variant,
      quality: r.quality,
      upgrade: r.upgrade,
      hourMedian: r.hour_median,
      hourN: r.hour_n,
      baseMedian: r.base_median,
      baseN: r.base_n,
      days: [r.d3, r.d2, r.d1, r.d0],
    }));
  }
}

/** «Комета · Редкий +10», «Оружейный модуль · Редкий «Снайпер»» */
function positionTitle(r: RadarRow) {
  const name = ITEM_INFO[r.itemId]?.[0] ?? `Предмет ${r.itemId}`;
  const variant = [
    r.quality >= 0 ? QUALITY_LABEL[r.quality] : null,
    r.variant
      ? variantLabel(r.variant)
      : r.upgrade > 0 || r.quality >= 0
        ? `+${r.upgrade}`
        : null,
  ]
    .filter(Boolean)
    .join(' ');
  return variant ? `${name} · ${variant}` : name;
}

const pct = (change: number) =>
  `${change > 0 ? '+' : '−'}${Math.round(Math.abs(change) * 100)} %`;

export function radarMessage(region: Region, signals: RadarSignal[]) {
  const lines = signals.map((s) => {
    const title = `<b>${escapeHtml(positionTitle(s.row))}</b>`;
    const prices = `${formatShort(s.from)} → ${formatShort(s.to)}`;
    if (s.kind === 'trend')
      return `📈 ${title}\nрастёт ${s.row.days.length} дня подряд: ${pct(s.change)} (${prices})`;
    return `${s.kind === 'up' ? '🚀' : '📉'} ${title}\n${pct(s.change)} за час: ${prices} · ${s.row.hourN} сделок${s.kind === 'down' ? ' - кто-то сливает' : ''}`;
  });
  return [
    `📡 <b>Радар рынка</b> · ${REGION_LABEL[region] ?? region}`,
    '',
    lines.join('\n\n'),
    '',
    '<i>Медианы сделок за штуку. Это сигнал, а не совет: проверьте лоты перед покупкой.</i>',
  ].join('\n');
}
