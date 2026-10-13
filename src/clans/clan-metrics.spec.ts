import {
  dailyLast,
  regionSeries,
  series,
  summarizeRegion,
  type RegionClan,
  type Snap,
} from './clan-metrics';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 20, 12);

const snap = (hoursAgo: number, memberCount: number, level = 1): Snap => ({
  at: NOW - hoursAgo * H,
  level,
  memberCount,
});

describe('clan-metrics: клан', () => {
  const snaps = [snap(240, 8), snap(100, 12), snap(48, 10, 2), snap(2, 11, 2)];
  const current = snap(0, 11, 2);

  it('по дням — последний снимок дня', () => {
    // 18.10 10:00 и 11:00, 19.10 11:00 и 11:30 (UTC)
    const day = [snap(50, 1), snap(49, 2), snap(25, 3), snap(24.5, 4)];
    expect(dailyLast(day).map((s) => s.memberCount)).toEqual([2, 4]);
  });

  it('график недели начинается с состояния на начало периода и кончается текущим', () => {
    const pts = series(snaps, current, NOW, 'week');
    expect(pts[0]).toMatchObject({ t: NOW - 7 * D, memberCount: 8 });
    expect(pts[pts.length - 1]).toMatchObject({ t: NOW, memberCount: 11 });
    expect(pts.map((p) => p.memberCount)).toEqual([8, 12, 10, 11, 11]);
  });

  it('всё время — с первого снимка', () => {
    expect(series(snaps, current, NOW, 'all')[0]).toMatchObject({
      memberCount: 8,
    });
  });
});

describe('clan-metrics: динамика региона', () => {
  // два клана появились 3 часа назад, через час один прибавил бойцов, ещё через час второй распущен
  const t0 = NOW - 3 * H;
  const events = [
    { t: t0, alliance: 'duty', dm: 10, dc: 1 },
    { t: t0, alliance: 'freedom', dm: 5, dc: 1 },
    { t: t0 + H, alliance: 'duty', dm: 2, dc: 0 },
    { t: t0 + 2 * H, alliance: 'freedom', dm: -5, dc: -1 },
  ];

  it('накопленные бойцы и кланы по часам', () => {
    const pts = regionSeries(events, NOW - 7 * D, NOW, H);
    expect(pts.map((p) => [p.members, p.clans])).toEqual([
      [15, 2],
      [17, 2],
      [12, 1],
    ]);
    expect(pts[2].alliances).toEqual({ duty: 12, freedom: 0 });
    expect(pts[2].t).toBe(NOW);
  });

  it('период короче истории — изменения до него уже учтены', () => {
    const pts = regionSeries(events, t0 + H, NOW, H);
    expect(pts.map((p) => p.members)).toEqual([17, 12]);
  });

  it('без истории — пусто', () => {
    expect(regionSeries([], 0, NOW, H)).toEqual([]);
  });
});

describe('clan-metrics: сводка региона', () => {
  const clan = (id: string, o: Partial<RegionClan>): RegionClan => ({
    id,
    tag: id.toUpperCase(),
    name: id,
    alliance: 'duty',
    level: 1,
    memberCount: 5,
    registrationTime: NOW - 100 * D,
    day: null,
    week: null,
    ...o,
  });
  const base = (memberCount: number, at = NOW - 7 * D) => ({ memberCount, at });

  const clans = [
    clan('a', {
      memberCount: 35,
      level: 2,
      week: base(20),
      day: base(33, NOW - D),
    }),
    clan('b', {
      memberCount: 4,
      alliance: 'freedom',
      week: base(10),
      day: base(4, NOW - D),
    }),
    clan('c', {
      memberCount: 1,
      alliance: null,
      registrationTime: NOW - 2 * D,
      week: base(1, NOW - 2 * D),
    }),
  ];
  const s = summarizeRegion(clans, NOW, NOW - 8 * D);

  it('рост и отток бойцов', () => {
    expect(s.growth.week.map((r) => [r.id, r.delta])).toEqual([['a', 15]]);
    expect(s.growth.day.map((r) => [r.id, r.delta])).toEqual([['a', 2]]);
    expect(s.decline.map((r) => [r.id, r.delta])).toEqual([['b', -6]]);
  });

  it('итоги', () => {
    expect(s.totals).toMatchObject({
      clans: 3,
      members: 40,
      full: 1,
      membersWeek: 9,
      joinedWeek: 15,
      leftWeek: 6,
      changedWeek: 2,
    });
    expect(s.windows.week.full).toBe(true);
  });

  it('группировки — без кланов без группировки', () => {
    expect(s.alliances.map((a) => a.alliance)).toEqual(['duty', 'freedom']);
    expect(s.alliances[0]).toMatchObject({
      clans: 1,
      members: 35,
      membersWeek: 15,
    });
    expect(s.alliances[0].share).toBeCloseTo(35 / 39);
  });

  it('распределения', () => {
    expect(s.sizes).toHaveLength(35);
    expect(s.sizes[0]).toEqual({ members: 1, clans: 1 });
    expect(s.sizes[34]).toEqual({ members: 35, clans: 1 });
    expect(s.newClans.list[0]).toMatchObject({ id: 'c', ageDays: 2 });
    expect(s.levels).toEqual([
      { level: 1, clans: 2, members: 5 },
      { level: 2, clans: 1, members: 35 },
    ]);
    expect(s.ages.find((b) => b.label === 'до месяца')?.clans).toBe(1);
  });
});
