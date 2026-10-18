import { collectorProblem, MonitorService } from './monitor.service';

jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
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

describe('MonitorService: тревога только при смене состояния', () => {
  function setup() {
    const sent: string[] = [];
    let failures = 0;
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
      { get: () => undefined } as never,
    );
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    return { sent, tick, setFailures: (n: number) => (failures = n) };
  }

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
