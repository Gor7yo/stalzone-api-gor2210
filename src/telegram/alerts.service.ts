import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Region } from 'src/api/dto/queries.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreatePriceAlertDto } from './dto/alerts.dto';

/** Больше алертов на человека — это уже не алерты, а нагрузка на квоту STALCRAFT API. */
export const MAX_PRICE_ALERTS = 20;

export interface SubscriberInfo {
  id: number;
  first_name?: string;
  username?: string;
}

/** Ответ для мини-приложения: chatId (BigInt) наружу не отдаём. */
const publicAlert = {
  id: true,
  region: true,
  itemId: true,
  itemName: true,
  quality: true,
  upgrade: true,
  maxPrice: true,
  lastNotifiedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Регистрирует пользователя (или снимает пометку «заблокировал бота»). */
  upsertSubscriber(user: SubscriberInfo) {
    const data = {
      firstName: user.first_name ?? null,
      username: user.username ?? null,
      blocked: false,
    };
    return this.prisma.telegramSubscriber.upsert({
      where: { chatId: BigInt(user.id) },
      create: { chatId: BigInt(user.id), ...data },
      update: data,
    });
  }

  async overview(chatId: number) {
    const [subscriber, price] = await Promise.all([
      this.prisma.telegramSubscriber.findUnique({
        where: { chatId: BigInt(chatId) },
        select: { emissionRegions: true, blocked: true },
      }),
      this.listPrice(chatId),
    ]);
    return {
      emission: (subscriber?.emissionRegions ?? []) as Region[],
      blocked: subscriber?.blocked ?? false,
      price,
    };
  }

  listPrice(chatId: number) {
    return this.prisma.priceAlert.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: { createdAt: 'asc' },
      select: publicAlert,
    });
  }

  async createPrice(user: SubscriberInfo, dto: CreatePriceAlertDto) {
    await this.upsertSubscriber(user);
    const chatId = BigInt(user.id);
    const count = await this.prisma.priceAlert.count({ where: { chatId } });
    if (count >= MAX_PRICE_ALERTS) {
      throw new BadRequestException(
        `Не больше ${MAX_PRICE_ALERTS} алертов — удалите ненужные`,
      );
    }
    return this.prisma.priceAlert.create({
      data: {
        chatId,
        region: dto.region,
        itemId: dto.itemId,
        itemName: dto.itemName.trim(),
        quality: dto.quality ?? null,
        upgrade: dto.upgrade ?? null,
        maxPrice: dto.maxPrice,
      },
      select: publicAlert,
    });
  }

  async deletePrice(chatId: number, id: string) {
    const { count } = await this.prisma.priceAlert.deleteMany({
      where: { id, chatId: BigInt(chatId) },
    });
    if (!count) throw new NotFoundException('Алерт не найден');
  }

  async setEmission(user: SubscriberInfo, region: Region, enabled: boolean) {
    const subscriber = await this.upsertSubscriber(user);
    const regions = new Set(subscriber.emissionRegions);
    if (enabled) regions.add(region);
    else regions.delete(region);
    const updated = await this.prisma.telegramSubscriber.update({
      where: { chatId: subscriber.chatId },
      data: { emissionRegions: [...regions].sort() },
    });
    return updated.emissionRegions as Region[];
  }

  /** /stop: снять все подписки. */
  async clearAll(chatId: number) {
    await this.prisma.$transaction([
      this.prisma.priceAlert.deleteMany({ where: { chatId: BigInt(chatId) } }),
      this.prisma.telegramSubscriber.updateMany({
        where: { chatId: BigInt(chatId) },
        data: { emissionRegions: [] },
      }),
    ]);
  }

  async markBlocked(chatId: number) {
    await this.prisma.telegramSubscriber.updateMany({
      where: { chatId: BigInt(chatId) },
      data: { blocked: true },
    });
  }
}
