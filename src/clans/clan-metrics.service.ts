import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  periodStart,
  periodStep,
  regionSeries,
  series,
  summarizeRegion,
  type RegionClan,
  type RegionEvent,
  type SeriesPeriod,
} from './clan-metrics';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** История пишется раз в час — график клана держим 5 минут, сводку и динамику региона — 10. */
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
  d_at: Date | null;
  w_members: number | null;
  w_at: Date | null;
}

interface EventRow {
  /** начало корзины, секунды с 1970 (UTC) */
  b: number;
  alliance: string | null;
  dm: number;
  dc: number;
}

/** Последний снимок клана не позже t — одна строка по индексу (clanId, at). */
const lastBefore = (t: Date) => Prisma.sql`
  SELECT s."memberCount", s."at" FROM "clan_snapshots" s
  WHERE s."clanId" = c."id" AND s."at" <= ${t}
  ORDER BY s."at" DESC LIMIT 1`;

/**
 * Метрики кланов по своей истории (clan_snapshots, пишет ClansService раз в час).
 * EXBO не даёт ни истории, ни рейтинга кланов — всё считается от первого прохода синхронизации.
 */
@Injectable()
export class ClanMetricsService {
  private readonly clanCache = new TtlCache<unknown>(500);
  private readonly regionCache = new TtlCache<unknown>(20);

  constructor(private readonly prisma: PrismaService) {}

  /** График бойцов клана за период. */
  clan(region: string, id: string, period: SeriesPeriod) {
    return this.clanCache.getOrLoad(`${id}|${period}`, CLAN_TTL_MS, () =>
      this.computeClan(region, id, period),
    );
  }

  /** Сводка по кланам региона (сейчас и за сутки / неделю). */
  region(region: string) {
    return this.regionCache.getOrLoad(region, REGION_TTL_MS, () =>
      this.computeRegion(region),
    );
  }

  /** Бойцы и кланы региона во времени — всего и по группировкам. */
  regionTrend(region: string, period: SeriesPeriod) {
    return this.regionCache.getOrLoad(
      `trend|${region}|${period}`,
      REGION_TTL_MS,
      () => this.computeTrend(region, period),
    );
  }

  private async computeClan(region: string, id: string, period: SeriesPeriod) {
    const c = await this.prisma.clan.findUnique({ where: { id } });
    if (!c || c.region !== region) {
      return { id, region, available: false as const };
    }
    const rows = await this.prisma.clanSnapshot.findMany({
      where: { clanId: id },
      orderBy: { at: 'asc' },
      select: { at: true, level: true, memberCount: true },
    });
    const snaps = rows.map((r) => ({
      at: r.at.getTime(),
      level: r.level,
      memberCount: r.memberCount,
    }));
    const now = Date.now();
    return {
      id,
      region,
      available: true as const,
      historyFrom: snaps[0] ? new Date(snaps[0].at).toISOString() : null,
      period,
      series: series(
        snaps,
        { at: now, level: c.level, memberCount: c.memberCount },
        now,
        period,
      ),
    };
  }

  /**
   * Изменения по корзинам времени: разница бойцов с прошлым снимком клана (первый снимок —
   * появление клана), минус состав распущенных в момент роспуска. Накопленную сумму
   * считает regionSeries.
   */
  private async computeTrend(region: string, period: SeriesPeriod) {
    const now = Date.now();
    const step = periodStep(period);
    const stepSec = step / 1000;
    const events = await this.prisma.$queryRaw<EventRow[]>`
      WITH s AS (
        SELECT s."at", c."alliance",
               s."memberCount" - COALESCE(LAG(s."memberCount") OVER w, 0) AS dm,
               CASE WHEN LAG(s."at") OVER w IS NULL THEN 1 ELSE 0 END AS dc
        FROM "clan_snapshots" s JOIN "clans" c ON c."id" = s."clanId"
        WHERE s."region" = ${region}
        WINDOW w AS (PARTITION BY s."clanId" ORDER BY s."at")
        UNION ALL
        SELECT c."goneAt", c."alliance", -c."memberCount", -1
        FROM "clans" c WHERE c."region" = ${region} AND c."goneAt" IS NOT NULL
      )
      SELECT (floor(extract(epoch FROM "at") / ${stepSec}) * ${stepSec})::float8 AS b,
             "alliance", sum(dm)::int AS dm, sum(dc)::int AS dc
      FROM s GROUP BY 1, 2 ORDER BY 1`;
    const list: RegionEvent[] = events.map((e) => ({
      t: e.b * 1000,
      alliance: e.alliance,
      dm: e.dm,
      dc: e.dc,
    }));
    const first = list[0]?.t ?? now;
    return {
      region,
      period,
      updatedAt: new Date(now).toISOString(),
      historyFrom: list.length ? new Date(first).toISOString() : null,
      points: regionSeries(list, periodStart(period, now, first), now, step),
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
             COALESCE(d."memberCount", f."memberCount") AS d_members, COALESCE(d."at", f."at") AS d_at,
             COALESCE(w."memberCount", f."memberCount") AS w_members, COALESCE(w."at", f."at") AS w_at
      FROM "clans" c
      LEFT JOIN LATERAL (${lastBefore(dayAgo)}) d ON true
      LEFT JOIN LATERAL (${lastBefore(weekAgo)}) w ON true
      LEFT JOIN LATERAL (
        SELECT s."memberCount", s."at" FROM "clan_snapshots" s
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
        ? { memberCount: r.d_members ?? 0, at: r.d_at.getTime() }
        : null,
      week: r.w_at
        ? { memberCount: r.w_members ?? 0, at: r.w_at.getTime() }
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
