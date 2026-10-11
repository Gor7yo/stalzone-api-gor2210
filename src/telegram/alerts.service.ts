import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Region } from 'src/api/dto/queries.dto';
import { CollectorService } from 'src/collector/collector.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  FlipperService,
  matchesFlip,
  MIN_PCT,
} from 'src/flipper/flipper.service';
import type { CreatePriceAlertDto, FlipAlertDto } from './dto/alerts.dto';
import { PRICE_ALERT_LIMIT, ProService } from './pro.service';

/** Сколько последних отправленных лотов помнит флип-алерт. */
export const MAX_SENT_KEYS = 300;

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
  qualities: true,
  upgrade: true,
  upgrades: true,
  maxPrice: true,
  lastNotifiedAt: true,
  createdAt: true,
} as const;

const publicFlipAlert = {
  id: true,
  region: true,
  minProfit: true,
  minPct: true,
  minConfidence: true,
  maxBudget: true,
  groups: true,
  lastNotifiedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
    private readonly flipper: FlipperService,
    private readonly pro: ProService,
  ) {}

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
    const [subscriber, price, flip] = await Promise.all([
      this.prisma.telegramSubscriber.findUnique({
        where: { chatId: BigInt(chatId) },
        select: { emissionRegions: true, blocked: true },
      }),
      this.listPrice(chatId),
      this.listFlip(chatId),
    ]);
    return {
      emission: (subscriber?.emissionRegions ?? []) as Region[],
      blocked: subscriber?.blocked ?? false,
      price,
      flip,
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
    const { pro, limits } = await this.pro.status(chatId);
    const count = await this.prisma.priceAlert.count({ where: { chatId } });
    if (count >= limits.priceAlerts) {
      throw new ForbiddenException({
        statusCode: 403,
        code: pro ? 'limit' : 'pro_required',
        message: pro
          ? `Не больше ${limits.priceAlerts} алертов — удалите ненужные`
          : `В бесплатной версии ${limits.priceAlerts} алерт. В Pro — до ${PRICE_ALERT_LIMIT.pro}`,
      });
    }
    // качество и заточка в алерте — только в Pro (в бесплатной версии их и не выбрать)
    if (!pro) {
      dto = {
        ...dto,
        quality: undefined,
        qualities: [],
        upgrade: undefined,
        upgrades: [],
      };
    }
    // наборы без повторов и по порядку — так их удобно показывать («Особый, Редкий +1, +5…+7»)
    const uniq = (list?: number[]) =>
      [...new Set(list ?? [])].sort((a, b) => a - b);
    const upgrades = uniq(dto.upgrades);
    const qualities = uniq(dto.qualities);
    // предмет с алертом сборщик держит в списке и обновляет чаще
    void this.collector.touch(dto.region, dto.itemId, 'alert');
    return this.prisma.priceAlert.create({
      data: {
        chatId,
        region: dto.region,
        itemId: dto.itemId,
        itemName: dto.itemName.trim(),
        quality: qualities.length ? null : (dto.quality ?? null),
        qualities,
        upgrade: upgrades.length ? null : (dto.upgrade ?? null),
        upgrades,
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

  listFlip(chatId: number) {
    return this.prisma.flipAlert.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: { createdAt: 'asc' },
      select: publicFlipAlert,
    });
  }

  /** Включить или поменять флип-алерт региона (один на человека и регион). */
  async setFlip(user: SubscriberInfo, dto: FlipAlertDto) {
    await this.upsertSubscriber(user);
    const chatId = BigInt(user.id);
    await this.pro.require(chatId);
    const data = {
      minProfit: dto.minProfit,
      minPct: dto.minPct ?? MIN_PCT,
      minConfidence: dto.minConfidence ?? 'medium',
      maxBudget: dto.maxBudget ?? 0,
      groups: [...new Set(dto.groups ?? [])].sort(),
    };
    // о лотах, которые уже висят в ленте, не сообщаем: человек их и так видит в приложении
    const feed = await this.flipper.feed(dto.region).catch(() => null);
    const current = (feed?.flips ?? [])
      .filter((f) => matchesFlip(f, data))
      .map((f) => f.key)
      .slice(0, MAX_SENT_KEYS);
    return this.prisma.flipAlert.upsert({
      where: { chatId_region: { chatId, region: dto.region } },
      create: { chatId, region: dto.region, ...data, sentKeys: current },
      update: { ...data, sentKeys: { push: current } },
      select: publicFlipAlert,
    });
  }

  async deleteFlip(chatId: number, region: string) {
    const { count } = await this.prisma.flipAlert.deleteMany({
      where: { chatId: BigInt(chatId), region },
    });
    if (!count) throw new NotFoundException('Флип-алерт не найден');
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
      this.prisma.flipAlert.deleteMany({ where: { chatId: BigInt(chatId) } }),
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
