import { BudgetExhaustedError, TokenBudget } from './token-budget';

describe('TokenBudget: кто сколько может взять', () => {
  /** кошелёк 400/мин, резерв людям 60; осталось ровно столько, сколько оставляет сборщик */
  function atReserve() {
    jest.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z') });
    const b = new TokenBudget(400, 60);
    return b.take(340, 'user').then(() => b);
  }

  afterEach(() => jest.useRealTimers());

  it('сборщик не трогает резерв людей', async () => {
    const b = await atReserve();
    await expect(b.take(2, 'background')).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });

  it('обход справочника берёт верхнюю половину резерва, но не больше', async () => {
    const b = await atReserve();
    for (let i = 0; i < 15; i++) await b.take(2, 'scan');
    await expect(b.take(2, 'scan')).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });

  it('людям после обхода остаётся половина резерва', async () => {
    const b = await atReserve();
    for (let i = 0; i < 15; i++) await b.take(2, 'scan');
    await expect(b.take(30, 'user')).resolves.toBeUndefined();
  });
});
