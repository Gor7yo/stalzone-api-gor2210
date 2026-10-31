import { Injectable } from '@nestjs/common';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import { lotId, pickExamples, toShowcase, type Showcase } from './showcase';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Витрина меняется медленно - пересчитываем раз в 5 минут на регион. */
const TTL_MS = 5 * MIN;
/** Кандидатов в примеры - самые прибыльные за 2 суток. */
const CANDIDATES = 30;

/**
 * Витрина флиппера для бесплатной версии (GET /api/flips/showcase): сколько флипов нашли за сутки,
 * сколько на них можно было заработать, лучший и пара уже ушедших целиком. Данные - журнал флипов.
 */
@Injectable()
export class ShowcaseService {
  private readonly cache = new TtlCache<Showcase>(4);

  constructor(private readonly prisma: PrismaService) {}

  get(region: string) {
    return this.cache.getOrLoad(region, TTL_MS, () => this.compute(region));
  }

  private async compute(region: string): Promise<Showcase> {
    const now = Date.now();
    // как в ленте по умолчанию: рискованные оценки не считаем
    const day = {
      region,
      seenAt: { gte: new Date(now - DAY) },
      confidence: { not: 'low' },
    };
    const [total, best, candidates] = await Promise.all([
      this.prisma.flipLog.aggregate({
        where: day,
        _count: true,
        _sum: { profit: true },
      }),
      this.prisma.flipLog.findFirst({
        where: day,
        orderBy: { profit: 'desc' },
      }),
      this.prisma.flipLog.findMany({
        where: { ...day, seenAt: { gte: new Date(now - 2 * DAY) } },
        orderBy: { profit: 'desc' },
        take: CANDIDATES,
      }),
    ]);

    // какие из них уже ушли с рынка - по базе сборщика
    const gone = candidates.length
      ? await this.prisma.auctionLot.findMany({
          where: {
            region,
            goneAt: { not: null },
            OR: candidates.map((c) => {
              const end = Math.floor(c.endTime.getTime() / 1000) * 1000;
              return {
                itemId: c.itemId,
                amount: c.amount,
                buyoutPrice: c.buyout,
                endTime: { gte: new Date(end), lt: new Date(end + 1000) },
              };
            }),
          },
          select: {
            itemId: true,
            amount: true,
            buyoutPrice: true,
            endTime: true,
            goneAt: true,
          },
        })
      : [];
    const goneAt = new Map(
      gone.flatMap((l) =>
        l.goneAt
          ? [
              [
                lotId(l.itemId, l.amount, l.buyoutPrice, l.endTime),
                l.goneAt,
              ] as const,
            ]
          : [],
      ),
    );

    return {
      region,
      count: total._count,
      profit: Number(total._sum.profit ?? 0),
      best: best && toShowcase(best),
      examples: pickExamples(candidates, goneAt, now),
    };
  }
}
