import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from 'generated/prisma/client';
import { TtlCache } from 'src/common/cache/ttl-cache';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalcraftApiClient } from 'src/stalzone/api/stalcraft-api.client';
import { BudgetExhaustedError } from 'src/stalzone/api/token-budget';
import {
  buildProgress,
  mskDay,
  numericStats,
  usernameKey,
  type ProfileStat,
  type Progress,
  type ProgressPeriod,
} from './progress';
import {
  buildPopulation,
  buildRecap,
  metricsOf,
  rate,
  type Metrics,
  type Population,
} from './rating';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Один и тот же профиль пишем в БД не чаще раза в 10 минут. */
const RECORD_EVERY_MS = 10 * MIN;
/** Обновляем фоном тех, кого смотрели за последние 30 дней, — раз в сутки (с запасом 20 ч). */
const TRACK_DAYS = 30;
const REFRESH_AFTER_MS = 20 * HOUR;
/** Обход — раз в 10 минут, за раз не больше 60 профилей (~8,6 тыс. в сутки, только остаток квоты). */
const REFRESH_EVERY_MS = 10 * MIN;
const REFRESH_BATCH = 60;
const FIRST_REFRESH_MS = 3 * MIN;
/** Снимки храним 120 дней; игроков, которых не открывали 60 дней, перестаём помнить. */
const SNAPSHOT_KEEP_DAYS = 120;
const FORGET_AFTER_DAYS = 60;
const PROGRESS_TTL_MS = 5 * MIN;
/** Население для процентилей пересчитываем раз в 30 минут; меньше 30 игроков — процентилям не верим. */
const POPULATION_TTL_MS = 30 * MIN;
const MIN_POPULATION = 30;
/** Статы, нужные для рейтинга (остальное из снимка не читаем). */
const POPULATION_STATS = [
  'kil',
  'dea',
  'pla-tim',
  'sho-fir',
  'sho-hit',
  'sho-hea',
  'dam-dea-all',
  'max-kil-ser',
  'mut-kil',
];
/**
 * Пока игроков меньше 3000, подкачиваем профили лидеров кланов (их ники есть в нашей копии
 * списка кланов): по 30 за обход, только остаток квоты. Иначе процентили были бы по горстке игроков.
 */
const SEED_TARGET = 3000;
const SEED_BATCH = 30;
const SEED_OFFSET_KEY = 'players-seed:offset';

/** Ник как в EXBO: буквы, цифры, _ . - (как CharacterQueryDto). */
const NICK_RE = /^[\p{L}\p{N}_.-]{1,32}$/u;
/** Игроков в inline-результатах из нашей базы; точный ник из EXBO помним 10 минут. */
const INLINE_PLAYERS = 3;
const EXACT_TTL_MS = 10 * MIN;

/** jsonb-объект → только числовые значения. */
const numericObject = (o: Record<string, unknown> | null) =>
  Object.fromEntries(
    Object.entries(o ?? {})
      .map(([k, v]) => [k, Number(v)] as const)
      .filter(([, v]) => Number.isFinite(v)),
  );

/** Игрок в inline-поиске бота: рейтинг (если посчитан) и базовые цифры. */
export type InlinePlayer = Awaited<ReturnType<PlayersService['rating']>>;

/** Профиль EXBO — нужные нам поля. */
interface Profile {
  uuid?: string;
  username?: string;
  stats?: ProfileStat[];
}

/**
 * Прогресс игроков: снимок статистики раз в день на каждого, чей профиль открывали.
 * EXBO истории не даёт — считаем от первого открытия профиля на сайте.
 */
@Injectable()
export class PlayersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(PlayersService.name);
  private readonly recorded = new TtlCache<true>(5000);
  private readonly progressCache = new TtlCache<
    Progress & { username: string }
  >(1000);
  private readonly populationCache = new TtlCache<Population>(2);
  private readonly exactCache = new TtlCache<InlinePlayer | null>(2000);
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private running = false;
  private cleanedDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalcraft: StalcraftApiClient,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('PLAYER_REFRESH_ENABLED') !== 'false' &&
      process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.log.log('Обновление прогресса игроков выключено');
      return;
    }
    const tick = () => {
      void this.refresh().finally(() => {
        this.timer = setTimeout(tick, REFRESH_EVERY_MS);
      });
    };
    this.timer = setTimeout(tick, FIRST_REFRESH_MS);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  /**
   * Профиль открыли на сайте: запоминаем игрока и пишем снимок дня.
   * Ошибки БД не мешают ответу пользователю.
   */
  async viewed(region: string, profile: unknown) {
    const p = profile as Profile | null;
    if (!p?.uuid || !p.username) return;
    const key = `${region}:${p.uuid}`;
    // склейка: в течение 10 минут повторные открытия ничего не пишут
    await this.recorded
      .getOrLoad(key, RECORD_EVERY_MS, async () => {
        await this.save(region, p as Required<Profile>, true);
        return true as const;
      })
      .catch((e: Error) => this.log.warn(`Снимок ${key}: ${e.message}`));
  }

  /** Снимок дня без «слежения» — для лидеров кланов, которыми наполняем население. */
  private snapshot(region: string, p: Required<Profile>) {
    const now = new Date();
    const stats = numericStats(p.stats);
    const day = mskDay(+now);
    return this.prisma.characterSnapshot.upsert({
      where: { region_uuid_day: { region, uuid: p.uuid, day } },
      create: { region, uuid: p.uuid, day, at: now, stats },
      update: { at: now, stats },
    });
  }

  private async save(region: string, p: Required<Profile>, viewed: boolean) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.trackedCharacter.upsert({
        where: { region_uuid: { region, uuid: p.uuid } },
        create: {
          region,
          uuid: p.uuid,
          username: p.username,
          usernameKey: usernameKey(p.username),
          lastViewedAt: now,
          refreshedAt: now,
        },
        update: {
          username: p.username,
          usernameKey: usernameKey(p.username),
          refreshedAt: now,
          ...(viewed && { lastViewedAt: now }),
        },
      }),
      this.snapshot(region, p),
    ]);
    this.progressCache.clear();
  }

  // ---------- рейтинг: население, процентили, карточка, архетип ----------

  /**
   * Население для процентилей: последний снимок каждого игрока за 120 дней (все регионы вместе —
   * так больше выборка). Новички меньше 5 часов в игре не считаются. Кеш 30 минут.
   */
  population() {
    return this.populationCache.getOrLoad(
      'all',
      POPULATION_TTL_MS,
      async () => {
        const since = new Date(Date.now() - SNAPSHOT_KEEP_DAYS * DAY);
        // из всего снимка — только нужные статы, чтобы не тащить в память сотни полей
        const keys = Prisma.join(
          POPULATION_STATS.map((k) => Prisma.sql`${k}::text, "stats"->${k}`),
        );
        const rows = await this.prisma.$queryRaw<
          { s: Record<string, number> }[]
        >(
          Prisma.sql`SELECT DISTINCT ON ("region", "uuid") jsonb_build_object(${keys}) AS s
          FROM "character_snapshots" WHERE "day" >= ${since}
          ORDER BY "region", "uuid", "day" DESC`,
        );
        const list = rows
          .map((r) => metricsOf(numericObject(r.s)))
          .filter((m): m is Metrics => m !== null);
        return buildPopulation(list);
      },
    );
  }

  /**
   * Карточка игрока: рейтинг, характеристики, архетип и процентили — против всех, кого мы видели.
   * Профиль берём из того же кеша, что открытие страницы (квоту второй раз не тратит).
   */
  async rating(region: string, username: string) {
    const profile = await this.stalcraft.get<Profile>(
      [region, 'character', 'by-name', username, 'profile'],
      {},
      MIN,
    );
    void this.viewed(region, profile);
    return this.ratingOf(
      profile.username ?? username,
      numericStats(profile.stats),
    );
  }

  /** Рейтинг по числовым статам (из профиля или из снимка). */
  private async ratingOf(username: string, stats: Record<string, number>) {
    const metrics = metricsOf(stats);
    const pop = await this.population();
    const kills = stats.kil ?? 0;
    const deaths = stats.dea ?? 0;
    // базовые цифры — для любого статуса (inline-карточка новичка тоже не пустая)
    const base = {
      username,
      population: pop.size,
      basic: {
        kd: deaths ? kills / deaths : kills,
        kills,
        hours: (stats['pla-tim'] ?? 0) / HOUR,
      },
    };
    if (!metrics) return { ...base, status: 'newbie' as const };
    if (pop.size < MIN_POPULATION)
      return { ...base, status: 'collecting' as const };
    return {
      ...base,
      status: 'ready' as const,
      metrics,
      ...rate(metrics, pop),
    };
  }

  /**
   * Игроки для inline-поиска в боте («@бот ник»). Сначала — по нашей базе (кого уже открывали,
   * ник с начала, без квоты EXBO). В EXBO идём только за точным ником от 4 символов, если в базе
   * его нет; «не найден» помним 10 минут — inline-запросы летят на каждую букву.
   */
  async inlinePlayers(region: string, text: string) {
    const key = usernameKey(text);
    if (!NICK_RE.test(text) || key.length < 3) return [];
    const tracked = await this.prisma.trackedCharacter.findMany({
      where: { region, usernameKey: { startsWith: key } },
      orderBy: { lastViewedAt: 'desc' },
      take: INLINE_PLAYERS,
    });
    const found = await Promise.all(
      tracked.map(async (t) => {
        const last = await this.prisma.characterSnapshot.findFirst({
          where: { region, uuid: t.uuid },
          orderBy: { day: 'desc' },
          select: { stats: true },
        });
        return last
          ? this.ratingOf(t.username, last.stats as Record<string, number>)
          : null;
      }),
    );
    const list = found.filter((x) => x !== null);
    if (key.length >= 4 && !tracked.some((t) => t.usernameKey === key)) {
      // и «не найден», и найденный — 10 минут: повторный набор того же ника EXBO не дёргает
      const exact = await this.exactCache
        .getOrLoad(`${region}:${key}`, EXACT_TTL_MS, () =>
          this.rating(region, text).catch(() => null),
        )
        .catch(() => null);
      if (exact) list.unshift(exact);
    }
    return list;
  }

  // ---------- итоги месяца ----------

  /** Итоги месяца по нику (страница итогов и её картинка). */
  async recap(region: string, username: string, month: string) {
    const tracked = await this.prisma.trackedCharacter.findFirst({
      where: { region, usernameKey: usernameKey(username) },
      orderBy: { lastViewedAt: 'desc' },
    });
    if (!tracked) throw new NotFoundException('Игрока ещё не открывали');
    const recap = await this.recapByUuid(region, tracked.uuid, month);
    if (!recap) throw new NotFoundException('За этот месяц данных нет');
    const rating = await this.rating(region, tracked.username).catch(
      () => null,
    );
    return {
      username: tracked.username,
      region,
      ...recap,
      archetype: rating?.status === 'ready' ? rating.archetype : null,
      overall: rating?.status === 'ready' ? rating.overall : null,
    };
  }

  /** Итоги месяца по uuid; null — за месяц нет данных или ничего не прибавилось. */
  async recapByUuid(region: string, uuid: string, month: string) {
    const start = new Date(`${month}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const rows = await this.prisma.characterSnapshot.findMany({
      where: {
        region,
        uuid,
        day: { gte: new Date(+start - 4 * DAY), lt: end },
      },
      select: { day: true, stats: true },
      orderBy: { day: 'asc' },
    });
    return buildRecap(
      rows.map((r) => ({
        day: r.day,
        stats: r.stats as Record<string, number>,
      })),
      month,
    );
  }

  /** Прирост статистики игрока за неделю или месяц. */
  progress(region: string, username: string, period: ProgressPeriod) {
    const key = `${region}:${usernameKey(username)}:${period}`;
    return this.progressCache.getOrLoad(key, PROGRESS_TTL_MS, async () => {
      const tracked = await this.prisma.trackedCharacter.findFirst({
        where: { region, usernameKey: usernameKey(username) },
        orderBy: { lastViewedAt: 'desc' },
      });
      if (!tracked) throw new NotFoundException('Игрока ещё не открывали');
      const rows = await this.prisma.characterSnapshot.findMany({
        where: {
          region,
          uuid: tracked.uuid,
          day: { gte: new Date(Date.now() - SNAPSHOT_KEEP_DAYS * DAY) },
        },
        select: { day: true, stats: true },
        orderBy: { day: 'asc' },
      });
      return {
        username: tracked.username,
        ...buildProgress(
          rows.map((r) => ({
            day: r.day,
            stats: r.stats as Record<string, number>,
          })),
          period,
          Date.now(),
        ),
      };
    });
  }

  /** Фоновый обход: свежий снимок тех, кого смотрели за 30 дней, раз в сутки. */
  private async refresh() {
    if (this.running) return;
    this.running = true;
    try {
      await this.cleanup();
      const now = Date.now();
      const due = await this.prisma.trackedCharacter.findMany({
        where: {
          lastViewedAt: { gt: new Date(now - TRACK_DAYS * DAY) },
          refreshedAt: { lt: new Date(now - REFRESH_AFTER_MS) },
        },
        orderBy: { refreshedAt: 'asc' },
        take: REFRESH_BATCH,
      });
      let done = 0;
      for (const t of due) {
        try {
          const profile = await this.stalcraft.get<Profile>(
            [t.region, 'character', 'by-name', t.username, 'profile'],
            {},
            // тот же ключ кеша, что у открытия профиля, — держим не дольше его минуты
            MIN,
            'background',
          );
          if (profile?.uuid === t.uuid && profile.username) {
            await this.save(t.region, profile as Required<Profile>, false);
          } else {
            // ник занят другим игроком — старого больше не найти, просто отмечаем
            await this.touch(t.region, t.uuid);
          }
          done++;
        } catch (e) {
          if (e instanceof BudgetExhaustedError) break;
          // сменил ник или удалён (404) — повторим через сутки, через 30 дней забудем
          if (e instanceof NotFoundException)
            await this.touch(t.region, t.uuid);
          else
            this.log.warn(`Обновление ${t.username}: ${(e as Error).message}`);
        }
      }
      if (done)
        this.log.log(`Прогресс игроков: обновлено ${done} из ${due.length}`);
      await this.seed();
    } catch (e) {
      this.log.warn(`Обход игроков: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Наполнение населения профилями лидеров кланов, пока игроков меньше SEED_TARGET. */
  private async seed() {
    const pop = await this.population();
    if (pop.size >= SEED_TARGET) return;
    const state = await this.prisma.appState.findUnique({
      where: { key: SEED_OFFSET_KEY },
    });
    const offset = Number(state?.value) || 0;
    const clans = await this.prisma.clan.findMany({
      where: { goneAt: null },
      select: { region: true, leader: true },
      orderBy: { id: 'asc' },
      skip: offset,
      take: SEED_BATCH,
    });
    // прошли все кланы — дальше не ходим (новых лидеров мало, население растёт и от просмотров)
    if (!clans.length) return;
    let done = 0;
    // курсор двигаем только по обработанным: кончилась квота — оставшихся возьмём в следующий раз
    let next = offset;
    for (const c of clans) {
      try {
        const profile = await this.stalcraft.get<Profile>(
          [c.region, 'character', 'by-name', c.leader, 'profile'],
          {},
          MIN,
          'background',
        );
        if (profile?.uuid && profile.username) {
          await this.snapshot(c.region, profile as Required<Profile>);
          done++;
        }
      } catch (e) {
        if (e instanceof BudgetExhaustedError) break;
        // лидер сменил ник или удалён — пропускаем
      }
      next++;
    }
    await this.prisma.appState.upsert({
      where: { key: SEED_OFFSET_KEY },
      create: { key: SEED_OFFSET_KEY, value: String(next) },
      update: { value: String(next) },
    });
    if (done) this.log.log(`Население рейтинга: +${done} лидеров кланов`);
  }

  /**
   * Персонажи аккаунтов с привязанным Telegram — всегда «под наблюдением»:
   * для них итоги месяца в боте, даже если профиль на сайте не открывали.
   */
  private async trackLinked() {
    const users = await this.prisma.user.findMany({
      where: { chatId: { not: null }, characters: { not: Prisma.DbNull } },
      select: { characters: true },
    });
    const now = new Date();
    for (const u of users) {
      const list = Array.isArray(u.characters) ? u.characters : [];
      for (const raw of list as {
        region?: string;
        name?: string;
        id?: string | null;
      }[]) {
        if (!raw?.region || !raw.name || !raw.id) continue;
        await this.prisma.trackedCharacter.upsert({
          where: { region_uuid: { region: raw.region, uuid: raw.id } },
          // refreshedAt в прошлом — обход возьмёт его первым
          create: {
            region: raw.region,
            uuid: raw.id,
            username: raw.name,
            usernameKey: usernameKey(raw.name),
            lastViewedAt: now,
            refreshedAt: new Date(0),
          },
          update: { lastViewedAt: now },
        });
      }
    }
  }

  private touch(region: string, uuid: string) {
    return this.prisma.trackedCharacter.update({
      where: { region_uuid: { region, uuid } },
      data: { refreshedAt: new Date() },
    });
  }

  /** Раз в сутки: старые снимки и давно не открытые игроки. */
  private async cleanup() {
    const today = mskDay(Date.now()).toISOString();
    if (this.cleanedDay === today) return;
    this.cleanedDay = today;
    const now = Date.now();
    await this.prisma.characterSnapshot.deleteMany({
      where: { day: { lt: new Date(now - SNAPSHOT_KEEP_DAYS * DAY) } },
    });
    await this.prisma.trackedCharacter.deleteMany({
      where: { lastViewedAt: { lt: new Date(now - FORGET_AFTER_DAYS * DAY) } },
    });
    await this.trackLinked();
  }
}
