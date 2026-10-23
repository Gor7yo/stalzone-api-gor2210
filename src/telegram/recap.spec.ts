jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { previousMonth, recapCaption } from './recap.service';

describe('recap', () => {
  it('прошлый месяц — по московскому времени', () => {
    // 1 ноября 00:30 МСК = 31 октября 21:30 UTC → уже ноябрь, итоги за октябрь
    expect(previousMonth(Date.UTC(2026, 9, 31, 21, 30))).toBe('2026-10');
    expect(previousMonth(Date.UTC(2026, 0, 15))).toBe('2025-12');
  });

  it('подпись: месяц, цифры, лучший день, неполный месяц', () => {
    const text = recapCaption('Ivan<3', {
      month: '2026-10',
      from: '2026-10-18',
      to: '2026-10-31',
      full: false,
      kills: 1234,
      deaths: 500,
      hours: 41.6,
      mutants: 10,
      damage: 1e6,
      activeDays: 9,
      bestDay: { day: '2026-10-20', kills: 150, hours: 5 },
    });
    expect(text).toContain('Твой октябрь в Зоне</b> · Ivan&lt;3');
    // разряды — неразрывным пробелом (toLocaleString)
    expect(text).toMatch(/\+1\s234 убийств/);
    expect(text).toContain('42 ч в игре');
    expect(text).toContain('Лучший день: 20 октября - 150 убийств');
    expect(text).toContain('Считаем с 18 октября');
  });
});
