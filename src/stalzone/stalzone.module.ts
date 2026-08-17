import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { StalzoneOAuthService } from './oauth/stalzone-oauth.service';
import { StalzoneOAuthController } from './oauth/stalzone-oauth.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { UsersService } from 'src/users/users.service';

@Module({
  imports: [HttpModule],
  controllers: [StalzoneOAuthController],
  providers: [StalzoneOAuthService, PrismaService, UsersService],
  exports: [StalzoneOAuthService],
})
export class StalzoneModule {}
