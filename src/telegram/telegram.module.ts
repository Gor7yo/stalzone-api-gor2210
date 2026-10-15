import { Module } from '@nestjs/common';
import { CollectorModule } from 'src/collector/collector.module';
import { FlipperModule } from 'src/flipper/flipper.module';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { AccessService } from './access.service';
import { AuthController, MeController } from './account.controller';
import { AccountGuard } from './account.guard';
import { AccountService } from './account.service';
import { AdminController, AdminGuard } from './admin.controller';
import { AdminService } from './admin.service';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { AlertsWatcher } from './alerts.watcher';
import { BotCommandsService } from './bot-commands.service';
import { ExboLoginService } from './exbo-login.service';
import {
  FlipsController,
  SellController,
  ProAdminController,
} from './pro.controller';
import { ProService } from './pro.service';
import { TelegramBotService } from './telegram-bot.service';
import { TributeController } from './tribute.controller';
import { WebLinkService } from './web-link.service';

/**
 * Аккаунты и Telegram: вход через EXBO (основной аккаунт), подписка Pro,
 * привязка Telegram и бот (алерты цен, выброса, флипов).
 * Без TELEGRAM_BOT_TOKEN бот и алерты выключены, вход через EXBO работает.
 */
@Module({
  imports: [StalzoneModule, CollectorModule, FlipperModule],
  controllers: [
    AuthController,
    MeController,
    AlertsController,
    FlipsController,
    SellController,
    ProAdminController,
    TributeController,
    AdminController,
  ],
  providers: [
    TelegramBotService,
    AccountService,
    AccountGuard,
    AccessService,
    AdminService,
    AdminGuard,
    AlertsService,
    AlertsWatcher,
    BotCommandsService,
    ExboLoginService,
    WebLinkService,
    ProService,
  ],
})
export class TelegramModule {}
