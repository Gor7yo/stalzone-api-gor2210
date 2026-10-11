import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Глобальный модуль: один PrismaClient (и один пул соединений) на всё приложение. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
