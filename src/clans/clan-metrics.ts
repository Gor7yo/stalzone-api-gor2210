// Метрики кланов по снимкам истории (clan_snapshots). Без зависимостей (тесты).
//
// В API EXBO у клана нет рейтинга, а очки уровня бесполезны (копятся до потолка уровня) —
// метрики строятся на числе бойцов и уровне.

const DAY = 86_400_000;

/** Окна изменений: сутки, неделя, месяц. */
export const WINDOWS = [
  { key: 'day', days: 1 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
] as const;
export type WindowKey = (typeof WINDOWS)[number]['key'];

export const SERIES_PERIODS = ['week', 'month', 'all'] as const;
export type SeriesPeriod = (typeof SERIES_PERIODS)[number];

/** Состояние клана в момент at (мс). Снимки пишутся только при изменениях. */
export interface Snap {
  at: number;
  level: number;
  memberCount: number;
}

export interface WindowDelta {
  key: WindowKey;
  days: number;
  /** с какого снимка считаем (ISO); null — истории нет */
  since: string | null;
  /** история покрывает окно целиком (иначе — изменение с начала истории) */
  full: boolean;
  /** на сколько изменилось число бойцов; null — истории нет */
  members: number | null;
}

/** Снимок, от которого считаем изменение за окно: последний не позже t, иначе — самый ранний. */
export function baseAt(snaps: Snap[], t: number): Snap | undefined {
  let base: Snap | undefined;
  for (const s of snaps) {
    if (s.at <= t) base = s;
    else break;
  }
  return base ?? snaps[0];
}

/** Запас на неровность часовых проходов: окно «полное», если история начинается не позже чем через час после его начала. */
const FULL_SLACK = 3_600_000;

export function windowDelta(
  snaps: Snap[],
  current: Snap,
  now: number,
  w: { key: WindowKey; days: number },
): WindowDelta {
  const start = now - w.days * DAY;
  const base = baseAt(snaps, start);
  if (!base) return { ...w, since: null, full: false, members: null };
  return {
    ...w,
    // базовый снимок может быть старше окна (между снимками ничего не менялось) — считаем от начала окна
    since: new Date(Math.max(start, base.at)).toISOString(),
    full: base.at <= start + FULL_SLACK,
    members: current.memberCount - base.memberCount,
  };
}

/** Пик численности за историю и когда он был (при равенстве — самый поздний). */
export function peakMembers(snaps: Snap[], current: Snap) {
  let peak = current;
  for (const s of snaps) if (s.memberCount > peak.memberCount) peak = s;
  return { memberCount: peak.memberCount, at: new Date(peak.at).toISOString() };
}

/**
 * Когда клан взял текущий уровень (первый снимок с ним после снимка с уровнем ниже).
 * null — клан уже был на этом уровне с начала истории.
 */
export function levelSince(snaps: Snap[], current: Snap): string | null {
  for (let i = snaps.length - 1; i > 0; i--) {
    if (
      snaps[i].level === current.level &&
      snaps[i - 1].level < current.level
    ) {
      return new Date(snaps[i].at).toISOString();
    }
    if (snaps[i].level !== current.level) break;
  }
  return null;
}

/** Последний снимок каждого дня (UTC). */
export function dailyLast(snaps: Snap[]): Snap[] {
  const out: Snap[] = [];
  for (const s of snaps) {
    const day = Math.floor(s.at / DAY);
    if (out.length && Math.floor(out[out.length - 1].at / DAY) === day) {
      out[out.length - 1] = s;
    } else out.push(s);
  }
  return out;
}

export interface SeriesPoint {
  t: number;
  memberCount: number;
  level: number;
}

const toPoint = (s: Snap, t = s.at): SeriesPoint => ({
  t,
  memberCount: s.memberCount,
  level: s.level,
});

/**
 * Точки графика за период: неделя — все снимки (почасовые), месяц и всё время — по дням.
 * Снимки пишутся только при изменениях, поэтому начинаем с состояния на начало периода
 * и заканчиваем текущим — линия покрывает весь период.
 */
export function series(
  snaps: Snap[],
  current: Snap,
  now: number,
  period: SeriesPeriod,
): SeriesPoint[] {
  const start =
    period === 'week'
      ? now - 7 * DAY
      : period === 'month'
        ? now - 30 * DAY
        : (snaps[0]?.at ?? now);
  const inside = snaps.filter((s) => s.at > start && s.at <= now);
  const pts = (period === 'week' ? inside : dailyLast(inside)).map((s) =>
    toPoint(s),
  );
  const before = [...snaps].reverse().find((s) => s.at <= start);
  if (before) pts.unshift(toPoint(before, start));
  pts.push(toPoint(current, now));
  return pts;
}

// ---------- сводка по региону ----------

/** Клан региона: состояние сейчас и в начале суток / недели (последний снимок не позже, иначе самый ранний). */
export interface RegionClan {
  id: string;
  tag: string;
  name: string;
  alliance: string | null;
  level: number;
  memberCount: number;
  registrationTime: number | null;
  day: { memberCount: number; level: number; at: number } | null;
  week: { memberCount: number; level: number; at: number } | null;
}

export interface ClanRow {
  id: string;
  tag: string;
  name: string;
  alliance: string | null;
  level: number;
  memberCount: number;
  /** изменение бойцов за окно списка */
  delta?: number;
  /** дней с основания (для новых кланов) */
  ageDays?: number;
  /** уровень неделю назад (для повысивших уровень) */
  fromLevel?: number;
}

/** Размер клана: корзины для распределения. */
export const SIZE_BUCKETS = [
  { label: '1', min: 1, max: 1 },
  { label: '2–5', min: 2, max: 5 },
  { label: '6–10', min: 6, max: 10 },
  { label: '11–20', min: 11, max: 20 },
  { label: '21–50', min: 21, max: 50 },
  { label: '51+', min: 51, max: Infinity },
] as const;

/** Возраст клана, дней: корзины для распределения. */
export const AGE_BUCKETS = [
  { label: 'до месяца', min: 0, max: 30 },
  { label: '1–6 мес', min: 30, max: 182 },
  { label: '6–12 мес', min: 182, max: 365 },
  { label: '1–2 года', min: 365, max: 730 },
  { label: '2+ года', min: 730, max: Infinity },
] as const;

const TOP = 10;

const row = (c: RegionClan, extra: Partial<ClanRow> = {}): ClanRow => ({
  id: c.id,
  tag: c.tag,
  name: c.name,
  alliance: c.alliance,
  level: c.level,
  memberCount: c.memberCount,
  ...extra,
});

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** С какого момента считаем окно: его начало или начало истории региона, если она короче окна. */
const windowInfo = (historyFrom: number | null, start: number) =>
  historyFrom == null
    ? { since: null, full: false }
    : {
        since: new Date(Math.max(start, historyFrom)).toISOString(),
        full: historyFrom <= start + FULL_SLACK,
      };

/** Лучшие по score: сначала больший score, при равенстве — крупнее клан и выше уровень. */
const topBy = (clans: RegionClan[], score: (c: RegionClan) => number) =>
  clans
    .map((c) => ({ c, d: score(c) }))
    .filter((x) => x.d > 0)
    .sort(
      (a, b) =>
        b.d - a.d || b.c.memberCount - a.c.memberCount || b.c.level - a.c.level,
    )
    .slice(0, TOP);

/** Сводка по кланам региона: рост и отток бойцов, группировки, новые, уровни, распределения. */
export function summarizeRegion(
  clans: RegionClan[],
  now: number,
  /** первый снимок истории региона (мс); null — истории нет */
  historyFrom: number | null,
) {
  const delta = (c: RegionClan, b: RegionClan['day']) =>
    b ? c.memberCount - b.memberCount : 0;

  // группировки: кланы, бойцы, доля бойцов, изменение за неделю
  const byAlliance = new Map<
    string,
    { clans: number; members: number; membersWeek: number }
  >();
  for (const c of clans) {
    const key = c.alliance ?? 'none';
    const a = byAlliance.get(key) ?? { clans: 0, members: 0, membersWeek: 0 };
    a.clans++;
    a.members += c.memberCount;
    a.membersWeek += delta(c, c.week);
    byAlliance.set(key, a);
  }
  const totalMembers = clans.reduce((s, c) => s + c.memberCount, 0);
  const alliances = [...byAlliance.entries()]
    .map(([alliance, a]) => ({
      alliance,
      ...a,
      avgMembers: a.clans ? a.members / a.clans : 0,
      share: totalMembers ? a.members / totalMembers : 0,
    }))
    .sort((a, b) => b.members - a.members);

  const levels = new Map<number, { clans: number; members: number }>();
  for (const c of clans) {
    const l = levels.get(c.level) ?? { clans: 0, members: 0 };
    l.clans++;
    l.members += c.memberCount;
    levels.set(c.level, l);
  }

  const weekAgo = now - 7 * DAY;
  const fresh = clans
    .filter((c) => c.registrationTime != null && c.registrationTime >= weekAgo)
    .sort((a, b) => b.memberCount - a.memberCount);

  const levelUps = clans
    .filter((c) => c.week && c.week.level < c.level)
    .sort((a, b) => b.level - a.level || b.memberCount - a.memberCount);

  const ages = clans
    .filter((c) => c.registrationTime != null)
    .map((c) => (now - c.registrationTime!) / DAY);

  const weekDeltas = clans.map((c) => delta(c, c.week));

  return {
    windows: {
      day: windowInfo(historyFrom, now - DAY),
      week: windowInfo(historyFrom, weekAgo),
    },
    totals: {
      clans: clans.length,
      members: totalMembers,
      avgMembers: clans.length ? totalMembers / clans.length : 0,
      medianMembers: median(clans.map((c) => c.memberCount)),
      medianAgeDays: Math.round(median(ages)),
      /** чистое изменение бойцов в кланах за сутки и неделю */
      membersDay: clans.reduce((s, c) => s + delta(c, c.day), 0),
      membersWeek: weekDeltas.reduce((s, d) => s + d, 0),
      /** сумма прибавок и убавок по кланам за неделю */
      joinedWeek: weekDeltas.reduce((s, d) => s + Math.max(0, d), 0),
      leftWeek: weekDeltas.reduce((s, d) => s + Math.max(0, -d), 0),
      /** у скольких кланов за неделю менялся состав */
      changedWeek: weekDeltas.filter((d) => d !== 0).length,
    },
    growth: {
      day: topBy(clans, (c) => delta(c, c.day)).map((x) =>
        row(x.c, { delta: x.d }),
      ),
      week: topBy(clans, (c) => delta(c, c.week)).map((x) =>
        row(x.c, { delta: x.d }),
      ),
    },
    /** больше всех потеряли бойцов за неделю (delta < 0) */
    decline: topBy(clans, (c) => -delta(c, c.week)).map((x) =>
      row(x.c, { delta: -x.d }),
    ),
    alliances,
    newClans: {
      count: fresh.length,
      list: fresh
        .slice(0, TOP)
        .map((c) =>
          row(c, { ageDays: Math.floor((now - c.registrationTime!) / DAY) }),
        ),
    },
    levelUps: {
      count: levelUps.length,
      list: levelUps
        .slice(0, TOP)
        .map((c) => row(c, { fromLevel: c.week!.level })),
    },
    levels: [...levels.entries()]
      .map(([level, l]) => ({ level, ...l }))
      .sort((a, b) => a.level - b.level),
    sizes: SIZE_BUCKETS.map((b) => ({
      label: b.label,
      clans: clans.filter(
        (c) => c.memberCount >= b.min && c.memberCount <= b.max,
      ).length,
    })),
    ages: AGE_BUCKETS.map((b) => ({
      label: b.label,
      clans: ages.filter((a) => a >= b.min && a < b.max).length,
    })),
  };
}
