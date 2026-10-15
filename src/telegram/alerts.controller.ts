import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccountGuard, type AccountRequest, chatOf } from './account.guard';
import { AlertsService } from './alerts.service';
import {
  AlertIdParam,
  CreatePriceAlertDto,
  EmissionToggleDto,
  FlipAlertDto,
  RegionParam,
} from './dto/alerts.dto';

/**
 * Алерты аккаунта. Уведомления приходят в бота, поэтому алерты живут на привязанном
 * Telegram: без него - 409 telegram_required (кроме просмотра).
 */
@Controller('api/alerts')
@UseGuards(AccountGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  overview(@Req() req: AccountRequest) {
    const { chatId } = req.account;
    if (chatId == null) {
      return {
        telegram: false,
        emission: [],
        blocked: false,
        price: [],
        flip: [],
      };
    }
    return this.alerts
      .overview(Number(chatId))
      .then((o) => ({ telegram: true, ...o }));
  }

  @Post('price')
  createPrice(@Req() req: AccountRequest, @Body() dto: CreatePriceAlertDto) {
    return this.alerts.createPrice(this.chat(req), dto);
  }

  @Delete('price/:id')
  @HttpCode(204)
  deletePrice(@Req() req: AccountRequest, @Param() { id }: AlertIdParam) {
    return this.alerts.deletePrice(Number(chatOf(req.account)), id);
  }

  /** Включить или поменять флип-алерт региона. */
  @Put('flip')
  setFlip(@Req() req: AccountRequest, @Body() dto: FlipAlertDto) {
    return this.alerts.setFlip(this.chat(req), dto);
  }

  @Delete('flip/:region')
  @HttpCode(204)
  deleteFlip(@Req() req: AccountRequest, @Param() { region }: RegionParam) {
    return this.alerts.deleteFlip(Number(chatOf(req.account)), region);
  }

  @Put('emission')
  async setEmission(
    @Req() req: AccountRequest,
    @Body() dto: EmissionToggleDto,
  ) {
    const emission = await this.alerts.setEmission(
      this.chat(req),
      dto.region,
      dto.enabled,
    );
    return { emission };
  }

  /** Получатель алертов: Telegram аккаунта (с именем, если запрос из мини-приложения). */
  private chat(req: AccountRequest) {
    const id = Number(chatOf(req.account));
    return req.tgUser?.id === id ? req.tgUser : { id };
  }
}
