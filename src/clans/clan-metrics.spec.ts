import {
  baseAt,
  dailyLast,
  levelSince,
  peakMembers,
  series,
  summarizeRegion,
  windowDelta,
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
  // история 10 дней: 8 → 12 → 10 → 11 бойцов, уровень 1 → 2 два дня назад
  const snaps = [snap(240, 8), snap(100, 12), snap(48, 10, 2), snap(2, 11, 2)];
  const current = snap(0, 11, 2);

  it('база окна — последний снимок не позже начала окна', () => {
    expect(baseAt(snaps, NOW - D)?.memberCount).toBe(10);
    expect(baseAt(snaps, NOW - 7 * D)?.memberCount).toBe(8);
  });

  it('изменение бойцов за сутки и неделю', () => {
    expect(
      windowDelta(snaps, current, NOW, { key: 'day', days: 1 }),
    ).toMatchObject({
      full: true,
      members: 1,
    });
    expect(
      windowDelta(snaps, current, NOW, { key: 'week', days: 7 }),
    ).toMatchObject({
      full: true,
      members: 3,
    });
  });

  it('история короче окна — от самого раннего снимка, окно неполное', () => {
    expect(
      windowDelta(snaps, current, NOW, { key: 'month', days: 30 }),
    ).toMatchObject({
      full: false,
      members: 3,
    });
  });

  it('без истории — пусто', () => {
    expect(
      windowDelta([], current, NOW, { key: 'day', days: 1 }).members,
    ).toBeNull();
  });

  it('пик численности', () => {
    expect(peakMembers(snaps, current)).toEqual({
      memberCount: 12,
      at: new Date(NOW - 100 * H).toISOString(),
    });
  });

  it('когда взят текущий уровень', () => {
    expect(levelSince(snaps, current)).toBe(
      new Date(NOW - 48 * H).toISOString(),
    );
    // с начала истории на этом уровне — неизвестно
    expect(
      levelSince([snap(10, 5, 2), snap(5, 6, 2)], snap(0, 6, 2)),
    ).toBeNull();
  });

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
});

describe('clan-metrics: регион', () => {
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
  const base = (memberCount: number, level = 1, at = NOW - 7 * D) => ({
    memberCount,
    level,
    at,
  });

  const clans = [
    clan('a', {
      memberCount: 30,
      level: 2,
      week: base(20, 1),
      day: base(28, 2, NOW - D),
    }),
    clan('b', {
      memberCount: 4,
      alliance: 'freedom',
      week: base(10),
      day: base(4, 1, NOW - D),
    }),
    clan('c', {
      memberCount: 1,
      alliance: null,
      registrationTime: NOW - 2 * D,
      week: base(1, 1, NOW - 2 * D),
    }),
  ];
  const s = summarizeRegion(clans, NOW, NOW - 8 * D);

  it('рост и отток бойцов', () => {
    expect(s.growth.week.map((r) => [r.id, r.delta])).toEqual([['a', 10]]);
    expect(s.growth.day.map((r) => [r.id, r.delta])).toEqual([['a', 2]]);
    expect(s.decline.map((r) => [r.id, r.delta])).toEqual([['b', -6]]);
  });

  it('итоги', () => {
    expect(s.totals).toMatchObject({
      clans: 3,
      members: 35,
      membersWeek: 4,
      joinedWeek: 10,
      leftWeek: 6,
      changedWeek: 2,
      medianMembers: 4,
    });
    expect(s.windows.week.full).toBe(true);
  });

  it('группировки', () => {
    expect(s.alliances[0]).toMatchObject({
      alliance: 'duty',
      clans: 1,
      members: 30,
      membersWeek: 10,
    });
    expect(s.alliances.find((a) => a.alliance === 'none')?.clans).toBe(1);
  });

  it('новые, повысившие уровень, распределения', () => {
    expect(s.newClans.list[0]).toMatchObject({ id: 'c', ageDays: 2 });
    expect(s.levelUps.list).toEqual([
      expect.objectContaining({ id: 'a', fromLevel: 1, level: 2 }),
    ]);
    expect(s.levels).toEqual([
      { level: 1, clans: 2, members: 5 },
      { level: 2, clans: 1, members: 30 },
    ]);
    expect(s.sizes.find((b) => b.label === '21–50')?.clans).toBe(1);
    expect(s.ages.find((b) => b.label === 'до месяца')?.clans).toBe(1);
    expect(s.ages.find((b) => b.label === '1–6 мес')?.clans).toBe(2);
  });
});
