import {
  alertsProblem,
  collectorProblem,
  MonitorService,
} from './monitor.service';

jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./alerts.watcher', () => ({
  AlertsWatcher: class {},
  PRICE_LAG_MS: 5 * 60_000,
}));
jest.mock('src/collector/collector.service', () => ({
  CollectorService: class {},
}));
jest.mock('src/stalzone/api/stalcraft-api.client', () => ({
  StalcraftApiClient: class {},
}));

const MIN = 60_000;

describe('collectorProblem', () => {
  const now = Date.now();
  it('свежие лоты — всё в порядке', () => {
    expect(collectorProblem(new Date(now - 3 * MIN), now)).toBeNull();
  });
  it('15+ минут без снимков — тревога с числом минут', () => {
    expect(collectorProblem(new Date(now - 20 * MIN), now)).toContain('20 мин');
  });
  it('лотов нет вообще — тревога', () => {
    expect(collectorProblem(null, now)).not.toBeNull();
  });
});

describe('alertsProblem', () => {
  it('все предметы проверены вовремя — всё в порядке', () => {
    expect(
      alertsProblem({ items: 40, lagging: 0, maxLagMs: 2 * MIN }),
    ).toBeNull();
  });
  it('часть опаздывает — сколько из скольких и самый давний', () => {
    const p = alertsProblem({ items: 300, lagging: 120, maxLagMs: 12 * MIN });
    expect(p).toContain('120 из 300');
    expect(p).toContain('12 мин');
  });
});

describe('MonitorService: тревога только при смене состояния', () => {
  function setup() {
    const sent: string[] = [];
    let failures = 0;
    let lagging = 0;
    const monitor = new MonitorService(
      { $queryRaw: jest.fn().mockResolvedValue([{ at: new Date() }]) } as never,
      {
        enabled: true,
        send: jest.fn((_: number, html: string) => {
          sent.push(html);
          return Promise.resolve(true);
        }),
      } as never,
      { adminIds: ['1'] } as never,
      { enabled: true } as never,
      { failuresSince: () => failures } as never,
      {
        priceStatus: () => ({
          items: 50,
          lagging,
          maxLagMs: lagging ? 9 * MIN : MIN,
        }),
      } as never,
      { get: () => undefined } as never,
    );
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    // в jest NODE_ENV=test — мониторинг выключен; разовые тревоги проверяем как на проде
    (monitor as unknown as { enabled: boolean }).enabled = true;
    return {
      sent,
      tick,
      monitor,
      setFailures: (n: number) => (failures = n),
      setLagging: (n: number) => (lagging = n),
    };
  }

  it('алерты по цене: одна тревога за всё опоздание и одно «снова работает»', async () => {
    const { sent, tick, setLagging } = setup();
    setLagging(30);
    await tick();
    await tick();
    expect(sent.filter((s) => s.includes('Алерты по цене'))).toHaveLength(1);
    expect(sent[0]).toContain('30 из 50');
    setLagging(0);
    await tick();
    expect(
      sent.filter((s) => s.startsWith('✅') && s.includes('Алерты')),
    ).toHaveLength(1);
  });

  it('разовая тревога: повтор за 30 минут не шлём, а считаем', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T03:00:00Z') });
    try {
      const { sent, monitor } = setup();
      await monitor.alert('tribute:signature', 'плохая подпись');
      await monitor.alert('tribute:signature', 'плохая подпись');
      await monitor.alert('tribute:signature', 'плохая подпись');
      await monitor.alert('tribute:format', 'формат');
      expect(sent).toEqual(['⚠️ плохая подпись', '⚠️ формат']);
      jest.setSystemTime(new Date('2026-10-22T03:31:00Z'));
      await monitor.alert('tribute:signature', 'плохая подпись');
      expect(sent[2]).toContain('ещё 2');
    } finally {
      jest.useRealTimers();
    }
  });

  it('EXBO: одна тревога за весь сбой и одно «снова работает»', async () => {
    const { sent, tick, setFailures } = setup();
    await tick();
    expect(sent.filter((s) => s.includes('EXBO'))).toHaveLength(0);
    setFailures(25);
    await tick();
    await tick();
    expect(sent.filter((s) => s.startsWith('⚠️'))).toHaveLength(1);
    setFailures(0);
    await tick();
    expect(sent.filter((s) => s.startsWith('✅'))).toHaveLength(1);
  });
});
