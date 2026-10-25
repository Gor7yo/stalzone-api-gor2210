import { createHmac } from 'node:crypto';

// настоящий клиент Prisma (generated/) в юнит-тесте не нужен — только класс ошибки
jest.mock(
  'generated/prisma/client',
  () => ({
    Prisma: {
      PrismaClientKnownRequestError: class extends Error {
        constructor(
          message: string,
          readonly meta: { code: string },
        ) {
          super(message);
        }
        get code() {
          return this.meta.code;
        }
      },
    },
  }),
  { virtual: true },
);
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./monitor.service', () => ({ MonitorService: class {} }));
jest.mock('./telegram-bot.service', () => ({ TelegramBotService: class {} }));
jest.mock('./pro.service', () => ({ ProService: class {} }));

import { Prisma } from 'generated/prisma/client';
import { TributeController } from './tribute.controller';

const KEY = 'tribute-key';
const UNTIL = new Date('2026-11-25T00:00:00Z');

/** Вебхук покупки с верной подписью. */
function purchase() {
  const raw = Buffer.from(
    JSON.stringify({
      name: 'new_digital_product',
      payload: {
        telegram_user_id: 123,
        purchase_id: 555,
        amount: 199,
        currency: 'rub',
      },
    }),
  );
  const sig = createHmac('sha256', KEY).update(raw).digest('hex');
  return { req: { rawBody: raw } as never, sig };
}

function setup(opts: { duplicate?: boolean; grantFails?: boolean } = {}) {
  const tx = {
    proPayment: {
      create: jest.fn(() =>
        opts.duplicate
          ? Promise.reject(
              new (
                Prisma.PrismaClientKnownRequestError as unknown as new (
                  m: string,
                  o: { code: string },
                ) => Error
              )('unique', { code: 'P2002' }),
            )
          : Promise.resolve({}),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const pro = {
    grantChat: jest.fn(() =>
      opts.grantFails
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({ userId: 'u1', until: UNTIL }),
    ),
  };
  const bot = { send: jest.fn().mockResolvedValue(true) };
  const monitor = { alert: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (k: string) => (k === 'TRIBUTE_API_KEY' ? KEY : undefined),
  };
  const controller = new TributeController(
    config as never,
    prisma as never,
    pro as never,
    bot as never,
    monitor as never,
  );
  return { controller, tx, pro, bot, monitor };
}

describe('TributeController: оплата одной транзакцией', () => {
  it('новая оплата: запись платежа и выдача Pro — в одной транзакции', async () => {
    const { controller, tx, pro, bot } = setup();
    const { req, sig } = purchase();
    await expect(controller.webhook(req, sig)).resolves.toEqual({ ok: true });
    expect(tx.proPayment.create.mock.calls[0]).toMatchObject([
      { data: { id: 'product:555' } },
    ]);
    // Pro выдаётся через тот же клиент транзакции
    expect(pro.grantChat).toHaveBeenCalledWith(123n, expect.any(Number), tx);
    expect(tx.proPayment.update).toHaveBeenCalledWith({
      where: { id: 'product:555' },
      data: { userId: 'u1' },
    });
    expect(bot.send).toHaveBeenCalledTimes(1);
  });

  it('повтор вебхука: ключ уже есть — отбрасываем, Pro второй раз не выдаём', async () => {
    const { controller, pro, bot } = setup({ duplicate: true });
    const { req, sig } = purchase();
    await expect(controller.webhook(req, sig)).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(pro.grantChat).not.toHaveBeenCalled();
    expect(bot.send).not.toHaveBeenCalled();
  });

  it('сбой при выдаче: ошибка наружу (транзакция откатит запись, Tribute повторит) и тревога', async () => {
    const { controller, bot, monitor } = setup({ grantFails: true });
    const { req, sig } = purchase();
    await expect(controller.webhook(req, sig)).rejects.toThrow('db down');
    expect(monitor.alert).toHaveBeenCalledWith(
      'tribute:error',
      expect.any(String),
    );
    expect(bot.send).not.toHaveBeenCalled();
  });
});
