import { decide, lotKey, RENOTIFY_MS } from './price-match';

const lot = (
  buyoutPrice: number,
  additional: Record<string, unknown> = {},
  amount = 1,
) => ({
  itemId: 'x',
  amount,
  startPrice: 1,
  buyoutPrice,
  startTime: String(1_700_000_000 + buyoutPrice),
  endTime: '',
  additional,
});

const alert = (over: Partial<Parameters<typeof decide>[1]> = {}) => ({
  quality: null,
  upgrade: null,
  maxPrice: 5_000_000,
  lastLotKey: null,
  lastNotifiedAt: null,
  ...over,
});

describe('decide', () => {
  const lots = [
    lot(3_000_000, { qlt: 0 }),
    lot(4_500_000, { qlt: 5, ptn: 10 }),
    lot(6_000_000, { qlt: 5 }),
    lot(0, { qlt: 5, ptn: 10 }), // без выкупа
  ];

  it('набор уровней заточки: [1, 10] ловит +10, [1, 5] — нет', () => {
    expect(
      decide(lots, alert({ quality: 5, upgrades: [1, 10] })),
    ).toMatchObject({ action: 'notify', lot: { buyoutPrice: 4_500_000 } });
    expect(decide(lots, alert({ quality: 5, upgrades: [1, 5] }))).toEqual({
      action: 'none',
    });
  });

  it('набор качеств: [0, 5] +10 ловит Легендарный +10, [1, 2] — нет', () => {
    expect(
      decide(lots, alert({ qualities: [0, 5], upgrades: [10] })),
    ).toMatchObject({ action: 'notify', lot: { buyoutPrice: 4_500_000 } });
    expect(decide(lots, alert({ qualities: [1, 2] }))).toEqual({
      action: 'none',
    });
  });

  it('набор уровней главнее старого поля upgrade', () => {
    expect(
      decide(lots, alert({ quality: 5, upgrade: 3, upgrades: [10] })),
    ).toMatchObject({ action: 'notify' });
  });

  it('находит самый дешёвый лот нужного качества и заточки', () => {
    const r = decide(lots, alert({ quality: 5, upgrade: 10 }));
    expect(r).toMatchObject({
      action: 'notify',
      lot: { buyoutPrice: 4_500_000 },
    });
  });

  it('заточка +0 — это лот без поля ptn', () => {
    expect(decide(lots, alert({ quality: 5, upgrade: 0 }))).toEqual({
      action: 'none',
    });
    expect(decide(lots, alert({ quality: 0, upgrade: 0 }))).toMatchObject({
      action: 'notify',
    });
  });

  it('считает цену за штуку', () => {
    const r = decide([lot(9_000_000, {}, 3)], alert({ maxPrice: 3_000_000 }));
    expect(r).toMatchObject({ action: 'notify' });
  });

  it('не повторяет уведомление о том же лоте', () => {
    const l = lot(4_500_000, { qlt: 5, ptn: 10 });
    const a = alert({
      quality: 5,
      upgrade: 10,
      lastLotKey: lotKey(l),
      lastNotifiedAt: new Date(),
    });
    expect(decide([l], a)).toEqual({ action: 'none' });
  });

  it('другой лот по той же цене — только после паузы, более дешёвый — сразу', () => {
    const old = lot(4_000_000);
    const now = Date.now();
    const a = alert({
      lastLotKey: lotKey(old),
      lastNotifiedAt: new Date(now - 60_000),
    });
    const same = { ...lot(4_000_000), startTime: '1' };
    expect(decide([same], a, now)).toEqual({ action: 'none' });
    expect(decide([same], a, now + RENOTIFY_MS)).toMatchObject({
      action: 'notify',
    });
    expect(decide([lot(3_900_000)], a, now)).toMatchObject({
      action: 'notify',
    });
  });

  it('сбрасывает память, когда подходящих лотов не осталось', () => {
    const a = alert({ maxPrice: 1_000_000, lastLotKey: 'k' });
    expect(decide(lots, a)).toEqual({ action: 'reset' });
  });
});
