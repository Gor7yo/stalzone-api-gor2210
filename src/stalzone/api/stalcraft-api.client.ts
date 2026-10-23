import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { StalzoneOAuthService } from '../oauth/stalzone-oauth.service';
import { BudgetExhaustedError, Priority, TokenBudget } from './token-budget';

type Params = Record<string, string | number | boolean | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** EXBO не принял токен игрока (отозван или истёк) - нужен повторный вход. */
export class UserTokenRevokedError extends Error {
  constructor() {
    super('Токен EXBO игрока отозван');
  }
}

/**
 * Единая точка доступа к STALCRAFT API (eapi.stalzone.com).
 *
 * - каждый сегмент пути экранируется → нельзя «выйти» в чужой эндпоинт через ../;
 * - ответы кешируются, одинаковые одновременные запросы склеиваются в один;
 * - таймаут, один повтор при 5xx/сетевой ошибке/429, обновление токена при 401;
 * - ошибки EXBO превращаются в понятные HTTP-коды (404 → 404, а не 500).
 */
@Injectable()
export class StalcraftApiClient {
  private readonly logger = new Logger(StalcraftApiClient.name);
  private readonly cache = new TtlCache<unknown>(3000);
  private readonly baseUrl: string;
  /** Общая квота STALCRAFT API на всё приложение (люди + сборщик). */
  readonly budget: TokenBudget;
  private loggedLimitHeaders = false;
  /** Время сбоев EXBO (5xx, сеть, 401 после повтора) — для мониторинга; 404/400/429 не сбои. */
  private readonly failures: number[] = [];

  /** Сколько сбоев EXBO было за последние ms. */
  failuresSince(ms: number) {
    const from = Date.now() - ms;
    while (this.failures.length && this.failures[0] < from)
      this.failures.shift();
    return this.failures.length;
  }

  constructor(
    private readonly http: HttpService,
    private readonly oauth: StalzoneOAuthService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .getOrThrow<string>('STALZONE_API_URL')
      .replace(/\/+$/, '');
    // реальный лимит EXBO — 400/мин (x-ratelimit-limit); при ответе подстраиваемся под заголовок
    const perMinute = Number(config.get('EXBO_TOKENS_PER_MIN')) || 400;
    const reserve =
      Number(config.get('EXBO_USER_RESERVE')) || Math.round(perMinute * 0.15);
    this.budget = new TokenBudget(perMinute, reserve);
  }

  /**
   * segments — части пути без слешей, например ['ru', 'auction', 'gyn0', 'lots'].
   * priority: 'user' — запрос пользователя (ждёт квоту), 'background' — сборщик (берёт только остаток),
   * 'scan' — обход справочника (половина резерва людей, см. TokenBudget).
   * Ответ из кеша квоту не тратит.
   */
  get<T>(
    segments: string[],
    params: Params = {},
    ttlMs = 0,
    priority: Priority = 'user',
  ): Promise<T> {
    const path = segments.map((s) => encodeURIComponent(s)).join('/');
    const clean = Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string | number | boolean>;
    const key = `${path}?${new URLSearchParams(clean as Record<string, string>).toString()}`;

    return this.cache.getOrLoad(key, ttlMs, () =>
      this.request<T>(path, clean, priority),
    ) as Promise<T>;
  }

  /** Стоимость запроса в токенах EXBO: аукцион — 2, остальное — 1. */
  private cost(path: string) {
    return path.includes('/auction/') ? 2 : 1;
  }

  /** Если EXBO присылает заголовки лимита — сверяем с ними свой счёт (и один раз пишем в лог, какие). */
  private observeLimits(headers: Record<string, unknown> | undefined) {
    if (!headers) return;
    const names = Object.keys(headers).filter((h) =>
      /rate|limit|remaining/i.test(h),
    );
    if (!names.length) return;
    if (!this.loggedLimitHeaders) {
      this.loggedLimitHeaders = true;
      this.logger.log(
        `Заголовки лимита EXBO: ${names.map((n) => `${n}=${String(headers[n])}`).join(', ')}`,
      );
    }
    const limit = headers['x-ratelimit-limit'];
    if (limit !== undefined && this.budget.setLimit(Number(limit))) {
      this.logger.log(
        `Лимит EXBO: ${this.budget.perMinute}/мин, резерв для людей ${this.budget.reserve}`,
      );
    }
    const remaining = names.find((n) => /remaining/i.test(n));
    if (remaining) this.budget.sync(Number(headers[remaining]));
  }

  get cacheSize() {
    return this.cache.size;
  }

  private async request<T>(
    path: string,
    params: Params,
    priority: Priority,
    attempt = 0,
  ): Promise<T> {
    try {
      await this.budget.take(this.cost(path), priority);
    } catch {
      // квоты нет: пользователю — понятная 429, сборщику — пропуск хода
      if (priority !== 'user') throw new BudgetExhaustedError();
      throw this.toHttpException(429);
    }
    try {
      const token = await this.oauth.getApplicationToken();
      const { data, headers } = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}/${path}`, {
          params,
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      );
      this.observeLimits(headers);
      return data;
    } catch (error) {
      if (!isAxiosError(error)) throw error;
      const status = error.response?.status;
      this.observeLimits(error.response?.headers);

      if (status === 429) {
        const retryAfter = Number(error.response?.headers?.['retry-after']);
        this.budget.onRateLimited(
          retryAfter,
          Number(error.response?.headers?.['x-ratelimit-reset']),
        );
        this.logger.warn(`STALCRAFT API 429 ← /${path} (квота кончилась)`);
        // сборщик просто пропустит ход; пользовательский запрос подождёт квоту один раз
        if (priority !== 'user') throw new BudgetExhaustedError();
        if (attempt === 0) return this.request<T>(path, params, priority, 1);
      }

      if (attempt === 0) {
        if (status === 401) {
          this.oauth.invalidateApplicationToken();
          return this.request<T>(path, params, priority, 1);
        }
        if (!status || status >= 500) {
          await sleep(300);
          return this.request<T>(path, params, priority, 1);
        }
      }

      this.logger.warn(`STALCRAFT API ${status ?? error.code} ← /${path}`);
      if (!status || status >= 500 || status === 401) {
        this.failures.push(Date.now());
        // держим только недавние — счётчик не растёт бесконечно
        if (this.failures.length > 1000) this.failures.shift();
      }
      throw this.toHttpException(status, error.code);
    }
  }

  /**
   * Запрос от имени игрока (его токен EXBO): персонажи, друзья. Без кеша и повторов -
   * ответ личный, а 401 значит, что токен отозван и нужен новый вход.
   */
  async getAsUser<T>(segments: string[], accessToken: string): Promise<T> {
    const path = segments.map((s) => encodeURIComponent(s)).join('/');
    try {
      await this.budget.take(this.cost(path), 'user');
    } catch {
      throw this.toHttpException(429);
    }
    try {
      const { data } = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}/${path}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return data;
    } catch (error) {
      if (!isAxiosError(error)) throw error;
      const status = error.response?.status;
      this.logger.warn(
        `STALCRAFT API ${status ?? error.code} ← /${path} (токен игрока)`,
      );
      if (status === 401) throw new UserTokenRevokedError();
      throw this.toHttpException(status, error.code);
    }
  }

  private toHttpException(status: number | undefined, code?: string) {
    if (status === 404) return new NotFoundException('Не найдено');
    if (status === 400 || status === 422)
      return new BadRequestException('Некорректный запрос');
    if (status === 429) {
      return new HttpException(
        'STALCRAFT API перегружен, попробуйте чуть позже',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return new GatewayTimeoutException('STALCRAFT API не ответил вовремя');
    }
    return new BadGatewayException('STALCRAFT API недоступен');
  }
}
