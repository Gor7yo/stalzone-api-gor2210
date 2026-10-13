// Метрики кланов по снимкам истории (clan_snapshots). Без зависимостей (тесты).
//
// В API EXBO у клана нет рейтинга, а очки уровня бесполезны (копятся до потолка уровня) —
// метрики строятся на числе бойцов, уровне и появлении/роспуске кланов.

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Больше бойцов в клане не бывает (ограничение игры). */
export const MAX_MEMBERS = 35;

export const SERIES_PERIODS = ['week', 'month', 'all'] as const;
export type SeriesPeriod = (typeof SERIES_PERIODS)[number];

/** Начало периода графика; «всё время» — с начала истории (first). */
export const periodStart = (
  period: SeriesPeriod,
  now: number,
  first: number,
) =>
  period === 'week'
    ? now - 7 * DAY
    : period === 'month'
      ? now - 30 * DAY
      : first;

/** Шаг точек графика: неделя — по часам, месяц и всё время — по дням. */
export const periodStep = (period: SeriesPeriod) =>
  period === 'week' ? HOUR : DAY;

/** Состояние клана в момент at (мс). Снимки пишутся только при изменениях. */
export interface Snap {
  at: number;
  level: number;
  memberCount: number;
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
 * Точки графика клана: неделя — все снимки (почасовые), месяц и всё время — по дням.
 * Снимки пишутся только при изменениях, поэтому начинаем с состояния на начало периода
 * и заканчиваем текущим — линия покрывает весь период.
 */
export function series(
  snaps: Snap[],
  current: Snap,
  now: number,
  period: SeriesPeriod,
): SeriesPoint[] {
  const start = periodStart(period, now, snaps[0]?.at ?? now);
  const inside = snaps.filter((s) => s.at > start && s.at <= now);
  const pts = (period === 'week' ? inside : dailyLast(inside)).map((s) =>
    toPoint(s),
  );
  const before = [...snaps].reverse().find((s) => s.at <= start);
  if (before) pts.unshift(toPoint(before, start));
  pts.push(toPoint(current, now));
  return pts;
}

// ---------- динамика региона во времени ----------

/**
 * Изменения в корзине времени по группировке: dm — на сколько изменилось число бойцов,
 * dc — сколько кланов появилось (+) или распущено (−). Считает SQL по снимкам.
 */
export interface RegionEvent {
  /** начало корзины, мс */
  t: number;
  alliance: string | null;
  dm: number;
  dc: number;
}

export interface RegionPoint {
  t: number;
  members: number;
  clans: number;
  /** бойцы по группировкам (кланы без группировки — только в общих числах) */
  alliances: Record<string, number>;
}

/**
 * Бойцы и кланы региона во времени: накопленная сумма изменений, точка на конец
 * каждой корзины от начала периода (или истории, если она короче) до сейчас.
 */
export function regionSeries(
  events: RegionEvent[],
  from: number,
  now: number,
  step: number,
): RegionPoint[] {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const start = Math.floor(Math.max(from, sorted[0].t) / step) * step;
  let members = 0;
  let clans = 0;
  const byAlliance: Record<string, number> = {};
  let i = 0;
  const apply = (until: number) => {
    for (; i < sorted.length && sorted[i].t < until; i++) {
      const e = sorted[i];
      members += e.dm;
      clans += e.dc;
      if (e.alliance)
        byAlliance[e.alliance] = (byAlliance[e.alliance] ?? 0) + e.dm;
    }
  };
  const out: RegionPoint[] = [];
  for (let b = start; b < now; b += step) {
    apply(b + step);
    out.push({
      t: Math.min(b + step, now),
      members,
      clans,
      alliances: { ...byAlliance },
    });
  }
  return out;
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
  day: { memberCount: number; at: number } | null;
  week: { memberCount: number; at: number } | null;
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
}

/** Возраст клана, дней: корзины для распределения. */
export const AGE_BUCKETS = [
  { label: 'до месяца', min: 0, max: 30 },
  { label: '1–6 мес', min: 30, max: 182 },
  { label: '6–12 мес', min: 182, max: 365 },
  { label: '1–2 года', min: 365, max: 730 },
  { label: '2+ года', min: 730, max: Infinity },
] as const;

const TOP = 10;
/** Запас на неровность часовых проходов: окно «полное», если история начинается не позже чем через час после его начала. */
const FULL_SLACK = HOUR;

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

/** Сводка по кланам региона: рост и отток бойцов, группировки, новые, распределения. */
export function summarizeRegion(
  clans: RegionClan[],
  now: number,
  /** первый снимок истории региона (мс); null — истории нет */
  historyFrom: number | null,
) {
  const delta = (c: RegionClan, b: RegionClan['day']) =>
    b ? c.memberCount - b.memberCount : 0;

  // группировки: только настоящие (кланы без группировки — в общих итогах)
  const byAlliance = new Map<
    string,
    { clans: number; members: number; membersWeek: number }
  >();
  for (const c of clans) {
    if (!c.alliance) continue;
    const a = byAlliance.get(c.alliance) ?? {
      clans: 0,
      members: 0,
      membersWeek: 0,
    };
    a.clans++;
    a.members += c.memberCount;
    a.membersWeek += delta(c, c.week);
    byAlliance.set(c.alliance, a);
  }
  const allianceMembers = [...byAlliance.values()].reduce(
    (s, a) => s + a.members,
    0,
  );
  const totalMembers = clans.reduce((s, c) => s + c.memberCount, 0);
  const alliances = [...byAlliance.entries()]
    .map(([alliance, a]) => ({
      alliance,
      ...a,
      avgMembers: a.clans ? a.members / a.clans : 0,
      /** доля среди бойцов кланов с группировкой */
      share: allianceMembers ? a.members / allianceMembers : 0,
    }))
    .sort((a, b) => b.members - a.members);

  const levels = new Map<number, { clans: number; members: number }>();
  for (const c of clans) {
    const l = levels.get(c.level) ?? { clans: 0, members: 0 };
    l.clans++;
    l.members += c.memberCount;
    levels.set(c.level, l);
  }

  // сколько кланов с 1, 2 … 35 бойцами
  const sizes = Array.from({ length: MAX_MEMBERS }, (_, i) => ({
    members: i + 1,
    clans: 0,
  }));
  for (const c of clans) {
    const n = Math.min(MAX_MEMBERS, Math.max(1, c.memberCount));
    sizes[n - 1].clans++;
  }

  const weekAgo = now - 7 * DAY;
  const fresh = clans
    .filter((c) => c.registrationTime != null && c.registrationTime >= weekAgo)
    .sort((a, b) => b.memberCount - a.memberCount);

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
      /** кланов с полным составом */
      full: sizes[MAX_MEMBERS - 1].clans,
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
    levels: [...levels.entries()]
      .map(([level, l]) => ({ level, ...l }))
      .sort((a, b) => a.level - b.level),
    sizes,
    ages: AGE_BUCKETS.map((b) => ({
      label: b.label,
      clans: ages.filter((a) => a >= b.min && a < b.max).length,
    })),
  };
}
