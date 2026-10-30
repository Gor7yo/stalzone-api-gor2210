import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Screen, toKeyboard, toLegacy, toRichHtml } from './bot-ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Повторное редактирование тем же содержимым — не ошибка. */
const isNotModified = (e: unknown) =>
  e instanceof TelegramApiError && /message is not modified/i.test(e.message);
/** Пользователь заблокировал бота или чата больше нет. */
const isGone = (e: unknown) =>
  e instanceof TelegramApiError &&
  (e.code === 403 || /chat not found/i.test(e.message));

export type InlineButton = { text: string; style?: string } & (
  | { url: string }
  | { callback_data: string }
  /** нажал - текст в буфере обмена (Bot API 7.11) */
  | { copy_text: { text: string } }
);

export interface TgMessage {
  message_id: number;
  text?: string;
  caption?: string;
  /** размеры одного фото, последний — самый крупный */
  photo?: { file_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  /** тема форума (группа поддержки) */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** служебные сообщения тем: создание, закрытие */
  forum_topic_created?: unknown;
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  /** «@бот запрос» в любом чате (inline-режим включается в @BotFather: /setinline) */
  inline_query?: { id: string; query: string; from: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; first_name?: string; username?: string };
    message?: TgMessage;
  };
}

export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

/**
 * Тонкий клиент Telegram Bot API (без внешних библиотек).
 *
 * Обновления получает long polling'ом — не нужен публичный HTTPS-адрес,
 * поэтому работает и локально. Команды обрабатывает тот, кто подписался через onUpdate().
 */
@Injectable()
export class TelegramBotService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly token?: string;
  private readonly polling: boolean;
  /** Экраны меню rich-сообщениями (Bot API 10.1+); TELEGRAM_RICH=false — обычный HTML. */
  private readonly rich: boolean;
  /** Адрес сайта: мини-приложение (кнопки web_app) и картинки в меню. */
  readonly siteUrl: string;
  /** @username бота без «@» — для ссылок t.me (уточняется через getMe при старте). */
  username = 'stalzoneinfo_bot';
  private handler?: (update: TgUpdate) => Promise<void>;
  private abort?: AbortController;
  private stopped = false;

  /** Вызывается, когда пользователь заблокировал бота (403) — чтобы перестать ему писать. */
  onBlocked?: (chatId: number) => Promise<void>;

  constructor(config: ConfigService) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || undefined;
    this.polling =
      config.get<string>('TELEGRAM_POLLING') !== 'false' &&
      process.env.NODE_ENV !== 'test';
    this.rich = config.get<string>('TELEGRAM_RICH') !== 'false';
    this.siteUrl = (
      config.get<string>('SITE_URL')?.trim() || 'https://stalzone-info.ru'
    ).replace(/\/$/, '');
  }

  get enabled() {
    return Boolean(this.token);
  }

  get botToken() {
    return this.token;
  }

  onUpdate(handler: (update: TgUpdate) => Promise<void>) {
    this.handler = handler;
  }

  onApplicationBootstrap() {
    if (!this.token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN не задан — алерты в Telegram отключены',
      );
      return;
    }
    void this.setupProfile();
    if (this.polling) void this.pollLoop();
  }

  /** Команды, описание и кнопка меню (слева от поля ввода) — при каждом старте, вызовы идемпотентны. */
  private async setupProfile() {
    await this.call<{ username?: string }>('getMe')
      .then((me) => {
        if (me.username) this.username = me.username;
      })
      .catch((e: Error) => this.logger.warn(`getMe: ${e.message}`));
    const steps: [string, Record<string, unknown>][] = [
      [
        'setMyCommands',
        {
          commands: [
            { command: 'start', description: 'Главное меню' },
            { command: 'alerts', description: 'Мои алерты' },
            { command: 'emission', description: 'Уведомления о выбросе' },
            { command: 'pro', description: 'Подписка Pro' },
            { command: 'recap', description: 'Итоги месяца в Зоне' },
            { command: 'support', description: 'Написать в поддержку' },
            { command: 'stop', description: 'Отключить все уведомления' },
          ],
        },
      ],
      [
        'setMyShortDescription',
        {
          short_description:
            'Рынок STALZONE: цены, флиппер, алерты в Telegram и уведомления о выбросе.',
        },
      ],
      [
        'setMyDescription',
        {
          description: [
            'STALZONE INFO - всё о рынке STALZONE в Telegram.',
            '',
            '🔔 Алерты: лот дешевле вашей цены',
            '💰 Флиппер: выгодные лоты для перепродажи',
            '☢️ Уведомления о выбросе по регионам',
            '🛟 Поддержка прямо в чате',
            '',
            'Нажмите «Старт» - покажу меню.',
          ].join('\n'),
        },
      ],
      [
        'setChatMenuButton',
        {
          menu_button: {
            type: 'web_app',
            text: 'Открыть',
            web_app: { url: this.siteUrl },
          },
        },
      ],
    ];
    for (const [method, body] of steps) {
      await this.call(method, body).catch((e: Error) =>
        this.logger.warn(`${method}: ${e.message}`),
      );
    }
  }

  onModuleDestroy() {
    this.stopped = true;
    this.abort?.abort();
  }

  async call<T = unknown>(
    method: string,
    body: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.token) throw new TelegramApiError(0, 'бот не настроен');
    this.abort ??= new AbortController();
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
      },
    );
    const json = (await res.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      throw new TelegramApiError(
        json.error_code ?? res.status,
        json.description ?? 'ошибка Telegram',
        json.parameters?.retry_after,
      );
    }
    return json.result;
  }

  /** Отправляет HTML-сообщение. false — не доставлено (бот заблокирован, чат удалён и т.п.). */
  async send(
    chatId: number | bigint,
    html: string,
    buttons: InlineButton[][] = [],
    threadId?: number,
  ): Promise<boolean> {
    return (await this.sendWithId(chatId, html, buttons, threadId)) !== null;
  }

  /**
   * Правит текст своего HTML-сообщения (например, «лот уже выкупили»).
   * Ошибки не бросает: сообщение могли удалить, текст мог не измениться.
   */
  async editText(
    chatId: number | bigint,
    messageId: number,
    html: string,
    buttons: InlineButton[][] = [],
  ): Promise<boolean> {
    try {
      await this.call('editMessageText', {
        chat_id: Number(chatId),
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
      });
      return true;
    } catch (error) {
      if (!isNotModified(error))
        this.logger.warn(
          `editMessageText → ${Number(chatId)}: ${String(error)}`,
        );
      return false;
    }
  }

  /** Как send, но возвращает id сообщения (чтобы потом его поправить); null — не доставлено. */
  async sendWithId(
    chatId: number | bigint,
    html: string,
    buttons: InlineButton[][] = [],
    threadId?: number,
  ): Promise<number | null> {
    const body = {
      chat_id: Number(chatId),
      ...(threadId && { message_thread_id: threadId }),
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await this.call<TgMessage>('sendMessage', body);
        return msg.message_id;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) {
          this.logger.warn(`sendMessage → ${Number(chatId)}: ${String(error)}`);
          return null;
        }
        if (error.code === 429 && attempt === 0) {
          await sleep(Math.min((error.retryAfter ?? 1) * 1000, 30_000));
          continue;
        }
        if (error.code === 403 || /chat not found/i.test(error.message)) {
          await this.onBlocked?.(Number(chatId));
        } else {
          this.logger.warn(
            `sendMessage → ${Number(chatId)}: ${error.code} ${error.message}`,
          );
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Картинка по ссылке с подписью (HTML). Telegram сам скачивает картинку по url.
   * false — не доставлено (бот заблокирован, Telegram не смог скачать картинку и т.п.).
   */
  async sendPhoto(
    chatId: number | bigint,
    photoUrl: string,
    captionHtml: string,
    buttons: InlineButton[][] = [],
  ): Promise<boolean> {
    const body = {
      chat_id: Number(chatId),
      photo: photoUrl,
      caption: captionHtml,
      parse_mode: 'HTML',
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // картинку Telegram рисует сайт — даём ему время
        await this.call('sendPhoto', body, 30_000);
        return true;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) {
          this.logger.warn(`sendPhoto → ${Number(chatId)}: ${String(error)}`);
          return false;
        }
        if (error.code === 429 && attempt === 0) {
          await sleep(Math.min((error.retryAfter ?? 1) * 1000, 30_000));
          continue;
        }
        if (error.code === 403 || /chat not found/i.test(error.message)) {
          await this.onBlocked?.(Number(chatId));
        } else {
          this.logger.warn(
            `sendPhoto → ${Number(chatId)}: ${error.code} ${error.message}`,
          );
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Показать экран: новым сообщением или заменив сообщение edit (навигация по меню).
   * Rich-сообщение, если включено; если Telegram его не принял — тот же экран обычным HTML.
   * Возвращает id показанного сообщения (null — не доставлено).
   */
  async show(
    chatId: number | bigint,
    screen: Screen,
    opts: { edit?: number; threadId?: number } = {},
  ): Promise<number | null> {
    const chat_id = Number(chatId);
    const reply_markup = { inline_keyboard: toKeyboard(screen.buttons) };
    const target = opts.edit
      ? { chat_id, message_id: opts.edit }
      : { chat_id, ...(opts.threadId && { message_thread_id: opts.threadId }) };

    if (this.rich) {
      try {
        const msg = await this.call<TgMessage | true>(
          opts.edit ? 'editMessageText' : 'sendRichMessage',
          {
            ...target,
            rich_message: { html: toRichHtml(screen) },
            reply_markup,
          },
        );
        return msg === true ? (opts.edit ?? null) : msg.message_id;
      } catch (error) {
        if (isNotModified(error)) return opts.edit ?? null;
        if (isGone(error)) return this.gone(chat_id, error);
        // не разобрал разметку или метод недоступен — показываем обычным HTML
        this.logger.warn(`rich-сообщение не принято: ${String(error)}`);
      }
    }

    const { html, banner } = toLegacy(screen);
    const link_preview_options = banner
      ? { url: banner, prefer_large_media: true, show_above_text: true }
      : { is_disabled: true };
    try {
      const msg = await this.call<TgMessage | true>(
        opts.edit ? 'editMessageText' : 'sendMessage',
        {
          ...target,
          text: html,
          parse_mode: 'HTML',
          link_preview_options,
          reply_markup,
        },
      );
      return msg === true ? (opts.edit ?? null) : msg.message_id;
    } catch (error) {
      if (isNotModified(error)) return opts.edit ?? null;
      if (isGone(error)) return this.gone(chat_id, error);
      // старое сообщение уже нельзя отредактировать (удалено, слишком старое) — шлём новое
      if (opts.edit)
        return this.show(chatId, screen, { threadId: opts.threadId });
      this.logger.warn(`show → ${chat_id}: ${String(error)}`);
      return null;
    }
  }

  private async gone(chatId: number, error: unknown) {
    if (chatId > 0) await this.onBlocked?.(chatId);
    else this.logger.warn(`чат ${chatId} недоступен: ${String(error)}`);
    return null;
  }

  private async pollLoop() {
    let offset = 0;
    let failures = 0;
    this.logger.log('Бот запущен (long polling)');
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query', 'inline_query'],
          },
          35_000,
        );
        if (failures >= 3) this.logger.log('Связь с Telegram восстановлена');
        failures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handler?.(update).catch((e: Error) =>
            this.logger.error(`обработка апдейта: ${e.message}`, e.stack),
          );
        }
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof TelegramApiError && error.code === 409) {
          // у бота стоит webhook или его уже опрашивает другой процесс
          this.logger.error(
            'getUpdates 409: бота уже опрашивает другой процесс или у него настроен webhook. ' +
              'Команды бота здесь не работают, но алерты отправляются. ' +
              'Чтобы этот сервер принимал команды — остановите другой процесс или задайте TELEGRAM_POLLING=false там/здесь.',
          );
          return;
        }
        if (error instanceof TelegramApiError && error.code === 401) {
          this.logger.error('TELEGRAM_BOT_TOKEN неверный (401)');
          return;
        }
        // одиночный обрыв/таймаут long polling'а — норма (сеть, Telegram): молча переподключаемся.
        // Предупреждаем один раз, только если связи нет несколько попыток подряд.
        failures++;
        if (failures === 3) {
          this.logger.warn(
            `Нет связи с api.telegram.org (${String(error)}) — продолжаю попытки`,
          );
        }
        await sleep(Math.min(1000 * 2 ** (failures - 1), 30_000));
      }
    }
  }
}
