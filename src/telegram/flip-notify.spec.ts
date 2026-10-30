import type { Flip, FlipFilter } from '../flipper/flip-filter';
import { formatPrice, lotUrl } from './format';
import {
  flipButtons,
  flipMessage,
  flipTitle,
  goneLabel,
  pickNewFlips,
} from './flip-notify';
import { priceMessage } from './price-match';

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
    sellHours: 3,
    profitPerHour: 258_000,
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

  it('об ушедших по базе лотах не пишет, но запоминает их; живой лот той же позиции - вместо ушедшего', () => {
    const goneBest = flip({ buyout: 3_500_000, profit: 775_000 });
    const alive = flip({ buyout: 3_700_000, profit: 575_000 });
    const onlyGone = flip({ itemId: 'x' });
    const { offers, keys } = pickNewFlips(
      [goneBest, alive, onlyGone],
      filter,
      new Set(),
      NOW,
      new Set([goneBest.key, onlyGone.key]),
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ lots: 1, flip: { profit: 575_000 } });
    expect(keys).toHaveLength(3);
  });
});

describe('кнопки и ссылки', () => {
  it('ссылка на предмет - с качеством и заточкой, у модуля - с характеристикой', () => {
    const site = 'https://stalzone-info.ru';
    expect(lotUrl(site, flip())).toBe(`${site}/auction/4lrn?q=3&u=15`);
    expect(
      lotUrl(site, {
        itemId: 'm',
        quality: 1,
        upgrade: 0,
        variant: 'marksman',
      }),
    ).toBe(`${site}/auction/m?q=1&v=marksman`);
    expect(lotUrl(site, { itemId: 'c', quality: -1, upgrade: 0 })).toBe(
      `${site}/auction/c`,
    );
  });

  it('на каждый живой лот - «скопировать название» и сайт; у ушедшего кнопок нет', () => {
    const a = flip({ itemId: 'a', name: 'Жар-птица', quality: 2 });
    const b = flip({ itemId: 'b', name: 'Висмут' });
    const offers = [
      { flip: a, lots: 1 },
      { flip: b, lots: 1 },
    ];
    const rows = flipButtons('https://s', 'ru', offers);
    expect(rows).toHaveLength(3);
    // копируется только название - его вставляют в поиск аукциона в игре
    expect(rows[0][0]).toEqual({
      text: '📋 Жар-птица',
      copy_text: { text: 'Жар-птица' },
    });
    expect(rows[0][1]).toEqual({
      text: '🌐 Особый +15',
      url: 'https://s/auction/a?q=2&u=15',
    });
    expect(rows[2]).toEqual([
      { text: 'Открыть флиппер', url: 'https://s/flips' },
      { text: 'Отключить', callback_data: 'fdel:ru' },
    ]);

    const afterSale = flipButtons(
      'https://s',
      'ru',
      offers,
      new Map([[a.key, 'sold']]),
    );
    expect(afterSale).toHaveLength(2);
    expect(afterSale[0][0]).toMatchObject({ copy_text: { text: 'Висмут' } });
  });

  it('один лот - кнопки словами', () => {
    const [row] = flipButtons('https://s', 'ru', [{ flip: flip(), lots: 1 }]);
    expect(row.map((b) => b.text)).toEqual([
      '📋 Скопировать название',
      '🌐 На сайте',
    ]);
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
    expect(text).toContain('уйдёт за ~3 ч');
  });

  it('ушедший лот — зачёркнут с пометкой и ценой, остальные как были', () => {
    const sold = flip({ itemId: 'a' });
    const alive = flip({ itemId: 'b' });
    const text = flipMessage(
      'ru',
      [
        { flip: sold, lots: 1 },
        { flip: alive, lots: 1 },
      ],
      new Map([[sold.key, 'sold']]),
    );
    expect(text).toContain(
      '<s><b>Висмут · Редкий +15</b></s> · ⛔ выкупили за <b>3,5кк</b>',
    );
    // подробная строка «выкуп … → …» осталась только у живого лота
    expect(text.match(/выкуп /g)).toHaveLength(1);
  });

  it('пачка и истёкший лот: цена за штуку и «выкуп был»', () => {
    const lot = { buyout: 120_000, unitPrice: 6_000, amount: 20 };
    expect(goneLabel('sold', lot)).toBe('⛔ выкупили за <b>120к</b> (6к/шт)');
    expect(goneLabel('expired', lot)).toBe(
      '⌛ время лота вышло, выкуп был <b>120к</b> (6к/шт)',
    );
  });

  it('«5 лотов», а не «5 лота»', () => {
    expect(flipMessage('ru', [{ flip: flip(), lots: 5 }])).toContain(
      '(5 лотов)',
    );
    expect(flipMessage('ru', [{ flip: flip(), lots: 3 }])).toContain(
      '(3 лота)',
    );
  });
});

describe('priceMessage', () => {
  it('выкупленный лот: название зачёркнуто, цена осталась', () => {
    const lot = { amount: 1, buyoutPrice: 1_200_000 };
    expect(priceMessage('Комета · Редкий +10', 'RU', 1_500_000, lot)).toBe(
      [
        '🔔 <b>Комета · Редкий +10</b> · RU',
        'Лот за <b>1,2кк</b> - порог 1,5кк',
        `Выкуп ${formatPrice(1_200_000)}`,
      ].join('\n'),
    );
    const sold = priceMessage(
      'Комета · Редкий +10',
      'RU',
      1_500_000,
      lot,
      'sold',
    );
    expect(sold).toContain('🔔 <s>Комета · Редкий +10</s> · RU');
    expect(sold).toContain('⛔ Выкупили за <b>1,2кк</b> (порог 1,5кк)');
    expect(sold).toContain(`Выкуп ${formatPrice(1_200_000)}`);
  });
});
