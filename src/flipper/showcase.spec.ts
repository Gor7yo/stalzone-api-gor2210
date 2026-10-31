import { lotId, pickExamples, toShowcase, type LogRow } from './showcase';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;

const row = (patch: Partial<LogRow> = {}): LogRow => ({
  key: 'k',
  itemId: 'gyn0',
  quality: 3,
  upgrade: 7,
  variant: '',
  amount: 1,
  buyout: 1_000_000n,
  sellUnit: 1_300_000n,
  profit: 235_000n,
  pct: 23.5,
  confidence: 'high',
  deals: 20,
  endTime: new Date(NOW + 10 * 60 * MIN),
  seenAt: new Date(NOW - 5 * 60 * MIN),
  ...patch,
});

const gone = (r: LogRow, at: number) =>
  [lotId(r.itemId, r.amount, r.buyout, r.endTime), new Date(at)] as const;

describe('pickExamples', () => {
  it('живые лоты бесплатно не показывает', () => {
    expect(pickExamples([row()], new Map(), NOW)).toEqual([]);
  });

  it('сначала выкупленные (с временем), потом истёкшие; один предмет - один раз', () => {
    const expired = row({
      itemId: 'a',
      profit: 900_000n,
      endTime: new Date(NOW - MIN),
    });
    const sold = row({ itemId: 'b', profit: 500_000n });
    const soldSame = row({ itemId: 'b', profit: 400_000n, buyout: 1_100_000n });
    const map = new Map([
      gone(sold, NOW - 5 * 60 * MIN + 4 * MIN),
      gone(soldSame, NOW - 60 * MIN),
    ]);
    const out = pickExamples([expired, sold, soldSame], map, NOW);
    expect(out.map((f) => f.itemId)).toEqual(['b', 'a']);
    // выкупили через 4 минуты после появления
    expect(out[0].boughtInMin).toBe(4);
    // истёк, а не выкуплен - времени выкупа нет
    expect(out[1].boughtInMin).toBeNull();
  });
});

describe('toShowcase', () => {
  it('BigInt - в числа, ушёл после конца срока - не «выкупили»', () => {
    const r = row();
    const f = toShowcase(r, new Date(r.endTime.getTime() + MIN));
    expect(f).toMatchObject({
      buyout: 1_000_000,
      profit: 235_000,
      boughtInMin: null,
    });
    expect(f).not.toHaveProperty('variant');
  });
});
