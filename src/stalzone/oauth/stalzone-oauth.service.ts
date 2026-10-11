import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface StalzoneTokenResponse {
  token_type?: string;
  expires_in?: number;
  access_token: string;
  refresh_token?: string;
}

export interface StalzoneUser {
  id: number;
  uuid: string;
  login: string;
  display_login: string;
  distributor?: string;
  distributor_id?: string;
}

/** Обновляем токен приложения заранее, чтобы не поймать 401 на границе срока. */
const REFRESH_MARGIN_S = 60;

@Injectable()
export class StalzoneOAuthService {
  private readonly logger = new Logger(StalzoneOAuthService.name);
  private readonly oauthUrl: string;

  private appToken?: StalzoneTokenResponse;
  private expiresAt = 0;
  /** один запрос токена на всех: параллельные вызовы ждут тот же промис */
  private pending?: Promise<StalzoneTokenResponse>;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.oauthUrl = configService
      .getOrThrow<string>('STALZONE_OAUTH_URL')
      .replace(/\/+$/, '');
  }

  async getUser(accessToken: string) {
    const { data } = await firstValueFrom(
      this.httpService.get<StalzoneUser>(`${this.oauthUrl}/oauth/user`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return data;
  }

  getAuthorizationUrl(state: string) {
    const url = new URL(`${this.oauthUrl}/oauth/authorize`);
    url.searchParams.set(
      'client_id',
      this.configService.getOrThrow<string>('STALZONE_CLIENT_ID'),
    );
    url.searchParams.set(
      'redirect_uri',
      this.configService.getOrThrow<string>('STALZONE_REDIRECT_URI'),
    );
    url.searchParams.set('scope', '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Токен приложения (client_credentials) с кешем до истечения срока. */
  getApplicationToken(): Promise<StalzoneTokenResponse> {
    const now = Math.floor(Date.now() / 1000);
    if (this.appToken && this.expiresAt - REFRESH_MARGIN_S > now) {
      return Promise.resolve(this.appToken);
    }

    this.pending ??= this.requestToken({
      grant_type: 'client_credentials',
      scope: '',
    })
      .then((data) => {
        this.appToken = data;
        this.expiresAt =
          Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600);
        return data;
      })
      .finally(() => (this.pending = undefined));

    return this.pending;
  }

  /** Сбросить токен приложения (EXBO ответил 401 — значит, его отозвали). */
  invalidateApplicationToken() {
    this.appToken = undefined;
    this.expiresAt = 0;
  }

  exchangeCode(code: string) {
    return this.requestToken({
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.configService.getOrThrow<string>(
        'STALZONE_REDIRECT_URI',
      ),
    });
  }

  private async requestToken(params: Record<string, string>) {
    const body = new URLSearchParams({
      client_id: this.configService.getOrThrow<string>('STALZONE_CLIENT_ID'),
      client_secret: this.configService.getOrThrow<string>(
        'STALZONE_CLIENT_SECRET',
      ),
      ...params,
    });

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<StalzoneTokenResponse>(
          `${this.oauthUrl}/oauth/token`,
          body.toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        ),
      );
      return data;
    } catch (error) {
      // тело ответа EXBO может содержать детали запроса — в лог пишем только факт
      this.logger.error(
        `Не удалось получить токен EXBO (${params.grant_type})`,
      );
      throw error;
    }
  }
}
