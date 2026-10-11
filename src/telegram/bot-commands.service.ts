import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { AlertsService } from './alerts.service';
import {
  alertTitle,
  deepLink,
  escapeHtml,
  formatShort,
  REGION_LABEL,
} from './format';
import {
  InlineButton,
  TelegramBotService,
  TgMessage,
  TgUpdate,
} from './telegram-bot.service';
import { LINK_CODE_RE, WebLinkService } from './web-link.service';

/** Команды бота и нажатия inline-кнопок. Работает только в личке с ботом. */
@Injectable()
export class BotCommandsService implements OnModuleInit {
  private readonly appUrl?: string;

  constructor(
    private readonly bot: TelegramBotService,
    private readonly alerts: AlertsService,
    private readonly webLink: WebLinkService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('TELEGRAM_APP_URL')?.trim() || undefined;
  }

  onModuleInit() {
    this.bot.onUpdate((u) => this.handle(u));
    this.bot.onBlocked = (chatId) => this.alerts.markBlocked(chatId);
  }

  private async handle(update: TgUpdate) {
    if (update.callback_query) return this.handleCallback(update);

    const msg = update.message;
    if (!msg?.text || !msg.from || msg.chat.type !== 'private') return;
    const command = msg.text.split(/[\s@]/)[0].toLowerCase();

    switch (command) {
      case '/start': {
        await this.alerts.upsertSubscriber(msg.from);
        // t.me/<бот>?start=link_<код> — привязка сайта
        const payload = msg.text.split(' ')[1] ?? '';
        if (payload.startsWith('link_')) {
          return this.askLink(msg.chat.id, payload.slice(5));
        }
        return this.start(msg.chat.id);
      }
      case '/alerts':
        return this.list(msg.chat.id);
      case '/emission':
        await this.alerts.upsertSubscriber(msg.from);
        return this.emissionMenu(msg.chat.id);
      case '/stop':
        await this.alerts.clearAll(msg.chat.id);
        return void this.bot.send(
          msg.chat.id,
          'Все уведомления отключены. Включить снова — /emission или 🔔 на странице предмета.',
        );
      default:
        return this.start(msg.chat.id);
    }
  }

  private async start(chatId: number) {
    const link = deepLink(this.appUrl, '/');
    await this.bot.send(
      chatId,
      [
        '<b>Сталкер, я пришлю уведомление, когда:</b>',
        '🔔 предмет на аукционе стал дешевле твоего порога — включается кнопкой 🔔 на странице предмета в приложении;',
        '☢️ начался выброс — /emission',
        '',
        'Список алертов — /alerts, отключить всё — /stop',
      ].join('\n'),
      link ? [[{ text: 'Открыть Stalzone', url: link }]] : [],
    );
  }

  /** Подтверждение кнопкой: чужая ссылка, открытая по ошибке, ничего не привяжет. */
  private async askLink(chatId: number, code: string) {
    if (!LINK_CODE_RE.test(code)) return this.start(chatId);
    await this.bot.send(
      chatId,
      [
        '🔗 <b>Привязать сайт Stalzone к этому Telegram?</b>',
        'Уведомления, включённые на сайте, будут приходить сюда.',
        '',
        'Если вы не нажимали «Привязать Telegram» на сайте — просто проигнорируйте это сообщение.',
      ].join('\n'),
      [[{ text: '✅ Привязать', callback_data: `lnk:${code}` }]],
    );
  }

  private async list(chatId: number) {
    const { emission, price } = await this.alerts.overview(chatId);
    const lines = [
      `☢️ Выброс: ${emission.length ? emission.map((r) => REGION_LABEL[r]).join(', ') : 'выкл.'}`,
      '',
      price.length
        ? '<b>Алерты цен:</b>'
        : 'Алертов цен нет — включаются кнопкой 🔔 на странице предмета.',
      ...price.map(
        (a, i) =>
          `${i + 1}. ${escapeHtml(alertTitle(a))} · ${REGION_LABEL[a.region as Region] ?? a.region} — до ${formatShort(a.maxPrice)}`,
      ),
    ];
    const buttons: InlineButton[][] = price.map((a, i) => [
      { text: `Удалить ${i + 1}`, callback_data: `del:${a.id}` },
    ]);
    await this.bot.send(chatId, lines.join('\n'), buttons);
  }

  private emissionButtons(enabled: Region[]): InlineButton[][] {
    return [
      REGIONS.map((r) => ({
        text: `${enabled.includes(r) ? '✅' : '▫️'} ${REGION_LABEL[r]}`,
        callback_data: `em:${r}`,
      })),
    ];
  }

  private async emissionMenu(chatId: number) {
    const { emission } = await this.alerts.overview(chatId);
    await this.bot.send(
      chatId,
      '☢️ О выбросе в каких регионах сообщать?',
      this.emissionButtons(emission),
    );
  }

  private async handleCallback(update: TgUpdate) {
    const q = update.callback_query!;
    const message: TgMessage | undefined = q.message;
    const [action, arg] = (q.data ?? '').split(':');
    let notice = '';

    if (action === 'em' && (REGIONS as readonly string[]).includes(arg)) {
      const region = arg as Region;
      const { emission } = await this.alerts.overview(q.from.id);
      const enabled = !emission.includes(region);
      const next = await this.alerts.setEmission(q.from, region, enabled);
      notice = `${REGION_LABEL[region]}: ${enabled ? 'включено' : 'выключено'}`;
      if (message) {
        await this.bot
          .call('editMessageReplyMarkup', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: this.emissionButtons(next) },
          })
          .catch(() => {});
      }
    } else if (action === 'lnk' && LINK_CODE_RE.test(arg ?? '')) {
      await this.alerts.upsertSubscriber(q.from);
      const ok = await this.webLink.confirm(arg, q.from);
      notice = ok ? 'Готово!' : 'Ссылка устарела';
      if (message) {
        await this.bot
          .call('editMessageText', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'HTML',
            text: ok
              ? '✅ <b>Сайт привязан.</b> Вернитесь на сайт — уведомления можно включать.'
              : '⌛ Ссылка устарела. Нажмите «Привязать Telegram» на сайте ещё раз.',
          })
          .catch(() => {});
      }
    } else if (action === 'del' && arg) {
      notice = await this.alerts
        .deletePrice(q.from.id, arg)
        .then(() => 'Алерт удалён')
        .catch(() => 'Алерт уже удалён');
    }

    await this.bot
      .call('answerCallbackQuery', { callback_query_id: q.id, text: notice })
      .catch(() => {});
  }
}
