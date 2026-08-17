import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from 'src/prisma/prisma.service';

export interface StalzoneTokenResponse {
  token_type?: string;
  expires_in?: number;
  access_token: string;
}

export interface StalzoneUser {
  id: number;
  uuid: string;
  login: string;
  display_login: string;
  distributor?: string;
  distributor_id?: string;
}

@Injectable()
export class StalzoneOAuthService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private accessToken?: string;
  private expiresAt: number = 0;
  private token_type?: string;

  async getUser(accessToken: string) {
    const oauthUrl =
      this.configService.getOrThrow<string>('STALZONE_OAUTH_URL');

    const { data } = await firstValueFrom(
      this.httpService.get<StalzoneUser>(`${oauthUrl}/oauth/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );

    return data;
  }

  // async callbackUser(user: StalzoneUser) {
  //   let userDb = this.prisma.user.findUnique({
  //     where: {
  //       stalzoneId: user.id,
  //     },
  //   });

  //   if (!userDb) {
  //     userDb = this.prisma.user.create({
  //       data: {
  //         stalzoneId: user.id,
  //         uuid: user.uuid,
  //         distributor: user.distributor,
  //         distributor_id: user.distributor_id,
  //         login: user.login,
  //       },
  //     });
  //   }

  //   return userDb;
  // }

  getAuthorizationUrl(state: string) {
    const clientId =
      this.configService.getOrThrow<string>('STALZONE_CLIENT_ID');

    const redirectUri = this.configService.getOrThrow<string>(
      'STALZONE_REDIRECT_URI',
    );

    const url = new URL('https://exbo.net/oauth/authorize');

    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return url.toString();
  }

  async getApplicationToken(): Promise<StalzoneTokenResponse> {
    const nowInSeconds = Math.floor(Date.now() / 1000);

    if (this.accessToken && this.expiresAt > Math.floor(Date.now() / 1000)) {
      return { access_token: this.accessToken, token_type: this.token_type };
    }

    const clientId =
      this.configService.getOrThrow<string>('STALZONE_CLIENT_ID');

    const clientSecret = this.configService.getOrThrow<string>(
      'STALZONE_CLIENT_SECRET',
    );

    const oauthUrl =
      this.configService.getOrThrow<string>('STALZONE_OAUTH_URL');

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: '',
    });

    const { data } = await firstValueFrom(
      this.httpService.post<StalzoneTokenResponse>(
        `${oauthUrl}/oauth/token`,
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      ),
    );

    this.accessToken = data.access_token;
    this.token_type = data.token_type;
    this.expiresAt = nowInSeconds + Number(data.expires_in);

    return data;
  }

  async exchangeCode(code: string) {
    const clientId =
      this.configService.getOrThrow<string>('STALZONE_CLIENT_ID');
    const clientSecret = this.configService.getOrThrow<string>(
      'STALZONE_CLIENT_SECRET',
    );
    const redirectUri = this.configService.getOrThrow<string>(
      'STALZONE_REDIRECT_URI',
    );

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const { data } = await firstValueFrom(
      this.httpService.post('https://exbo.net/oauth/token', body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
    );

    return data;
  }
}
