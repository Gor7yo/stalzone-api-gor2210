import { ReferralService } from './referral.service';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('src/players/players.service', () => ({ PlayersService: class {} }));

/**
 * Мок Prisma для onLinked: кто пригласил, свободен ли пробный, сколько бонусов за месяц,
 * сколько часов у друга в игре.
 */
function setup(opts: {
  referredBy: string | null;
  trialFree?: boolean;
  rewardedMonth?: number;
  alreadyCounted?: boolean;
  hours?: number;
}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
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
      findUnique: jest.fn().mockResolvedValue({ login: 'x', chatId: 5n }),
    },
    referral: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.alreadyCounted ? { id: 'r' } : null),
      count: jest.fn().mockResolvedValue(opts.rewardedMonth ?? 0),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'r1', ...args.data });
      }),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        return Promise.resolve({ count: 1 });
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'r1', inviterId: 'inviter', inviteeId: 'friend' },
        ]),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  const pro = { grant: jest.fn().mockResolvedValue(new Date()) };
  const bot = { send: jest.fn().mockResolvedValue(true), username: 'bot' };
  const players = {
    accountHours: jest.fn().mockResolvedValue(opts.hours ?? 10),
  };
  const service = new ReferralService(
    db as never,
    pro as never,
    bot as never,
    players as never,
  );
  return { service, pro, bot, players, created, updated };
}

describe('ReferralService.onLinked', () => {
  it('друг с 5+ часами: пробный 3 дня ему и +1 день пригласившему', async () => {
    const { service, pro, created, updated } = setup({ referredBy: 'inviter' });
    await service.onLinked('friend', 1n);
    expect(pro.grant).toHaveBeenCalledWith('friend', 3);
    expect(pro.grant).toHaveBeenCalledWith('inviter', 1);
    expect(created).toEqual([
      expect.objectContaining({ inviterId: 'inviter', inviteeId: 'friend' }),
    ]);
    expect(updated).toEqual([
      expect.objectContaining({ rewarded: true, pendingUntil: null }),
    ]);
  });

  it('у друга меньше 5 часов: пробный ему, бонус пригласившему ждёт', async () => {
    const { service, pro, bot, updated } = setup({
      referredBy: 'inviter',
      hours: 2,
    });
    await service.onLinked('friend', 1n);
    expect(pro.grant).toHaveBeenCalledWith('friend', 3);
    expect(pro.grant).not.toHaveBeenCalledWith('inviter', 1);
    expect(updated).toEqual([]);
    expect(bot.send).toHaveBeenCalledWith(
      5n,
      expect.stringContaining('когда у него будет 5 часов'),
    );
  });

  it('10 бонусов за 30 дней: друг получает пробный, пригласивший — нет', async () => {
    const { service, pro, updated } = setup({
      referredBy: 'inviter',
      rewardedMonth: 10,
    });
    await service.onLinked('friend', 1n);
    expect(pro.grant).toHaveBeenCalledWith('friend', 3);
    expect(pro.grant).not.toHaveBeenCalledWith('inviter', 1);
    expect(updated).toEqual([expect.objectContaining({ rewarded: false })]);
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

describe('ReferralService.checkPending', () => {
  it('друг наиграл 5 часов — +1 день пригласившему (по снимкам, без EXBO)', async () => {
    const { service, pro, players } = setup({
      referredBy: null,
      hours: 6,
    });
    await service.checkPending();
    expect(players.accountHours).toHaveBeenCalledWith('friend', false);
    expect(pro.grant).toHaveBeenCalledWith('inviter', 1);
  });

  it('пока меньше 5 часов — ждём дальше', async () => {
    const { service, pro } = setup({ referredBy: null, hours: 3 });
    await service.checkPending();
    expect(pro.grant).not.toHaveBeenCalled();
  });
});
