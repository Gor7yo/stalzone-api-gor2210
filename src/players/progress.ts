/** Прогресс игрока по ежедневным снимкам статистики: чистые функции (без БД) — для тестов. */

const DAY = 24 * 3_600_000;
/** Москва — UTC+3 круглый год. */
const MSK_OFFSET = 3 * 3_600_000;

export const PROGRESS_PERIODS = ['week', 'month'] as const;
export type ProgressPeriod = (typeof PROGRESS_PERIODS)[number];
const PERIOD_DAYS: Record<ProgressPeriod, number> = { week: 7, month: 30 };

/** Статы, по которым отдаём разбивку по дням (столбики активности). */
const DAILY_STATS = ['kil', 'dea', 'pla-tim'] as const;

export interface ProfileStat {
  id: string;
  type: string;
  value: unknown;
}

export interface Snapshot {
  /** день по Москве, полночь UTC этой даты */
  day: Date;
  stats: Record<string, number>;
}

export interface Progress {
  /** первый снимок — с этого дня следим */
  since: string | null;
  /** снимок, от которого считаем; null — снимок пока один */
  from: string | null;
  to: string | null;
  period: ProgressPeriod;
  /** снимок-начало покрывает весь период (иначе — «за N дней, пока копим») */
  full: boolean;
  /** сколько дней между началом и концом */
  days: number;
  /** прирост статы за период, только ненулевые */
  deltas: Record<string, number>;
  /** прирост за каждый день периода (дни без снимка — без точки) */
  daily: { day: string; kil: number; dea: number; 'pla-tim': number }[];
}

/** Числовые статы профиля EXBO: { id: число }. Даты и всё нечисловое пропускаем. */
export function numericStats(stats: ProfileStat[] | undefined) {
  const out: Record<string, number> = {};
  for (const s of stats ?? []) {
    if (!s?.id || s.type === 'DATE') continue;
    const v = typeof s.value === 'number' ? s.value : Number(s.value);
    if (Number.isFinite(v)) out[s.id] = v;
  }
  return out;
}

/** День по Москве как дата (полночь UTC) — ключ снимка. */
export function mskDay(t: number) {
  return new Date(Math.floor((t + MSK_OFFSET) / DAY) * DAY);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Ник для поиска: регистр и ё не важны. */
export const usernameKey = (name: string) =>
  name.trim().toLowerCase().replace(/ё/g, 'е');

/**
 * Прирост за период: от последнего снимка не позже начала периода (или самого раннего,
 * если следим меньше периода) до последнего снимка.
 */
export function buildProgress(
  snaps: Snapshot[],
  period: ProgressPeriod,
  now: number,
): Progress {
  const sorted = [...snaps].sort((a, b) => +a.day - +b.day);
  const empty: Progress = {
    since: sorted[0] ? iso(sorted[0].day) : null,
    from: null,
    to: sorted.at(-1) ? iso(sorted.at(-1)!.day) : null,
    period,
    full: false,
    days: 0,
    deltas: {},
    daily: [],
  };
  if (sorted.length < 2) return empty;

  const last = sorted.at(-1)!;
  const start = +mskDay(now) - PERIOD_DAYS[period] * DAY;
  const before = sorted.filter((s) => +s.day <= start && s !== last);
  const base = before.at(-1) ?? sorted[0];

  const deltas: Record<string, number> = {};
  for (const [id, v] of Object.entries(last.stats)) {
    const d = v - (base.stats[id] ?? 0);
    // статы только растут; уменьшение — сброс или ошибка EXBO, такое не показываем
    if (d > 0) deltas[id] = Math.round(d * 100) / 100;
  }

  const inside = sorted.filter((s) => +s.day >= +base.day);
  const daily = inside.slice(1).map((s, i) => {
    const prev = inside[i];
    const point = { day: iso(s.day), kil: 0, dea: 0, 'pla-tim': 0 };
    for (const id of DAILY_STATS)
      point[id] = Math.max(0, (s.stats[id] ?? 0) - (prev.stats[id] ?? 0));
    return point;
  });

  return {
    ...empty,
    from: iso(base.day),
    full: +base.day <= start,
    days: Math.round((+last.day - +base.day) / DAY),
    deltas,
    daily,
  };
}
