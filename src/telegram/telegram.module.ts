import { Module } from '@nestjs/common';
import { CollectorModule } from 'src/collector/collector.module';
import { FlipperModule } from 'src/flipper/flipper.module';
import { PlayersModule } from 'src/players/players.module';
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
import { InlineService } from './inline.service';
import { MonitorService } from './monitor.service';
import { RadarService } from './radar.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { RecapService } from './recap.service';
import { ReferralService } from './referral.service';
import { SupportService } from './support.service';
import { TelegramBotService } from './telegram-bot.service';
import { TributeController } from './tribute.controller';
import { WebLinkService } from './web-link.service';

/**
 * Аккаунты и Telegram: вход через EXBO (основной аккаунт), подписка Pro,
 * привязка Telegram и бот (алерты цен, выброса, флипов).
 * Без TELEGRAM_BOT_TOKEN бот и алерты выключены, вход через EXBO работает.
 */
@Module({
  imports: [StalzoneModule, CollectorModule, FlipperModule, PlayersModule],
  controllers: [
    AuthController,
    MeController,
    AlertsController,
    FlipsController,
    SellController,
    ProAdminController,
    TributeController,
    AdminController,
    ReviewsController,
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
    SupportService,
    ReferralService,
    InlineService,
    MonitorService,
    RecapService,
    RadarService,
    ReviewsService,
  ],
})
export class TelegramModule {}
