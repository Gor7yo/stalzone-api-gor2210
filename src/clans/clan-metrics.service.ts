import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  levelSince,
  peakMembers,
  series,
  summarizeRegion,
  WINDOWS,
  windowDelta,
  type RegionClan,
  type SeriesPeriod,
  type Snap,
} from './clan-metrics';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** История пишется раз в час — метрики клана держим 5 минут, сводку региона — 10. */
const CLAN_TTL_MS = 5 * MIN;
const REGION_TTL_MS = 10 * MIN;
/** Распущенных за неделю показываем столько. */
const GONE_LIST = 10;

interface RegionRow {
  id: string;
  tag: string;
  name: string;
  alliance: string | null;
  level: number;
  memberCount: number;
  registrationTime: Date | null;
  d_members: number | null;
  d_level: number | null;
  d_at: Date | null;
  w_members: number | null;
  w_level: number | null;
  w_at: Date | null;
}

/** Последний снимок клана не позже t — одна строка по индексу (clanId, at). */
const lastBefore = (t: Date) => Prisma.sql`
  SELECT s."memberCount", s."level", s."at" FROM "clan_snapshots" s
  WHERE s."clanId" = c."id" AND s."at" <= ${t}
  ORDER BY s."at" DESC LIMIT 1`;

/**
 * Метрики кланов по своей истории (clan_snapshots, пишет ClansService раз в час).
 * EXBO не даёт ни истории, ни рейтинга кланов — всё считается от первого прохода синхронизации.
 */
@Injectable()
export class ClanMetricsService {
  private readonly clanCache = new TtlCache<unknown>(500);
  private readonly regionCache = new TtlCache<unknown>(10);

  constructor(private readonly prisma: PrismaService) {}

  clan(region: string, id: string, period: SeriesPeriod) {
    return this.clanCache.getOrLoad(`${id}|${period}`, CLAN_TTL_MS, () =>
      this.computeClan(region, id, period),
    );
  }

  region(region: string) {
    return this.regionCache.getOrLoad(region, REGION_TTL_MS, () =>
      this.computeRegion(region),
    );
  }

  private async computeClan(region: string, id: string, period: SeriesPeriod) {
    const c = await this.prisma.clan.findUnique({ where: { id } });
    if (!c || c.region !== region) {
      return { id, region, available: false as const };
    }
    const [rows, bigger, total] = await Promise.all([
      this.prisma.clanSnapshot.findMany({
        where: { clanId: id },
        orderBy: { at: 'asc' },
        select: { at: true, level: true, memberCount: true },
      }),
      // место по численности: сколько живых кланов региона крупнее
      this.prisma.clan.count({
        where: { region, goneAt: null, memberCount: { gt: c.memberCount } },
      }),
      this.prisma.clan.count({ where: { region, goneAt: null } }),
    ]);
    const snaps: Snap[] = rows.map((r) => ({
      at: r.at.getTime(),
      level: r.level,
      memberCount: r.memberCount,
    }));
    const now = Date.now();
    const current: Snap = {
      at: now,
      level: c.level,
      memberCount: c.memberCount,
    };

    return {
      id,
      region,
      available: true as const,
      updatedAt: c.syncedAt.toISOString(),
      gone: c.goneAt?.toISOString() ?? null,
      historyFrom: snaps[0] ? new Date(snaps[0].at).toISOString() : null,
      current: { memberCount: c.memberCount, level: c.level },
      /** место по числу бойцов среди живых кланов региона (одинаковые — одно место) */
      sizePlace: { place: bigger + 1, of: total },
      windows: WINDOWS.map((w) => windowDelta(snaps, current, now, w)),
      peak: peakMembers(snaps, current),
      levelSince: levelSince(snaps, current),
      period,
      series: series(snaps, current, now, period),
    };
  }

  private async computeRegion(region: string) {
    const now = Date.now();
    const dayAgo = new Date(now - DAY);
    const weekAgo = new Date(now - 7 * DAY);

    // состояние каждого живого клана в начале суток и недели: последний снимок не позже,
    // а если клан моложе окна — самый ранний. Каждый подзапрос — одна строка по индексу (clanId, at)
    const rows = await this.prisma.$queryRaw<RegionRow[]>`
      SELECT c."id", c."tag", c."name", c."alliance", c."level", c."memberCount", c."registrationTime",
             COALESCE(d."memberCount", f."memberCount") AS d_members,
             COALESCE(d."level", f."level") AS d_level, COALESCE(d."at", f."at") AS d_at,
             COALESCE(w."memberCount", f."memberCount") AS w_members,
             COALESCE(w."level", f."level") AS w_level, COALESCE(w."at", f."at") AS w_at
      FROM "clans" c
      LEFT JOIN LATERAL (${lastBefore(dayAgo)}) d ON true
      LEFT JOIN LATERAL (${lastBefore(weekAgo)}) w ON true
      LEFT JOIN LATERAL (
        SELECT s."memberCount", s."level", s."at" FROM "clan_snapshots" s
        WHERE s."clanId" = c."id" ORDER BY s."at" ASC LIMIT 1
      ) f ON true
      WHERE c."region" = ${region} AND c."goneAt" IS NULL`;

    const clans: RegionClan[] = rows.map((r) => ({
      id: r.id,
      tag: r.tag,
      name: r.name,
      alliance: r.alliance,
      level: r.level,
      memberCount: r.memberCount,
      registrationTime: r.registrationTime?.getTime() ?? null,
      day: r.d_at
        ? {
            memberCount: r.d_members ?? 0,
            level: r.d_level ?? 0,
            at: r.d_at.getTime(),
          }
        : null,
      week: r.w_at
        ? {
            memberCount: r.w_members ?? 0,
            level: r.w_level ?? 0,
            at: r.w_at.getTime(),
          }
        : null,
    }));

    const [goneCount, gone, first] = await Promise.all([
      this.prisma.clan.count({ where: { region, goneAt: { gte: weekAgo } } }),
      this.prisma.clan.findMany({
        where: { region, goneAt: { gte: weekAgo } },
        orderBy: [{ memberCount: 'desc' }, { goneAt: 'desc' }],
        take: GONE_LIST,
        select: {
          id: true,
          tag: true,
          name: true,
          alliance: true,
          level: true,
          memberCount: true,
          goneAt: true,
        },
      }),
      this.prisma.clanSnapshot.findFirst({
        where: { region },
        orderBy: { at: 'asc' },
        select: { at: true },
      }),
    ]);

    return {
      region,
      updatedAt: new Date(now).toISOString(),
      historyFrom: first?.at.toISOString() ?? null,
      ...summarizeRegion(clans, now, first?.at.getTime() ?? null),
      disbanded: {
        count: goneCount,
        list: gone.map((g) => ({ ...g, goneAt: g.goneAt!.toISOString() })),
      },
    };
  }
}
