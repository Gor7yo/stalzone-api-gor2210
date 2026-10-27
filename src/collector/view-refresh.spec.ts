import { CollectorService } from './collector.service';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('src/stalzone/api/stalcraft-api.client', () => ({
  StalcraftApiClient: class {},
}));

const MIN = 60_000;

/** Сборщик с подменённой базой и снимками: считаем, какие предметы он освежил. */
function setup(items: { itemId: string; lastLotsAt: Date | null }[]) {
  const collector = new CollectorService(
    {
      trackedItem: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            items.map((i) => ({ region: 'eu', flipScore: 5, ...i })),
          ),
      },
    } as never,
    {} as never,
    { get: () => undefined } as never,
  );
  const inner = collector as unknown as {
    enabled: boolean;
    collectFresh: (item: { itemId: string }) => Promise<void>;
    collectLots: (item: { itemId: string }) => Promise<void>;
  };
  // в jest NODE_ENV=test - сборщик выключен; проверку по запросу гоняем как на проде
  inner.enabled = true;
  const fresh: string[] = [];
  const full: string[] = [];
  inner.collectFresh = (item) => {
    fresh.push(item.itemId);
    return Promise.resolve();
  };
  inner.collectLots = (item) => {
    full.push(item.itemId);
    return Promise.resolve();
  };
  return { collector, fresh, full };
}

describe('проверка по запросу ленты флиппера', () => {
  afterEach(() => jest.useRealTimers());

  it('не чаще раза в минуту на регион, свежий снимок - быстрой проверкой, старый - полным', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T12:00:00Z') });
    const now = Date.now();
    const { collector, fresh, full } = setup([
      { itemId: 'a', lastLotsAt: new Date(now - 10 * MIN) },
      { itemId: 'b', lastLotsAt: new Date(now - 5 * 60 * MIN) },
    ]);
    expect(await collector.refreshForViewers('eu')).toBe(true);
    expect(fresh).toEqual(['a']);
    expect(full).toEqual(['b']);
    expect(collector.viewRefreshState('eu')?.doneAt).not.toBeNull();

    // через 30 с - ещё рано, никого не трогаем
    jest.setSystemTime(now + 30_000);
    expect(await collector.refreshForViewers('eu')).toBe(false);
    expect(fresh).toHaveLength(1);
  });

  it('регион, которого нет в сборщике, - ничего не делаем', async () => {
    const { collector, fresh } = setup([{ itemId: 'a', lastLotsAt: null }]);
    expect(await collector.refreshForViewers('sea')).toBe(false);
    expect(fresh).toHaveLength(0);
  });
});
