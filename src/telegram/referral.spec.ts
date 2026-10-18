import { ReferralService } from './referral.service';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));

/** Мок Prisma для onLinked: кто пригласил, свободен ли пробный, сколько бонусов за месяц. */
function setup(opts: {
  referredBy: string | null;
  trialFree?: boolean;
  rewardedMonth?: number;
  alreadyCounted?: boolean;
}) {
  const created: unknown[] = [];
  const db = {
    telegramSubscriber: {
      findUnique: jest.fn().mockResolvedValue({ referredBy: opts.referredBy }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.trialFree === false ? 0 : 1 }),
    },
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ login: 'x', chatId: null }),
    },
    referral: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.alreadyCounted ? { id: 'r' } : null),
      count: jest.fn().mockResolvedValue(opts.rewardedMonth ?? 0),
      create: jest.fn((args: { data: unknown }) => {
        created.push(args.data);
        return Promise.resolve(args.data);
      }),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  const pro = { grant: jest.fn().mockResolvedValue(new Date()) };
  const bot = { send: jest.fn().mockResolvedValue(true), username: 'bot' };
  const service = new ReferralService(db as never, pro as never, bot as never);
  return { service, pro, created };
}

describe('ReferralService.onLinked', () => {
  it('друг по ссылке: пробный 3 дня ему и +1 день пригласившему', async () => {
    const { service, pro, created } = setup({ referredBy: 'inviter' });
    await service.onLinked('friend', 1n);
    expect(pro.grant).toHaveBeenCalledWith('friend', 3);
    expect(pro.grant).toHaveBeenCalledWith('inviter', 1);
    expect(created).toEqual([
      expect.objectContaining({
        inviterId: 'inviter',
        inviteeId: 'friend',
        rewarded: true,
      }),
    ]);
  });

  it('10 бонусов за 30 дней: друг получает пробный, пригласивший — нет', async () => {
    const { service, pro, created } = setup({
      referredBy: 'inviter',
      rewardedMonth: 10,
    });
    await service.onLinked('friend', 1n);
    expect(pro.grant).toHaveBeenCalledWith('friend', 3);
    expect(pro.grant).not.toHaveBeenCalledWith('inviter', 1);
    expect(created).toEqual([expect.objectContaining({ rewarded: false })]);
  });

  it('друг уже брал пробный — не получает никто', async () => {
    const { service, pro, created } = setup({
      referredBy: 'inviter',
      trialFree: false,
    });
    await service.onLinked('friend', 1n);
    expect(pro.grant).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('без приглашения, сам себя или уже засчитан — ничего', async () => {
    for (const opts of [
      { referredBy: null },
      { referredBy: 'friend' },
      { referredBy: 'inviter', alreadyCounted: true },
    ]) {
      const { service, pro } = setup(opts);
      await service.onLinked('friend', 1n);
      expect(pro.grant).not.toHaveBeenCalled();
    }
  });
});
