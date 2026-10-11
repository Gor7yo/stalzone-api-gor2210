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
import { AlertsService } from './alerts.service';
import {
  AlertIdParam,
  CreatePriceAlertDto,
  EmissionToggleDto,
  FlipAlertDto,
  RegionParam,
} from './dto/alerts.dto';
import { TelegramAuthGuard, type TelegramRequest } from './telegram-auth.guard';

/** Алерты текущего пользователя Telegram (управление из мини-приложения). */
@Controller('api/alerts')
@UseGuards(TelegramAuthGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  overview(@Req() req: TelegramRequest) {
    return this.alerts.overview(req.tgUser.id);
  }

  @Post('price')
  createPrice(@Req() req: TelegramRequest, @Body() dto: CreatePriceAlertDto) {
    return this.alerts.createPrice(req.tgUser, dto);
  }

  @Delete('price/:id')
  @HttpCode(204)
  deletePrice(@Req() req: TelegramRequest, @Param() { id }: AlertIdParam) {
    return this.alerts.deletePrice(req.tgUser.id, id);
  }

  /** Включить или поменять флип-алерт региона. */
  @Put('flip')
  setFlip(@Req() req: TelegramRequest, @Body() dto: FlipAlertDto) {
    return this.alerts.setFlip(req.tgUser, dto);
  }

  @Delete('flip/:region')
  @HttpCode(204)
  deleteFlip(@Req() req: TelegramRequest, @Param() { region }: RegionParam) {
    return this.alerts.deleteFlip(req.tgUser.id, region);
  }

  @Put('emission')
  async setEmission(
    @Req() req: TelegramRequest,
    @Body() dto: EmissionToggleDto,
  ) {
    const emission = await this.alerts.setEmission(
      req.tgUser,
      dto.region,
      dto.enabled,
    );
    return { emission };
  }
}
