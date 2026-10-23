import { isActive } from './market-activity.service';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('src/stalzone/api/stalcraft-api.client', () => ({
  StalcraftApiClient: class {},
}));

const DAY = 86_400_000;

describe('isActive: предмет на рынке', () => {
  const now = Date.now();
  it('продавался 10 дней назад - да', () => {
    expect(
      isActive({ lastSaleAt: new Date(now - 10 * DAY), lotsTotal: 0 }, now),
    ).toBe(true);
  });
  it('последняя продажа 40 дней назад, лотов нет - нет', () => {
    expect(
      isActive({ lastSaleAt: new Date(now - 40 * DAY), lotsTotal: 0 }, now),
    ).toBe(false);
  });
  it('продаж не было, но лот выставлен сейчас - да', () => {
    expect(isActive({ lastSaleAt: null, lotsTotal: 3 }, now)).toBe(true);
  });
  it('ни продаж, ни лотов - нет', () => {
    expect(isActive({ lastSaleAt: null, lotsTotal: 0 }, now)).toBe(false);
  });
});
