import * as http from 'node:http';
import * as https from 'node:https';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TokenCipher } from 'src/common/crypto/token-cipher';
import { UsersService } from 'src/users/users.service';
import { StalcraftApiClient } from './api/stalcraft-api.client';
import { StalzoneOAuthController } from './oauth/stalzone-oauth.controller';
import { StalzoneOAuthService } from './oauth/stalzone-oauth.service';

@Module({
  imports: [
    HttpModule.register({
      // без таймаута зависший EXBO держал бы запросы бесконечно
      timeout: 10_000,
      maxRedirects: 0,
      // keep-alive: не открываем TLS-соединение заново на каждый запрос
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64 }),
    }),
  ],
  controllers: [StalzoneOAuthController],
  providers: [
    StalzoneOAuthService,
    StalcraftApiClient,
    UsersService,
    TokenCipher,
  ],
  exports: [StalzoneOAuthService, StalcraftApiClient],
})
export class StalzoneModule {}
