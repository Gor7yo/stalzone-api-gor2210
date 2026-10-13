import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from 'generated/prisma/client';
import type { IClanInfo, IClansList } from 'src/api/api.constants';
import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { BudgetExhaustedError } from 'src/stalzone/api/token-budget';
import { escapeLike, queryVariants, searchKey } from './clan-search';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Кланов на странице списка EXBO (максимум API). */
const PAGE = 100;
/** Список кланов меняется медленно: полный проход раз в 6 часов (~80 запросов на все регионы). */
const SYNC_EVERY_MS = 6 * HOUR;
/** Первый проход — через минуту после старта, чтобы не мешать прогреву сборщика. */
const FIRST_SYNC_MS = MIN;
/**
 * Клан, которого не видели два прохода подряд, распущен. Один пропуск — не повод:
 * пока листаем страницы, кланы меняются местами в рейтинге и могут «перескочить» страницу.
 */
const GONE_AFTER_MS = 2 * SYNC_EVERY_MS + HOUR;
/** Квоты EXBO нет — ждём и пробуем ту же страницу ещё раз. */
const RETRY_MS = 10_000;
const MAX_RETRIES = 30;
/** Ответы поиска живут 30 с: список обновляется раз в 6 часов. */
const SEARCH_TTL_MS = 30_000;
/** Короче — триграммный индекс не помогает, ищем только по началу тега и названия. */
const MIN_SUBSTRING = 3;

export interface ClanHit {
  id: string;
  region: string;
  name: string;
  tag: string;
  leader: string;
  level: number;
  levelPoints: number;
  memberCount: number;
  alliance: string | null;
  registrationTime: string | null;
  description: string;
  /** место в рейтинге региона */
  rank: number;
}

/** Страница рейтинга из БД — в том же виде, что список EXBO (+ место в рейтинге). */
export interface ClanPage {
  totalClans: number;
  data: ClanHit[];
}

export interface ClanSearchResult {
  region: string;
  query: string;
  /** сколько всего кланов подходит (в data — первые limit) */
  total: number;
  data: ClanHit[];
  /** когда список кланов региона последний раз обновлялся; null — ещё не загружен */
  syncedAt: string | null;
}

interface HitRow extends Omit<ClanHit, 'levelPoints' | 'registrationTime'> {
  levelPoints: bigint;
  registrationTime: Date | null;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ключ в app_state: регион загружен целиком, значение — когда. */
const READY_KEY = 'clans-synced:';
/** Страница списка из БД: кеш на минуту (список обновляется раз в 6 часов). */
const LIST_TTL_MS = MIN;

const CLAN_COLUMNS = Prisma.sql`"id", "region", "name", "tag", "leader", "level", "levelPoints",
  "memberCount", "alliance", "registrationTime", "description", "rank"`;

const toHit = (r: Omit<HitRow, 'total'>): ClanHit => ({
  id: r.id,
  region: r.region,
  name: r.name,
  tag: r.tag,
  leader: r.leader,
  level: r.level,
  levelPoints: Number(r.levelPoints),
  memberCount: r.memberCount,
  alliance: r.alliance,
  registrationTime: r.registrationTime?.toISOString() ?? null,
  description: r.description,
  rank: r.rank,
});

/**
 * Кланы: своя копия списка EXBO (у EXBO нет поиска кланов) и поиск по ней.
 *
 * Синхронизация: раз в SYNC_EVERY_MS листаем весь список каждого региона фоновыми
 * запросами (берут только остаток квоты, пользователей не тормозят).
 * Поиск: подстрока в названии, теге или нике лидера — LIKE по триграммному индексу
 * (pg_trgm) на searchKey, плюс тот же запрос в другой раскладке.
 */
@Injectable()
export class ClansService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ClansService.name);
  private readonly cache = new TtlCache<ClanSearchResult>(500);
  private readonly listCache = new TtlCache<ClanPage>(500);
  /** Когда регион последний раз загружен целиком (из app_state); null — ещё ни разу */
  private readonly readyCache = new TtlCache<Date | null>(10);
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private syncing = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('CLAN_SYNC_ENABLED') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.log.log('Синхронизация кланов выключена');
      return;
    }
    this.timer = setTimeout(() => void this.syncLoop(), FIRST_SYNC_MS);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async syncLoop() {
    await this.syncAll();
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.syncLoop(), SYNC_EVERY_MS);
    }
  }

  async syncAll() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const region of REGIONS) {
        if (this.stopped) return;
        try {
          await this.syncRegion(region);
        } catch (e) {
          this.log.warn(`кланы ${region}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Весь список региона страницами по PAGE; ранг — позиция в списке EXBO. */
  private async syncRegion(region: Region) {
    const started = Date.now();
    let total = Infinity;
    let seen = 0;
    for (let offset = 0; offset < total; offset += PAGE) {
      if (this.stopped) return;
      const page = await this.fetchPage(region, offset);
      total = page.totalClans;
      if (!page.data.length) break;
      await this.save(region, page.data, offset);
      seen += page.data.length;
    }
    const { count: gone } = await this.prisma.clan.deleteMany({
      where: { region, syncedAt: { lt: new Date(started - GONE_AFTER_MS) } },
    });
    // регион загружен целиком — с этого момента список и поиск отдаём из БД
    const key = `${READY_KEY}${region}`;
    const value = new Date().toISOString();
    await this.prisma.appState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.readyCache.clear();
    this.cache.clear();
    this.listCache.clear();
    this.log.log(
      `кланы ${region}: ${seen} из ${total} за ${Math.round((Date.now() - started) / 1000)} с` +
        (gone ? `, удалено распущенных ${gone}` : ''),
    );
  }

  private async fetchPage(region: Region, offset: number) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.stalcraft.get<IClansList>(
          [region, 'clans'],
          { offset, limit: PAGE },
          0,
          'background',
        );
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError) || attempt >= MAX_RETRIES) {
          throw e;
        }
        await sleep(RETRY_MS);
      }
    }
  }

  /** Страница одним запросом: INSERT … SELECT FROM unnest(массивы) ON CONFLICT DO UPDATE. */
  private async save(region: Region, clans: IClanInfo[], offset: number) {
    const col = <T>(f: (c: IClanInfo, i: number) => T) => clans.map(f);
    const tagKey = col((c) => searchKey(c.tag ?? ''));
    const nameKey = col((c) => searchKey(c.name ?? ''));
    const leaderKey = col((c) => searchKey(c.leader ?? ''));
    await this.prisma.$executeRaw`
      INSERT INTO "clans" ("id", "region", "name", "tag", "leader", "level", "levelPoints",
        "memberCount", "alliance", "registrationTime", "description", "rank",
        "tagKey", "nameKey", "leaderKey", "searchKey", "syncedAt")
      SELECT u.*, now() FROM unnest(
        ${col((c) => c.id)}::text[],
        ${col(() => region)}::text[],
        ${col((c) => c.name ?? '')}::text[],
        ${col((c) => c.tag ?? '')}::text[],
        ${col((c) => c.leader ?? '')}::text[],
        ${col((c) => c.level ?? 0)}::int[],
        ${col((c) => String(c.levelPoints ?? 0))}::bigint[],
        ${col((c) => c.memberCount ?? 0)}::int[],
        ${col((c) => c.alliance ?? null)}::text[],
        ${col((c) => (c.registrationTime ? new Date(c.registrationTime).toISOString() : null))}::timestamp[],
        ${col((c) => c.description ?? '')}::text[],
        ${col((_, i) => offset + i + 1)}::int[],
        ${tagKey}::text[],
        ${nameKey}::text[],
        ${leaderKey}::text[],
        ${col((_, i) => `${tagKey[i]}\n${nameKey[i]}\n${leaderKey[i]}`)}::text[]
      ) AS u
      ON CONFLICT ("id") DO UPDATE SET
        "region" = EXCLUDED."region", "name" = EXCLUDED."name", "tag" = EXCLUDED."tag",
        "leader" = EXCLUDED."leader", "level" = EXCLUDED."level",
        "levelPoints" = EXCLUDED."levelPoints", "memberCount" = EXCLUDED."memberCount",
        "alliance" = EXCLUDED."alliance", "registrationTime" = EXCLUDED."registrationTime",
        "description" = EXCLUDED."description", "rank" = EXCLUDED."rank",
        "tagKey" = EXCLUDED."tagKey", "nameKey" = EXCLUDED."nameKey",
        "leaderKey" = EXCLUDED."leaderKey", "searchKey" = EXCLUDED."searchKey",
        "syncedAt" = EXCLUDED."syncedAt"`;
  }

  /** Когда регион последний раз загружен целиком; null — ещё ни разу (отвечаем по EXBO). */
  private readyAt(region: string) {
    return this.readyCache.getOrLoad(region, MIN, async () => {
      const row = await this.prisma.appState.findUnique({
        where: { key: `${READY_KEY}${region}` },
      });
      return row ? new Date(row.value) : null;
    });
  }

  /**
   * Страница рейтинга кланов из БД в формате списка EXBO; null — регион ещё
   * не загружен целиком, пусть отвечает EXBO.
   */
  async list(
    region: string,
    offset: number,
    limit: number,
  ): Promise<ClanPage | null> {
    if (!(await this.readyAt(region))) return null;
    return this.listCache.getOrLoad(
      `${region}|${offset}|${limit}`,
      LIST_TTL_MS,
      async () => {
        const [rows, totalClans] = await Promise.all([
          this.prisma.$queryRaw<Omit<HitRow, 'total'>[]>`
            SELECT ${CLAN_COLUMNS} FROM "clans" WHERE "region" = ${region}
            ORDER BY "rank", "id" OFFSET ${offset} LIMIT ${limit}`,
          this.prisma.clan.count({ where: { region } }),
        ]);
        return {
          totalClans,
          data: rows.map(toHit),
        };
      },
    );
  }

  search(region: string, query: string, limit: number) {
    const key = `${region}|${limit}|${searchKey(query)}`;
    return this.cache.getOrLoad(key, SEARCH_TTL_MS, () =>
      this.find(region, query, limit),
    );
  }

  private async find(
    region: string,
    query: string,
    limit: number,
  ): Promise<ClanSearchResult> {
    const variants = queryVariants(query);
    const ready = await this.readyAt(region);
    const base = { region, query, syncedAt: ready?.toISOString() ?? null };
    if (!ready || !variants.length) return { ...base, total: 0, data: [] };

    // подходит: подстрока где угодно (или, если запрос короткий, начало тега / названия)
    const match = variants.map((v) => {
      const e = escapeLike(v);
      return v.length < MIN_SUBSTRING
        ? Prisma.sql`("tagKey" LIKE ${`${e}%`} OR "nameKey" LIKE ${`${e}%`})`
        : Prisma.sql`"searchKey" LIKE ${`%${e}%`}`;
    });
    // порядок: точный тег, точное название, начало тега, начало названия, ник лидера,
    // подстрока в теге или названии, подстрока в нике лидера
    const score = variants.map((v) => {
      const e = escapeLike(v);
      return Prisma.sql`CASE
        WHEN "tagKey" = ${v} THEN 0
        WHEN "nameKey" = ${v} THEN 1
        WHEN "tagKey" LIKE ${`${e}%`} THEN 2
        WHEN "nameKey" LIKE ${`${e}%`} THEN 3
        WHEN "leaderKey" = ${v} THEN 4
        WHEN "tagKey" LIKE ${`%${e}%`} OR "nameKey" LIKE ${`%${e}%`} THEN 5
        ELSE 6 END`;
    });

    const rows = await this.prisma.$queryRaw<HitRow[]>`
      SELECT ${CLAN_COLUMNS}, count(*) OVER ()::int AS total
      FROM "clans"
      WHERE "region" = ${region} AND (${Prisma.join(match, ' OR ')})
      ORDER BY LEAST(${Prisma.join(score, ', ')}), "rank"
      LIMIT ${limit}`;

    return { ...base, total: rows[0]?.total ?? 0, data: rows.map(toHit) };
  }
}
