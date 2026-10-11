import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiModule } from './api/api.module';
import { validateEnv } from './config/validation';
import { PrismaModule } from './prisma/prisma.module';
import { StalzoneModule } from './stalzone/stalzone.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // лимит запросов с одного IP: защищает квоту STALCRAFT API от спама.
    // 300/мин с запасом покрывает тяжёлые экраны (планировщик крафта, «Мой рынок»).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    PrismaModule,
    StalzoneModule,
    ApiModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
