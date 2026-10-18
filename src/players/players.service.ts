import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  private async save(region: string, p: Required<Profile>, viewed: boolean) {
    const now = new Date();
    const stats = numericStats(p.stats);
    const day = mskDay(+now);
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
      this.prisma.characterSnapshot.upsert({
        where: { region_uuid_day: { region, uuid: p.uuid, day } },
        create: { region, uuid: p.uuid, day, at: now, stats },
        update: { at: now, stats },
      }),
    ]);
    this.progressCache.clear();
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
    } catch (e) {
      this.log.warn(`Обход игроков: ${(e as Error).message}`);
    } finally {
      this.running = false;
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
  }
}
