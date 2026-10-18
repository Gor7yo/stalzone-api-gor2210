import { ConflictException } from '@nestjs/common';
import { ProService } from './pro.service';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));

/** Мок Prisma: в транзакцию передаётся он же; счётчики updateMany задаются в тесте. */
function setup(opts: {
  chatId: bigint | null;
  chatFree: boolean;
  userFree: boolean;
}) {
  const db = {
    user: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ proUntil: null, chatId: opts.chatId }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ proUntil: new Date(), trialUsedAt: new Date() }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.userFree ? 1 : 0 }),
      update: jest.fn().mockResolvedValue({ chatId: opts.chatId }),
    },
    telegramSubscriber: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.chatFree ? 1 : 0 }),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  const pro = new ProService(db as never);
  const grant = jest.spyOn(pro, 'grant').mockResolvedValue(new Date());
  return { pro, grant };
}

const code = (e: unknown) =>
  ((e as ConflictException).getResponse() as { code: string }).code;

describe('ProService.startTrial', () => {
  it('без привязанного Telegram пробный не выдаётся', async () => {
    const { pro, grant } = setup({
      chatId: null,
      chatFree: true,
      userFree: true,
    });
    const e = await pro.startTrial('u').catch((x: unknown) => x);
    expect(code(e)).toBe('telegram_required');
    expect(grant).not.toHaveBeenCalled();
  });

  it('Telegram, который уже брал пробный, второй раз не получает', async () => {
    const { pro, grant } = setup({
      chatId: 1n,
      chatFree: false,
      userFree: true,
    });
    const e = await pro.startTrial('u').catch((x: unknown) => x);
    expect(code(e)).toBe('trial_used');
    expect(grant).not.toHaveBeenCalled();
  });

  it('с новым Telegram и аккаунтом - выдаёт', async () => {
    const { pro, grant } = setup({
      chatId: 1n,
      chatFree: true,
      userFree: true,
    });
    await pro.startTrial('u');
    expect(grant).toHaveBeenCalledWith('u', 3);
  });
});
