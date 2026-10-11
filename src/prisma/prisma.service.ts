import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get<string>('DATABASE_URL'),
      }),
    });
  }

  // соединение открывается лениво при первом запросе; закрываем его при остановке сервера
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
