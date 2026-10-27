import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  afterEach(() => jest.useRealTimers());

  it('одинаковые запросы склеиваются, повтор - из кеша', async () => {
    const cache = new TtlCache<number>();
    const load = jest.fn().mockResolvedValue(1);
    await Promise.all([
      cache.getOrLoad('a', 1000, load),
      cache.getOrLoad('a', 1000, load),
    ]);
    await cache.getOrLoad('a', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('просроченные записи выметаются, а не висят до вытеснения по размеру', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T00:00:00Z') });
    const cache = new TtlCache<number>(1000);
    for (let i = 0; i < 100; i++)
      await cache.getOrLoad(`old${i}`, 10_000, () => Promise.resolve(i));
    expect(cache.size).toBe(100);
    jest.setSystemTime(new Date('2026-10-27T00:01:00Z'));
    await cache.getOrLoad('new', 10_000, () => Promise.resolve(0));
    expect(cache.size).toBe(1);
  });

  it('сверх лимита вытесняются самые старые', async () => {
    const cache = new TtlCache<number>(3);
    for (const k of ['a', 'b', 'c', 'd'])
      await cache.getOrLoad(k, 60_000, () => Promise.resolve(1));
    expect(cache.size).toBe(3);
  });
});
