import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlayersService } from 'src/players/players.service';
import type { Recap } from 'src/players/rating';
import { PrismaService } from 'src/prisma/prisma.service';
import { isBanned } from './access.service';
import { esc } from './bot-ui';
import { TelegramBotService, type InlineButton } from './telegram-bot.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Рассылка — 1-го числа с 12:00 по Москве (UTC+3), проверяем раз в час. */
const SEND_HOUR_MSK = 12;
const MSK_OFFSET = 3 * HOUR;
/** Не больше двух персонажей в одной рассылке — самых активных за месяц. */
const MAX_CHARACTERS = 2;
/** Пауза между сообщениями: лимит Telegram ~30 в секунду на бота. */
const SEND_GAP_MS = 80;
/** Метка в app_state: итоги за месяц уже разосланы (переживает перезапуск). */
const SENT_KEY = 'recap-sent:';

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];
const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const int = (n: number) => Math.round(n).toLocaleString('ru-RU');

/** «2026-10» за прошлый месяц относительно даты по Москве. */
export function previousMonth(now: number) {
  const d = new Date(now + MSK_OFFSET);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Подпись к картинке итогов (HTML). */
export function recapCaption(name: string, r: Recap) {
  const m = Number(r.month.slice(5)) - 1;
  const lines = [
    `🗓 <b>Твой ${MONTHS[m]} в Зоне</b> · ${esc(name)}`,
    `⚔️ +${int(r.kills)} убийств · ⏱ ${int(r.hours)} ч в игре · 📅 ${r.activeDays} дн.`,
  ];
  if (r.bestDay) {
    const [, , dd] = r.bestDay.day.split('-');
    lines.push(
      `🔥 Лучший день: ${Number(dd)} ${MONTHS_GEN[m]} - ${int(r.bestDay.kills)} убийств`,
    );
  }
  if (!r.full)
    lines.push(
      `<i>Считаем с ${Number(r.from.slice(8))} ${MONTHS_GEN[m]} - тогда начали следить.</i>`,
    );
  return lines.join('\n');
}

interface LinkedCharacter {
  region: string;
  name: string;
  id: string;
}

/**
 * Итоги месяца в боте: 1-го числа картинка «Твой октябрь в Зоне» каждому, кто привязал
 * Telegram к аккаунту EXBO (по его персонажам). /recap — итоги текущего месяца по запросу.
 * Выключено локально (NODE_ENV=test) и при RECAP=false.
 */
@Injectable()
export class RecapService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RecapService.name);
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
    private readonly players: PlayersService,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('RECAP') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.enabled || !this.bot.enabled) return;
    this.timer = setInterval(() => void this.tick(), HOUR);
    setTimeout(() => void this.tick(), 5 * MIN);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    const msk = new Date(Date.now() + MSK_OFFSET);
    if (msk.getUTCDate() !== 1 || msk.getUTCHours() < SEND_HOUR_MSK) return;
    if (this.sending) return;
    const month = previousMonth(Date.now());
    const key = SENT_KEY + month;
    // метку ставим до рассылки: упадём посередине — второй раз всем не пришлём
    const created = await this.prisma.appState
      .create({ data: { key, value: new Date().toISOString() } })
      .then(() => true)
      .catch(() => false);
    if (!created) return;
    this.sending = true;
    try {
      const sent = await this.sendAll(month);
      this.logger.log(`Итоги ${month}: отправлено ${sent}`);
    } catch (e) {
      this.logger.warn(`Итоги ${month}: ${(e as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  private async sendAll(month: string) {
    const users = await this.prisma.user.findMany({
      where: { chatId: { not: null }, recapOff: false },
      select: { chatId: true, characters: true, bannedUntil: true },
    });
    let sent = 0;
    for (const u of users) {
      if (isBanned(u.bannedUntil)) continue;
      const ok = await this.sendTo(
        u.chatId!,
        linked(u.characters),
        month,
        false,
      );
      if (ok) sent++;
      await sleep(SEND_GAP_MS);
    }
    return sent;
  }

  /** /recap: итоги текущего месяца (в первые 3 дня месяца — прошлого). */
  async onDemand(chatId: number) {
    const user = await this.prisma.user.findFirst({
      where: { chatId: BigInt(chatId) },
      select: { characters: true, recapOff: true },
    });
    if (!user) {
      return void this.bot.send(
        chatId,
        'Итоги месяца собираются по персонажам аккаунта EXBO. Войдите на сайте через EXBO и привяжите Telegram в разделе «Аккаунт».',
        [[{ text: '🌐 Открыть сайт', url: `${this.bot.siteUrl}/account` }]],
      );
    }
    const msk = new Date(Date.now() + MSK_OFFSET);
    const month =
      msk.getUTCDate() <= 3
        ? previousMonth(Date.now())
        : msk.toISOString().slice(0, 7);
    const ok = await this.sendTo(
      chatId,
      linked(user.characters),
      month,
      true,
      user.recapOff,
    );
    if (!ok) {
      await this.bot.send(
        chatId,
        'Пока нечего показать: история копится каждый день. Загляните через пару дней - и 1-го числа итоги месяца придут сами.',
      );
    }
  }

  /** Отключить / включить ежемесячную рассылку. */
  async setOff(chatId: number, off: boolean) {
    const res = await this.prisma.user.updateMany({
      where: { chatId: BigInt(chatId) },
      data: { recapOff: off },
    });
    return res.count > 0;
  }

  private async sendTo(
    chatId: bigint | number,
    characters: LinkedCharacter[],
    month: string,
    onDemand: boolean,
    off = false,
  ) {
    const recaps: { c: LinkedCharacter; r: Recap }[] = [];
    for (const c of characters) {
      const r = await this.players
        .recapByUuid(c.region, c.id, month)
        .catch(() => null);
      if (r) recaps.push({ c, r });
    }
    const top = recaps
      .sort((a, b) => b.r.hours - a.r.hours)
      .slice(0, MAX_CHARACTERS);
    let any = false;
    for (const { c, r } of top) {
      const name = encodeURIComponent(c.name);
      const page = `${this.bot.siteUrl}/character/${c.region}/${name}/recap/${month}`;
      // картинку рисует сайт; v= — чтобы Telegram не взял из кеша картинку прошлой версии
      const photo = `${page}/opengraph-image?v=${r.to}`;
      const buttons: InlineButton[][] = [
        [{ text: '📲 Открыть и поделиться', url: page }],
        onDemand && off
          ? [
              {
                text: '🔔 Присылать итоги 1-го числа',
                callback_data: 'recap:on',
              },
            ]
          : [{ text: '🔕 Не присылать итоги', callback_data: 'recap:off' }],
      ];
      const caption = recapCaption(c.name, r);
      const ok =
        (await this.bot.sendPhoto(chatId, photo, caption, buttons)) ||
        // Telegram не скачал картинку — хотя бы текстом
        (await this.bot.send(chatId, caption, buttons));
      any ||= ok;
    }
    return any;
  }
}

/** Персонажи аккаунта EXBO из users.characters (только с uuid). */
function linked(raw: unknown): LinkedCharacter[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<LinkedCharacter>[]).filter(
    (c): c is LinkedCharacter => !!c?.region && !!c.name && !!c.id,
  );
}
