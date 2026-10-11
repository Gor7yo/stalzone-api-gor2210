import { Module } from '@nestjs/common';
import { CollectorModule } from 'src/collector/collector.module';
import { FlipperModule } from 'src/flipper/flipper.module';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { AlertsWatcher } from './alerts.watcher';
import { BotCommandsService } from './bot-commands.service';
import {
  FlipsController,
  MeController,
  ProAdminController,
} from './pro.controller';
import { ProService } from './pro.service';
import { TelegramAuthGuard } from './telegram-auth.guard';
import { TelegramBotService } from './telegram-bot.service';
import { WebLinkController } from './web-link.controller';
import { WebLinkService } from './web-link.service';

/**
 * Telegram: бот (алерты цен, выброса, флипов), привязка сайта и подписка Pro —
 * всё, что знает пользователя по его аккаунту Telegram.
 * Без TELEGRAM_BOT_TOKEN модуль молча выключен.
 */
@Module({
  imports: [StalzoneModule, CollectorModule, FlipperModule],
  controllers: [
    AlertsController,
    WebLinkController,
    MeController,
    FlipsController,
    ProAdminController,
  ],
  providers: [
    TelegramBotService,
    TelegramAuthGuard,
    AlertsService,
    AlertsWatcher,
    BotCommandsService,
    WebLinkService,
    ProService,
  ],
})
export class TelegramModule {}
