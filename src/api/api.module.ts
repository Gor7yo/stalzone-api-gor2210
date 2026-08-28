import { Module } from '@nestjs/common';
import { ApiService } from './api.service';
import { ApiController } from './api.controller';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StalzoneOAuthService } from 'src/stalzone/oauth/stalzone-oauth.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  imports: [HttpModule, ConfigModule, PrismaModule],
  controllers: [ApiController],
  providers: [ApiService, ConfigService, StalzoneOAuthService, PrismaService],
  exports: [ApiService],
})
export class ApiModule {}
