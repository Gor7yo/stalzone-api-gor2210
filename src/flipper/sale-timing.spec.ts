import { summarize } from './sale-timing.service';

jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));

type Row = Parameters<typeof summarize>[0][number];

/** 24 часа: 100 сделок и 0% везде, кроме переопределённых. */
function rows(over: Record<number, { delta: number; n: number }>, weeks = 4) {
  const hours: Row[] = Array.from({ length: 24 }, (_, h) => ({
    kind: 'h',
    key: h,
    delta: over[h]?.delta ?? 0,
    n: over[h]?.n ?? 100,
    days: null,
    weeks: null,
  }));
  const days: Row[] = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    kind: 'd',
    key: d,
    delta: 0,
    n: 300,
    days: null,
    weeks: null,
  }));
  const total = hours.reduce((s, h) => s + h.n, 0);
  return [
    ...hours,
    ...days,
    { kind: 'all', key: null, delta: null, n: total, days: 28, weeks },
  ] as Row[];
}

describe('summarize', () => {
  const noon = new Date('2026-10-18T09:00:00Z'); // 12:00 МСК

  it('лучший час — среди «живых»: ночной пик цены при малом числе сделок не советуем', () => {
    const r = summarize(
      rows({
        3: { delta: 9, n: 20 },
        20: { delta: 4, n: 200 },
        6: { delta: -5, n: 100 },
      }),
      noon,
    );
    expect(r.bestHour?.key).toBe(20);
    expect(r.worstHour?.key).toBe(6);
    // сам ночной час в графике остаётся — просто не советуется
    expect(r.hours[3].delta).toBe(9);
  });

  it('мало сделок в часе — без значения (серый столбик)', () => {
    const r = summarize(rows({ 5: { delta: 7, n: 4 } }), noon);
    expect(r.hours[5].delta).toBeNull();
  });

  it('дни недели надёжны только с 8 недель', () => {
    expect(summarize(rows({}, 4), noon).weekdaysReliable).toBe(false);
    expect(summarize(rows({}, 8), noon).weekdaysReliable).toBe(true);
  });

  it('текущий час — по Москве', () => {
    const r = summarize(rows({ 12: { delta: -3, n: 100 } }), noon);
    expect(r.now).toEqual({ key: 12, delta: -3, deals: 100 });
  });

  it('совсем мало сделок — ничего не показываем', () => {
    const tiny: Row[] = [
      { kind: 'all', key: null, delta: null, n: 40, days: 5, weeks: 1 },
    ];
    expect(summarize(tiny, noon).deals).toBe(0);
    expect(summarize(tiny, noon).hours).toEqual([]);
  });
});
