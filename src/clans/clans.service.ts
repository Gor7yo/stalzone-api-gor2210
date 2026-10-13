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
/**
 * Полный проход раз в час (~80 запросов на все регионы при квоте 400 в минуту):
 * столько нужно для почасовой истории метрик (рост очков за сутки).
 */
const SYNC_EVERY_MS = HOUR;
/** Первый проход — через минуту после старта, чтобы не мешать прогреву сборщика. */
const FIRST_SYNC_MS = MIN;
/**
 * Клан, которого не видели три прохода подряд, распущен. Один-два пропуска — не повод:
 * пока листаем страницы, кланы меняются местами в выдаче EXBO и могут «перескочить» страницу.
 */
const GONE_AFTER_MS = 3 * SYNC_EVERY_MS + 30 * MIN;
/** Распущенные кланы держим 90 дней (для сводки «распущенные»), потом удаляем строку. */
const GONE_KEEP_MS = 90 * 24 * HOUR;
/** Почасовые снимки старше этого сжимаем до последнего снимка дня. */
const HOURLY_KEEP_DAYS = 14;
/** Сжатие истории — раз в сутки. */
const COMPACT_EVERY_MS = 24 * HOUR;
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
}

/** Страница списка кланов из БД — в том же виде, что список EXBO. */
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
  "memberCount", "alliance", "registrationTime", "description"`;

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

  /** Проходы — раз в SYNC_EVERY_MS от начала прошлого (а не от конца), чтобы точки истории шли ровно по часам. */
  private async syncLoop() {
    const started = Date.now();
    await this.syncAll();
    await this.compactIfDue().catch((e: Error) =>
      this.log.warn(`сжатие истории кланов: ${e.message}`),
    );
    if (!this.stopped) {
      const wait = Math.max(MIN, started + SYNC_EVERY_MS - Date.now());
      this.timer = setTimeout(() => void this.syncLoop(), wait);
    }
  }

  /**
   * Раз в сутки: почасовые снимки старше HOURLY_KEEP_DAYS сжимаем до последнего снимка
   * каждого дня, распущенные кланы старше GONE_KEEP_MS удаляем.
   */
  private async compactIfDue() {
    const key = 'clans-compacted';
    const last = await this.prisma.appState.findUnique({ where: { key } });
    if (
      last &&
      Date.now() - new Date(last.value).getTime() < COMPACT_EVERY_MS
    ) {
      return;
    }
    const cutoff = new Date(Date.now() - HOURLY_KEEP_DAYS * 24 * HOUR);
    const removed = await this.prisma.$executeRaw`
      DELETE FROM "clan_snapshots" s
      USING (
        SELECT "clanId", date_trunc('day', "at") AS day, max("at") AS keep
        FROM "clan_snapshots" WHERE "at" < ${cutoff}
        GROUP BY 1, 2
      ) k
      WHERE s."clanId" = k."clanId" AND s."at" < ${cutoff}
        AND date_trunc('day', s."at") = k.day AND s."at" < k.keep`;
    const { count: dropped } = await this.prisma.clan.deleteMany({
      where: { goneAt: { lt: new Date(Date.now() - GONE_KEEP_MS) } },
    });
    const value = new Date().toISOString();
    await this.prisma.appState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.log.log(
      `история кланов сжата: убрано почасовых точек ${removed}, давно распущенных кланов ${dropped}`,
    );
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
    // не видели несколько проходов подряд — распущен (строку храним для сводки «распущенные»)
    const { count: gone } = await this.prisma.clan.updateMany({
      where: {
        region,
        goneAt: null,
        syncedAt: { lt: new Date(started - GONE_AFTER_MS) },
      },
      data: { goneAt: new Date() },
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
        (gone ? `, распущено ${gone}` : ''),
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

  /**
   * Страница одним запросом: снимки в историю (новые кланы и те, у кого изменились бойцы
   * или уровень) и INSERT … ON CONFLICT DO UPDATE самих кланов.
   * Обе части видят таблицу clans до этого запроса — снимок сравнивается с прошлым проходом.
   */
  private async save(region: Region, clans: IClanInfo[], offset: number) {
    const col = <T>(f: (c: IClanInfo, i: number) => T) => clans.map(f);
    const tagKey = col((c) => searchKey(c.tag ?? ''));
    const nameKey = col((c) => searchKey(c.name ?? ''));
    const leaderKey = col((c) => searchKey(c.leader ?? ''));
    // время — параметром, не now(): колонки без часового пояса, а у сервера БД может быть свой пояс
    const at = new Date();
    await this.prisma.$executeRaw`
      WITH u AS (
        SELECT * FROM unnest(
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
        ) AS t("id", "region", "name", "tag", "leader", "level", "levelPoints", "memberCount",
               "alliance", "registrationTime", "description", "rank",
               "tagKey", "nameKey", "leaderKey", "searchKey")
      ),
      -- PostgreSQL выполняет изменяющий CTE, даже если на него не ссылаются
      snap AS (
        INSERT INTO "clan_snapshots" ("clanId", "at", "region", "level", "memberCount")
        SELECT u."id", ${at}::timestamp, u."region", u."level", u."memberCount"
        FROM u LEFT JOIN "clans" c ON c."id" = u."id"
        WHERE c."id" IS NULL
           OR c."memberCount" <> u."memberCount" OR c."level" <> u."level"
           OR NOT EXISTS (SELECT 1 FROM "clan_snapshots" s WHERE s."clanId" = u."id")
        ON CONFLICT DO NOTHING
      )
      INSERT INTO "clans" ("id", "region", "name", "tag", "leader", "level", "levelPoints",
        "memberCount", "alliance", "registrationTime", "description", "rank",
        "tagKey", "nameKey", "leaderKey", "searchKey", "syncedAt", "goneAt")
      SELECT u.*, ${at}::timestamp, NULL FROM u
      ON CONFLICT ("id") DO UPDATE SET
        "goneAt" = NULL,
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
   * Страница списка кланов из БД (по уровню, потом по числу бойцов) в формате EXBO; null — регион ещё
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
            SELECT ${CLAN_COLUMNS} FROM "clans" WHERE "region" = ${region} AND "goneAt" IS NULL
            ORDER BY "level" DESC, "memberCount" DESC, "id" OFFSET ${offset} LIMIT ${limit}`,
          this.prisma.clan.count({ where: { region, goneAt: null } }),
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
      WHERE "region" = ${region} AND "goneAt" IS NULL AND (${Prisma.join(match, ' OR ')})
      ORDER BY LEAST(${Prisma.join(score, ', ')}), "level" DESC, "memberCount" DESC
      LIMIT ${limit}`;

    return { ...base, total: rows[0]?.total ?? 0, data: rows.map(toHit) };
  }
}
