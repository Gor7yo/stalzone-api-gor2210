import type { Flip, FlipFilter } from '../flipper/flip-filter';
import { flipMessage, flipTitle, pickNewFlips } from './flip-notify';

const NOW = Date.parse('2026-10-11T18:00:00Z');

const flip = (patch: Partial<Flip> = {}): Flip => {
  const f: Flip = {
    key: '',
    itemId: '4lrn',
    name: 'Висмут',
    group: 'artefact',
    quality: 3,
    upgrade: 15,
    amount: 1,
    buyout: 3_500_000,
    unitPrice: 3_500_000,
    sellUnit: 4_500_000,
    profit: 775_000,
    pct: 22.1,
    profitLow: 100_000,
    basis: 'exact',
    deals: 24,
    perDay: 3.4,
    confidence: 'high',
    seenAt: new Date(NOW - 60_000).toISOString(),
    endTime: '2026-10-12T00:00:00Z',
    lastSale: '2026-10-11T12:00:00Z',
    ...patch,
  };
  return {
    ...f,
    key: f.key || `${f.itemId}|${f.quality}|${f.upgrade}|${f.buyout}`,
  };
};

const filter: FlipFilter = {
  minProfit: 100_000,
  minPct: 10,
  minConfidence: 'medium',
  maxBudget: 0,
  groups: [],
};

describe('pickNewFlips', () => {
  it('отбирает по прибыли, надёжности, бюджету и категории', () => {
    const flips = [
      flip(),
      flip({ itemId: 'a', profit: 50_000 }),
      flip({ itemId: 'b', confidence: 'low' }),
      flip({ itemId: 'c', buyout: 20_000_000 }),
      flip({ itemId: 'd', group: 'weapon' }),
    ];
    const { offers } = pickNewFlips(
      flips,
      { ...filter, maxBudget: 10_000_000, groups: ['artefact'] },
      new Set(),
      NOW,
    );
    expect(offers.map((o) => o.flip.itemId)).toEqual(['4lrn']);
  });

  it('не повторяет отправленные и пропускает устаревшие снимки', () => {
    const sent = flip();
    const old = flip({
      itemId: 'old',
      seenAt: new Date(NOW - 60 * 60_000).toISOString(),
    });
    const { offers } = pickNewFlips(
      [sent, old],
      filter,
      new Set([sent.key]),
      NOW,
    );
    expect(offers).toHaveLength(0);
  });

  it('одинаковые лоты — одной строкой с самым выгодным, но запоминает все ключи', () => {
    const a = flip({ buyout: 3_500_000, profit: 775_000 });
    const b = flip({ buyout: 3_700_000, profit: 575_000 });
    const { offers, keys } = pickNewFlips([b, a], filter, new Set(), NOW);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ lots: 2, flip: { profit: 775_000 } });
    expect(keys).toHaveLength(2);
  });
});

describe('flipMessage', () => {
  it('название с качеством и заточкой, лишнее — «и ещё»', () => {
    expect(flipTitle(flip())).toBe('Висмут · Редкий +15');
    expect(flipTitle(flip({ quality: -1, upgrade: 0, name: undefined }))).toBe(
      'Предмет 4lrn',
    );
    // модуль: вместо заточки - ключевая характеристика в кавычках
    expect(
      flipTitle(
        flip({
          name: 'Оружейный модуль',
          quality: 1,
          upgrade: 0,
          variant: 'hip_spread_aff',
        }),
      ),
    ).toBe('Оружейный модуль · Необычный «Проектор»');
    const offers = Array.from({ length: 7 }, (_, i) => ({
      flip: flip({ itemId: `i${i}` }),
      lots: 1,
    }));
    const text = flipMessage('ru', offers);
    expect(text).toContain('Новые флипы');
    expect(text).toContain('+775к');
    expect(text).toContain('и ещё 2');
  });
});
