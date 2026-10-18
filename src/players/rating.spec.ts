import {
  archetypeOf,
  buildPopulation,
  buildRecap,
  metricsOf,
  percentile,
  rate,
  type Metrics,
} from './rating';

const H = 3_600_000;

const stats = (o: Partial<Record<string, number>> = {}) => ({
  kil: 1000,
  dea: 1000,
  'pla-tim': 100 * H,
  'sho-fir': 10_000,
  'sho-hit': 5000,
  'sho-hea': 1000,
  'dam-dea-all': 1_000_000,
  'max-kil-ser': 10,
  'mut-kil': 1000,
  ...o,
});

describe('rating', () => {
  it('новичок меньше 5 часов — без показателей', () => {
    expect(metricsOf(stats({ 'pla-tim': 2 * H }))).toBeNull();
  });

  it('показатели: K/D, точность, хедшоты, выживаемость', () => {
    const m = metricsOf(stats({ kil: 2000 }))!;
    expect(m.kd).toBe(2);
    expect(m.accuracy).toBe(50);
    expect(m.headshots).toBe(20);
    expect(m.survival).toBe(0.1);
  });

  it('процентиль: ничьи пополам, крайние — 0 и 100', () => {
    const sorted = [1, 2, 2, 3];
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 2)).toBe(50);
    expect(percentile(sorted, 10)).toBe(100);
  });

  it('лучший в населении — 99 и неоновая карточка, худший — 35', () => {
    const list = Array.from({ length: 100 }, (_, i) =>
      metricsOf(
        stats({
          kil: 100 + i * 100,
          dea: 2000 - i * 10,
          'sho-hit': 3000 + i * 50,
          'sho-hea': 500 + i * 20,
          'dam-dea-all': 1e5 * (i + 1),
          'max-kil-ser': i,
          'mut-kil': i * 50,
          'pla-tim': (10 + i) * H,
        }),
      )!,
    );
    const pop = buildPopulation(list);
    const best = rate(list[99], pop);
    const worst = rate(list[0], pop);
    expect(best.overall).toBeGreaterThanOrEqual(95);
    expect(best.tier).toBe('neon');
    expect(worst.overall).toBeLessThanOrEqual(37);
    expect(worst.tier).toBe('bronze');
  });

  const p = (o: Partial<Metrics>): Metrics => ({
    kd: 50,
    kills: 50,
    damage: 50,
    accuracy: 50,
    headshots: 50,
    streak: 50,
    mutants: 50,
    played: 50,
    survival: 50,
    ...o,
  });
  const attrs = (o: Partial<Record<string, number>> = {}) => ({
    pvp: 60,
    shooting: 60,
    accuracy: 60,
    survival: 60,
    mutants: 60,
    experience: 60,
    ...o,
  });

  it('архетипы: камикадзе, турист, универсал, по сильной стороне', () => {
    expect(archetypeOf(p({ survival: 10, kills: 70 }), attrs(), 60)).toBe(
      'kamikaze',
    );
    expect(archetypeOf(p({ played: 90, kd: 10, kills: 20 }), attrs(), 50)).toBe(
      'tourist',
    );
    expect(archetypeOf(p({}), attrs(), 65)).toBe('allrounder');
    expect(archetypeOf(p({}), attrs({ accuracy: 95 }), 70)).toBe('sniper');
    expect(archetypeOf(p({}), attrs({ mutants: 95 }), 70)).toBe('hunter');
  });
});

describe('recap', () => {
  const day = (s: string, kil: number, hours: number) => ({
    day: new Date(`${s}T00:00:00Z`),
    stats: { kil, 'pla-tim': hours * H },
  });

  it('полный месяц: от снимка перед началом, лучший день и активные дни', () => {
    const r = buildRecap(
      [
        day('2026-09-30', 100, 10),
        day('2026-10-05', 150, 13),
        day('2026-10-06', 150, 13),
        day('2026-10-20', 300, 20),
        day('2026-11-01', 999, 99),
      ],
      '2026-10',
    )!;
    expect(r.full).toBe(true);
    expect(r.kills).toBe(200);
    expect(r.hours).toBe(10);
    expect(r.activeDays).toBe(2);
    expect(r.bestDay).toEqual({ day: '2026-10-20', kills: 150, hours: 7 });
  });

  it('следим с середины месяца — от первого снимка, full=false', () => {
    const r = buildRecap(
      [day('2026-10-18', 100, 10), day('2026-10-31', 160, 15)],
      '2026-10',
    )!;
    expect(r.full).toBe(false);
    expect(r.from).toBe('2026-10-18');
    expect(r.kills).toBe(60);
  });

  it('старый снимок до месяца не берём — иначе посчитаем чужие дни', () => {
    const r = buildRecap(
      [
        day('2026-09-01', 0, 0),
        day('2026-10-10', 100, 10),
        day('2026-10-20', 130, 12),
      ],
      '2026-10',
    )!;
    expect(r.kills).toBe(30);
  });

  it('за месяц ничего не прибавилось — null', () => {
    expect(
      buildRecap(
        [day('2026-10-01', 100, 10), day('2026-10-30', 100, 10)],
        '2026-10',
      ),
    ).toBeNull();
  });
});
