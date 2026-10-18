/**
 * Рейтинг игрока как карточка FIFA, архетип «кто ты в Зоне» и процентили «лучше, чем X% игроков».
 * Чистые функции (без БД) — для тестов. Население — последние снимки всех игроков, что мы видели.
 */

const HOUR = 3_600_000;

export const METRICS = [
  'kd',
  'kills',
  'damage',
  'accuracy',
  'headshots',
  'streak',
  'mutants',
  'played',
  'survival',
] as const;
export type Metric = (typeof METRICS)[number];
export type Metrics = Record<Metric, number>;

export const ATTRIBUTES = [
  'pvp',
  'shooting',
  'accuracy',
  'survival',
  'mutants',
  'experience',
] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/** Вклад характеристик в общий рейтинг. */
const WEIGHTS: Record<Attribute, number> = {
  pvp: 0.25,
  shooting: 0.2,
  accuracy: 0.15,
  survival: 0.15,
  experience: 0.15,
  mutants: 0.1,
};

/** Характеристика = среднее процентилей этих показателей. */
const ATTRIBUTE_METRICS: Record<Attribute, Metric[]> = {
  pvp: ['kd', 'kills'],
  shooting: ['damage', 'streak'],
  accuracy: ['accuracy', 'headshots'],
  survival: ['survival'],
  mutants: ['mutants'],
  experience: ['played'],
};

export type Tier = 'bronze' | 'silver' | 'gold' | 'neon';
export type Archetype =
  | 'kamikaze'
  | 'tourist'
  | 'allrounder'
  | 'pvp'
  | 'stormer'
  | 'sniper'
  | 'survivor'
  | 'hunter'
  | 'veteran';

/** Кто ещё не играл — в население не берём, иначе процентили «лучше 90%» ни о чём. */
export const MIN_PLAYED_HOURS = 5;

/** Показатели из числовых стат профиля EXBO; null — новичок (меньше 5 часов в игре). */
export function metricsOf(stats: Record<string, number>): Metrics | null {
  const s = (id: string) => stats[id] ?? 0;
  const played = s('pla-tim') / HOUR;
  if (played < MIN_PLAYED_HOURS) return null;
  const kills = s('kil');
  const deaths = s('dea');
  const hits = s('sho-hit');
  const shots = s('sho-fir');
  return {
    kd: deaths ? kills / deaths : kills,
    kills,
    damage: s('dam-dea-all'),
    accuracy: shots ? (hits / shots) * 100 : 0,
    headshots: hits ? (s('sho-hea') / hits) * 100 : 0,
    streak: s('max-kil-ser'),
    mutants: s('mut-kil'),
    played,
    // часов жизни на одну смерть: чем больше, тем реже умирает
    survival: played / Math.max(1, deaths),
  };
}

/** Отсортированные значения каждого показателя по населению. */
export type Population = Record<Metric, number[]> & { size: number };

export function buildPopulation(list: Metrics[]): Population {
  const pop = { size: list.length } as Population;
  for (const m of METRICS) pop[m] = list.map((x) => x[m]).sort((a, b) => a - b);
  return pop;
}

/** Первый индекс со значением >= x (или > x при strict). */
function bound(sorted: number[], x: number, strict: boolean) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] <= x : sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Процент игроков с показателем хуже (ничьи — пополам), 0–100. */
export function percentile(sorted: number[], x: number) {
  if (!sorted.length) return 50;
  const below = bound(sorted, x, false);
  const equal = bound(sorted, x, true) - below;
  return Math.round(((below + equal / 2) / sorted.length) * 1000) / 10;
}

/** Процентиль → значение карточки: 0% — 35, 100% — 99 (как в FIFA: ниже 35 не бывает). */
const toCard = (p: number) => Math.round(35 + p * 0.64);

export interface Rating {
  /** процентили показателей, 0–100 */
  percentiles: Metrics;
  /** характеристики карточки, 35–99 */
  attributes: Record<Attribute, number>;
  overall: number;
  tier: Tier;
  archetype: Archetype;
}

export function rate(m: Metrics, pop: Population): Rating {
  const percentiles = {} as Metrics;
  for (const k of METRICS) percentiles[k] = percentile(pop[k], m[k]);

  const attributes = {} as Record<Attribute, number>;
  for (const a of ATTRIBUTES) {
    const list = ATTRIBUTE_METRICS[a];
    attributes[a] = toCard(
      list.reduce((s, k) => s + percentiles[k], 0) / list.length,
    );
  }
  const overall = Math.round(
    ATTRIBUTES.reduce((s, a) => s + attributes[a] * WEIGHTS[a], 0),
  );
  const tier: Tier =
    overall >= 85
      ? 'neon'
      : overall >= 75
        ? 'gold'
        : overall >= 65
          ? 'silver'
          : 'bronze';

  return {
    percentiles,
    attributes,
    overall,
    tier,
    archetype: archetypeOf(percentiles, attributes, overall),
  };
}

/** По какой характеристике — какой архетип, если особых случаев нет. */
const BY_ATTRIBUTE: Record<Attribute, Archetype> = {
  pvp: 'pvp',
  shooting: 'stormer',
  accuracy: 'sniper',
  survival: 'survivor',
  mutants: 'hunter',
  experience: 'veteran',
};

/**
 * Архетип: сначала особые случаи (камикадзе, турист, универсал), иначе — по самой сильной
 * характеристике относительно остальных.
 */
export function archetypeOf(
  p: Metrics,
  attrs: Record<Attribute, number>,
  overall: number,
): Archetype {
  // часто умирает, но и убивает немало
  if (p.survival < 20 && p.kills >= 50) return 'kamikaze';
  // много часов, мало толку в бою
  if (p.played >= 60 && p.kd < 30 && p.kills < 40) return 'tourist';
  const values = ATTRIBUTES.map((a) => attrs[a]);
  if (Math.max(...values) - Math.min(...values) <= 10 && overall >= 60)
    return 'allrounder';
  const best = [...ATTRIBUTES].sort((a, b) => attrs[b] - attrs[a])[0];
  return BY_ATTRIBUTE[best];
}

// ---------- итоги месяца ----------

export interface RecapSnap {
  day: Date;
  stats: Record<string, number>;
}

export interface Recap {
  /** месяц, «2026-10» */
  month: string;
  /** с какого и по какой день есть данные (первый месяц может быть неполным) */
  from: string;
  to: string;
  full: boolean;
  kills: number;
  deaths: number;
  hours: number;
  mutants: number;
  damage: number;
  /** дней, когда играл (прибавились часы) */
  activeDays: number;
  /** день с наибольшим числом убийств */
  bestDay: { day: string; kills: number; hours: number } | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Итоги месяца по ежедневным снимкам: от последнего снимка до начала месяца (или первого
 * в месяце) до последнего снимка месяца. null — данных нет или за месяц ничего не прибавилось.
 */
export function buildRecap(snaps: RecapSnap[], month: string): Recap | null {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const sorted = [...snaps].sort((a, b) => +a.day - +b.day);
  // снимок до месяца берём, только если он близко к началу — иначе в итоги попадёт чужой месяц
  const before = sorted
    .filter((s) => +s.day < +start && +start - +s.day <= 3 * 24 * HOUR)
    .at(-1);
  const inside = sorted.filter((s) => +s.day >= +start && +s.day < +end);
  const base = before ?? inside[0];
  const last = inside.at(-1);
  if (!base || !last || base === last) return null;

  const d = (id: string) =>
    Math.max(0, (last.stats[id] ?? 0) - (base.stats[id] ?? 0));
  const chain = before ? [before, ...inside] : inside;
  let activeDays = 0;
  let bestDay: Recap['bestDay'] = null;
  for (let i = 1; i < chain.length; i++) {
    const kills = (chain[i].stats.kil ?? 0) - (chain[i - 1].stats.kil ?? 0);
    const hours =
      ((chain[i].stats['pla-tim'] ?? 0) -
        (chain[i - 1].stats['pla-tim'] ?? 0)) /
      HOUR;
    if (hours > 0.05) activeDays++;
    if (kills > 0 && (!bestDay || kills > bestDay.kills))
      bestDay = {
        day: iso(chain[i].day),
        kills,
        hours: Math.round(hours * 10) / 10,
      };
  }

  const recap: Recap = {
    month,
    from: iso(before ? start : base.day),
    to: iso(last.day),
    full: Boolean(before),
    kills: d('kil'),
    deaths: d('dea'),
    hours: Math.round((d('pla-tim') / HOUR) * 10) / 10,
    mutants: d('mut-kil'),
    damage: Math.round(d('dam-dea-all')),
    activeDays,
    bestDay,
  };
  return recap.kills || recap.hours >= 0.1 ? recap : null;
}
