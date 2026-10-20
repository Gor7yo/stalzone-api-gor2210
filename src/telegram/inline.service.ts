import { Injectable, Logger } from '@nestjs/common';
import type { Region } from 'src/api/dto/queries.dto';
import { ITEM_INFO } from 'src/collector/item-info';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import { escapeHtml, formatShort, REGION_LABEL } from './format';
import { PlayersService, type InlinePlayer } from 'src/players/players.service';
import { playerResult } from './inline-player';
import { parseQuery, rawNick, searchItems } from './inline-search';
import { TelegramBotService } from './telegram-bot.service';

const DAY = 86_400_000;
/** Ответы кешируем на минуту: inline-запросы летят на каждую букву. */
const CACHE_MS = 60_000;
/** Иконки предметов — из открытой базы EXBO (как на сайте). */
const ICONS =
  'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru/icons';

export interface ItemStats {
  itemId: string;
  /** лучшая цена выкупа за штуку среди активных лотов; null — лотов нет */
  best: number | null;
  lots: number;
  deals: number;
  /** медиана сделки за сутки и изменение к предыдущим суткам, % */
  median: number | null;
  change: number | null;
}

export interface InlineQueryUpdate {
  id: string;
  query: string;
  from: { id: number };
}

/**
 * Inline-режим: в любом чате «@бот комета» → карточка с ценой и кнопкой на сайт,
 * «@бот ник» → карточка игрока (рейтинг, архетип, K/D) с превью-картинкой профиля.
 * Цены — из БД сборщика (квоту EXBO не тратят). Пустой запрос — самые ходовые предметы за сутки.
 * Включается в @BotFather: /setinline.
 */
@Injectable()
export class InlineService {
  private readonly logger = new Logger(InlineService.name);
  private readonly cache = new TtlCache<unknown[]>(500);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly players: PlayersService,
  ) {}

  async answer(q: InlineQueryUpdate) {
    const { region, text } = parseQuery(q.query);
    const results = await this.cache.getOrLoad(
      `${region}:${text}`,
      CACHE_MS,
      async () => {
        const ids = text ? searchItems(text) : await this.popular(region);
        // одно слово — может быть ник; регистр берём как набрали (parseQuery его теряет)
        const playersP: Promise<InlinePlayer[]> =
          !text || /\s/.test(text)
            ? Promise.resolve([])
            : this.players
                .inlinePlayers(region, rawNick(q.query))
                .catch(() => []);
        const [stats, players] = await Promise.all([
          this.stats(region, ids),
          playersP,
        ]);
        const items = ids.map((id) =>
          this.result(region, stats.get(id) ?? empty(id)),
        );
        const cards = players.map((p) =>
          playerResult(p, region, this.bot.siteUrl, this.bot.username),
        );
        // точный ник — первым, иначе предметы выше игроков
        const exact = players.some(
          (p) => p.username.toLowerCase() === text.toLowerCase(),
        );
        return exact ? [...cards, ...items] : [...items, ...cards];
      },
    );
    await this.bot
      .call('answerInlineQuery', {
        inline_query_id: q.id,
        results,
        cache_time: 60,
        // кнопка над результатами — открыть бота (там меню, алерты, Pro)
        button: {
          text: '🤖 Алерты и флиппер - в боте',
          start_parameter: 'inline',
        },
      })
      .catch((e: Error) => this.logger.warn(`answerInlineQuery: ${e.message}`));
  }

  /** Самые ходовые предметы региона за сутки — подсказка на пустой запрос. */
  private async popular(region: Region) {
    const rows = await this.prisma.$queryRaw<{ itemId: string }[]>`
      SELECT "itemId" FROM "auction_sales"
      WHERE "region" = ${region} AND "time" >= ${new Date(Date.now() - DAY)} AND "price" > 0
      GROUP BY "itemId" ORDER BY sum("price") DESC LIMIT 8`;
    return rows.map((r) => r.itemId).filter((id) => ITEM_INFO[id]);
  }

  /** Цены по списку предметов — двумя запросами на весь список. */
  async stats(region: Region, ids: string[]) {
    const map = new Map<string, ItemStats>();
    if (!ids.length) return map;
    const now = Date.now();
    const [lots, sales] = await Promise.all([
      this.prisma.$queryRaw<
        { itemId: string; best: number | null; n: number }[]
      >`
        SELECT "itemId",
               min("buyoutPrice"::float8 / GREATEST("amount", 1)) AS best,
               count(*)::int AS n
        FROM "auction_lots"
        WHERE "region" = ${region} AND "itemId" = ANY(${ids}) AND "goneAt" IS NULL
          AND "buyoutPrice" > 0 AND "endTime" > ${new Date(now)}
        GROUP BY 1`,
      this.prisma.$queryRaw<
        { itemId: string; n: number; med: number | null; prev: number | null }[]
      >`
        SELECT "itemId",
               count(*) FILTER (WHERE "time" >= ${new Date(now - DAY)})::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY "price"::float8 / GREATEST("amount", 1))
                 FILTER (WHERE "time" >= ${new Date(now - DAY)}) AS med,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY "price"::float8 / GREATEST("amount", 1))
                 FILTER (WHERE "time" < ${new Date(now - DAY)}) AS prev
        FROM "auction_sales"
        WHERE "region" = ${region} AND "itemId" = ANY(${ids})
          AND "time" >= ${new Date(now - 2 * DAY)} AND "price" > 0
        GROUP BY 1`,
    ]);
    for (const id of ids) map.set(id, empty(id));
    for (const l of lots) {
      const s = map.get(l.itemId)!;
      s.best = l.best;
      s.lots = l.n;
    }
    for (const r of sales) {
      const s = map.get(r.itemId)!;
      s.deals = r.n;
      s.median = r.med;
      s.change =
        r.med && r.prev
          ? Math.round(((r.med - r.prev) / r.prev) * 1000) / 10
          : null;
    }
    return map;
  }

  private result(region: Region, s: ItemStats) {
    const [name, , category] = ITEM_INFO[s.itemId] ?? [s.itemId, '', ''];
    const site = this.bot.siteUrl;
    return {
      type: 'article',
      id: `${region}:${s.itemId}`,
      title: `${name} · ${REGION_LABEL[region]}`,
      description: describe(s),
      ...(category && {
        thumbnail_url: `${ICONS}/${category}/${s.itemId}.png`,
        thumbnail_width: 64,
        thumbnail_height: 64,
      }),
      input_message_content: {
        message_text: card(name, region, s, this.bot.username),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🌐 Открыть на STALZONE INFO',
              url: `${site}/auction/${s.itemId}`,
            },
          ],
          [
            {
              text: '🔎 Найти другой предмет',
              switch_inline_query_current_chat: '',
            },
          ],
        ],
      },
    };
  }
}

const empty = (itemId: string): ItemStats => ({
  itemId,
  best: null,
  lots: 0,
  deals: 0,
  median: null,
  change: null,
});

const pct = (x: number) => `${x > 0 ? '+' : ''}${x.toLocaleString('ru-RU')} %`;

/** Строка под названием в списке результатов. */
export function describe(s: ItemStats) {
  const parts = [
    s.best != null
      ? `от ${formatShort(s.best)} · лотов ${s.lots}`
      : 'лотов нет',
    s.deals ? `сделок за сутки ${s.deals}` : null,
    s.change != null ? pct(s.change) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Сообщение, которое уйдёт в чат. */
export function card(
  name: string,
  region: Region,
  s: ItemStats,
  botName: string,
) {
  const lines = [
    `<b>${escapeHtml(name)}</b> · ${REGION_LABEL[region]}`,
    s.best != null
      ? `💰 Лучшая цена: <b>от ${formatShort(s.best)}</b> за шт. · лотов: ${s.lots}`
      : '💰 Сейчас лотов нет',
  ];
  if (s.deals && s.median != null) {
    lines.push(
      `📈 Сделок за сутки: ${s.deals} · медиана ${formatShort(s.median)}${s.change != null ? ` (${pct(s.change)} к вчера)` : ''}`,
    );
  }
  lines.push('', `<i>Цены STALZONE в любом чате - @${botName}</i>`);
  return lines.join('\n');
}
