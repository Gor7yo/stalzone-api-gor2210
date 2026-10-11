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

type Params = Record<string, string | number | boolean | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  constructor(
    private readonly http: HttpService,
    private readonly oauth: StalzoneOAuthService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .getOrThrow<string>('STALZONE_API_URL')
      .replace(/\/+$/, '');
  }

  /** segments — части пути без слешей, например ['ru', 'auction', 'gyn0', 'lots']. */
  get<T>(segments: string[], params: Params = {}, ttlMs = 0): Promise<T> {
    const path = segments.map((s) => encodeURIComponent(s)).join('/');
    const clean = Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string | number | boolean>;
    const key = `${path}?${new URLSearchParams(clean as Record<string, string>).toString()}`;

    return this.cache.getOrLoad(key, ttlMs, () =>
      this.request<T>(path, clean),
    ) as Promise<T>;
  }

  get cacheSize() {
    return this.cache.size;
  }

  private async request<T>(
    path: string,
    params: Params,
    attempt = 0,
  ): Promise<T> {
    try {
      const token = await this.oauth.getApplicationToken();
      const { data } = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}/${path}`, {
          params,
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      );
      return data;
    } catch (error) {
      if (!isAxiosError(error)) throw error;
      const status = error.response?.status;

      if (attempt === 0) {
        if (status === 401) {
          this.oauth.invalidateApplicationToken();
          return this.request<T>(path, params, 1);
        }
        if (status === 429) {
          const retryAfter = Number(error.response?.headers?.['retry-after']);
          await sleep(
            Math.min(
              Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000,
              3000,
            ),
          );
          return this.request<T>(path, params, 1);
        }
        if (!status || status >= 500) {
          await sleep(300);
          return this.request<T>(path, params, 1);
        }
      }

      this.logger.warn(`STALCRAFT API ${status ?? error.code} ← /${path}`);
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
