import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type InlineButton =
  { text: string; url: string } | { text: string; callback_data: string };

export interface TgMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
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
    void this.call('setMyCommands', {
      commands: [
        { command: 'alerts', description: 'Мои алерты' },
        { command: 'emission', description: 'Уведомления о выбросе' },
        { command: 'stop', description: 'Отключить все уведомления' },
      ],
    }).catch((e: Error) => this.logger.warn(`setMyCommands: ${e.message}`));
    if (this.polling) void this.pollLoop();
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
  ): Promise<boolean> {
    const body = {
      chat_id: Number(chatId),
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.call('sendMessage', body);
        return true;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) {
          this.logger.warn(`sendMessage → ${Number(chatId)}: ${String(error)}`);
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
            `sendMessage → ${Number(chatId)}: ${error.code} ${error.message}`,
          );
        }
        return false;
      }
    }
    return false;
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
            allowed_updates: ['message', 'callback_query'],
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
