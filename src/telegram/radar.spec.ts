import { freshSignals, radarKey, radarSignals, type RadarRow } from './radar';

const row = (patch: Partial<RadarRow> = {}): RadarRow => ({
  itemId: 'y1q9',
  variant: '',
  quality: 3,
  upgrade: 10,
  hourMedian: 1_000_000,
  hourN: 6,
  baseMedian: 1_000_000,
  baseN: 40,
  days: [1_000_000, 1_000_000, 1_000_000, 1_000_000],
  ...patch,
});

describe('radarSignals', () => {
  it('спокойный рынок — сигналов нет', () => {
    expect(radarSignals(row({ hourMedian: 1_150_000 }))).toEqual([]);
  });

  it('обвал за час на 25 %+ — «вниз»', () => {
    const [s] = radarSignals(row({ hourMedian: 700_000 }));
    expect(s).toMatchObject({ kind: 'down', from: 1_000_000, to: 700_000 });
    expect(s.change).toBeCloseTo(-0.3);
  });

  it('скачок вверх, но сделок за час мало — не верим', () => {
    expect(radarSignals(row({ hourMedian: 1_500_000 }))[0]?.kind).toBe('up');
    expect(radarSignals(row({ hourMedian: 1_500_000, hourN: 2 }))).toEqual([]);
  });

  it('рост сутки за сутками на 15 %+ — «тренд»; с провалом в середине — нет', () => {
    const trend = radarSignals(
      row({ days: [1_000_000, 1_050_000, 1_120_000, 1_200_000] }),
    );
    expect(trend).toEqual([
      expect.objectContaining({
        kind: 'trend',
        from: 1_000_000,
        to: 1_200_000,
      }),
    ]);
    expect(
      radarSignals(row({ days: [1_000_000, 1_100_000, 1_050_000, 1_300_000] })),
    ).toEqual([]);
    expect(
      radarSignals(row({ days: [1_000_000, null, 1_100_000, 1_200_000] })),
    ).toEqual([]);
  });
});

describe('freshSignals', () => {
  it('тот же сигнал по позиции — не чаще раза в 12 часов', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    const signals = radarSignals(row({ hourMedian: 700_000 }));
    const key = 'ru|' + radarKey(signals[0].row, 'down');
    expect(
      freshSignals(signals, new Map([[key, now - 60 * 60_000]]), now, 'ru|'),
    ).toEqual([]);
    expect(
      freshSignals(
        signals,
        new Map([[key, now - 13 * 60 * 60_000]]),
        now,
        'ru|',
      ),
    ).toHaveLength(1);
    // в другом регионе — свой счётчик
    expect(
      freshSignals(signals, new Map([[key, now]]), now, 'eu|'),
    ).toHaveLength(1);
  });
});
