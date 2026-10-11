import { Module } from '@nestjs/common';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { AlertsWatcher } from './alerts.watcher';
import { BotCommandsService } from './bot-commands.service';
import { TelegramAuthGuard } from './telegram-auth.guard';
import { TelegramBotService } from './telegram-bot.service';
import { WebLinkController } from './web-link.controller';
import { WebLinkService } from './web-link.service';

/** Telegram-бот: алерты цен и выброса. Без TELEGRAM_BOT_TOKEN модуль молча выключен. */
@Module({
  imports: [StalzoneModule],
  controllers: [AlertsController, WebLinkController],
  providers: [
    TelegramBotService,
    TelegramAuthGuard,
    AlertsService,
    AlertsWatcher,
    BotCommandsService,
    WebLinkService,
  ],
})
export class TelegramModule {}
