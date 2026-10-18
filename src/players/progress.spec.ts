import { buildProgress, mskDay, numericStats, usernameKey } from './progress';

const DAY = 24 * 3_600_000;
// 20.10.2026 12:00 МСК
const NOW = Date.UTC(2026, 9, 20, 9);
const day = (daysAgo: number) => new Date(+mskDay(NOW) - daysAgo * DAY);
const snap = (
  daysAgo: number,
  kil: number,
  extra: Record<string, number> = {},
) => ({
  day: day(daysAgo),
  stats: { kil, dea: kil / 2, 'pla-tim': kil * 1000, ...extra },
});

describe('progress', () => {
  it('день по Москве: 21:30 UTC (00:30 МСК) — уже следующий день', () => {
    expect(mskDay(Date.UTC(2026, 9, 19, 21, 30)).toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
    expect(mskDay(Date.UTC(2026, 9, 19, 20, 30)).toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
  });

  it('числовые статы: строки-числа берём, даты и мусор пропускаем', () => {
    expect(
      numericStats([
        { id: 'kil', type: 'INTEGER', value: 10 },
        { id: 'kd', type: 'DECIMAL', value: '1.5' },
        { id: 'reg-tim', type: 'DATE', value: '2024-01-01' },
        { id: 'bad', type: 'INTEGER', value: 'x' },
      ]),
    ).toEqual({ kil: 10, kd: 1.5 });
  });

  it('ник: регистр и ё не важны', () => {
    expect(usernameKey(' Ёжик_Pro ')).toBe('ежик_pro');
  });

  it('один снимок — прогресса ещё нет', () => {
    const p = buildProgress([snap(0, 100)], 'week', NOW);
    expect(p.since).toBe('2026-10-20');
    expect(p.from).toBeNull();
    expect(p.deltas).toEqual({});
  });

  it('неделя: от последнего снимка не позже начала периода', () => {
    const p = buildProgress(
      [snap(10, 50), snap(8, 80), snap(3, 100), snap(0, 130)],
      'week',
      NOW,
    );
    expect(p.from).toBe(day(8).toISOString().slice(0, 10));
    expect(p.full).toBe(true);
    expect(p.days).toBe(8);
    expect(p.deltas.kil).toBe(50);
    expect(p.daily.map((d) => d.kil)).toEqual([20, 30]);
  });

  it('следим меньше периода — от первого снимка, full=false', () => {
    const p = buildProgress([snap(2, 100), snap(0, 110)], 'month', NOW);
    expect(p.full).toBe(false);
    expect(p.days).toBe(2);
    expect(p.deltas).toEqual({ kil: 10, dea: 5, 'pla-tim': 10_000 });
  });

  it('уменьшение статы не показываем', () => {
    const p = buildProgress(
      [snap(1, 100, { x: 5 }), snap(0, 100, { x: 3 })],
      'week',
      NOW,
    );
    expect(p.deltas).toEqual({});
    expect(p.daily[0].kil).toBe(0);
  });
});
