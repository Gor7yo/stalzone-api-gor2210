import {
  demandShare,
  hoursToSell,
  priceForHours,
  undercut,
  unitsAhead,
  type SellMarket,
} from './sell-estimate';

const sales = {
  p10: 80_000,
  p25: 90_000,
  median: 100_000,
  p75: 110_000,
  p90: 130_000,
};

// с учётом конкурентов 0,7 × 10 = 7 штук в час (по цене, на которую согласны все)
const market = (ladder: [number, number][]): SellMarket => ({
  ladder: ladder.map(([unit, amount]) => ({ unit, amount })),
  ratePerHour: 10,
  sales,
});

describe('sell-estimate', () => {
  it('перебивает на круглый шаг', () => {
    expect(undercut(95_000)).toBe(94_990);
    expect(undercut(95_005)).toBe(95_000);
    expect(undercut(250_000)).toBe(249_900);
    expect(undercut(500)).toBe(499);
  });

  it('считает лоты по той же цене впереди', () => {
    const m = market([
      [90_000, 2],
      [95_000, 3],
    ]);
    expect(unitsAhead(m.ladder, 95_000)).toBe(5);
    expect(unitsAhead(m.ladder, 94_999)).toBe(2);
  });

  it('доля покупателей по перцентилям сделок', () => {
    expect(demandShare(sales, 100_000)).toBeCloseTo(0.5);
    expect(demandShare(sales, 120_000)).toBeCloseTo(0.175);
    expect(demandShare(sales, 50_000)).toBe(1);
    expect(demandShare(sales, 200_000)).toBe(0);
  });

  it('за час — перебить лот, до которого очередь успеет дойти', () => {
    const m = market([
      [90_000, 3],
      [95_000, 3],
      [99_000, 5],
    ]);
    // перед лотом 95к — 3 штуки впереди, на цену ~97к согласны 57 % покупателей: успеваем
    // перед лотом 99к — 6 штук впереди, нужны все покупатели: не успеваем
    expect(priceForHours(m, 1)).toBe(94_990);
  });

  it('чем дольше срок, тем выше цена', () => {
    const m = market([
      [90_000, 3],
      [95_000, 3],
      [99_000, 5],
    ]);
    const prices = [1, 6, 24, 48].map((h) => priceForHours(m, h)!);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[3]).toBeGreaterThan(110_000);
  });

  it('пустой рынок — цену держит только спрос', () => {
    expect(priceForHours(market([]), 6)).toBe(140_100);
    expect(priceForHours(market([[200_000, 1]]), 6)).toBe(140_100);
  });

  it('спрос меньше штуки за срок — не продать', () => {
    const m = { ...market([]), ratePerHour: 0.1 };
    expect(priceForHours(m, 1)).toBeNull();
    expect(priceForHours(m, 24)).toBe(96_190);
  });

  it('время продажи по цене', () => {
    const m = market([
      [90_000, 3],
      [95_000, 3],
    ]);
    expect(hoursToSell(m, 89_000)).toBeCloseTo(1 / (7 * 0.765));
    expect(hoursToSell(m, 96_000)).toBeCloseTo(7 / (7 * 0.6));
    // дороже всех сделок — не купят
    expect(hoursToSell(m, 160_000)).toBeNull();
  });
});
