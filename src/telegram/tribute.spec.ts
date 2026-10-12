import { createHmac } from 'node:crypto';
import { tributeAction, verifyTributeSignature } from './tribute';

describe('tribute', () => {
  const key = 'secret';
  const body = Buffer.from('{"name":"new_digital_product"}');
  const digest = createHmac('sha256', key).update(body).digest();

  it('принимает подпись в hex и base64, отвергает чужую', () => {
    expect(verifyTributeSignature(body, digest.toString('hex'), key)).toBe(
      true,
    );
    expect(verifyTributeSignature(body, digest.toString('base64'), key)).toBe(
      true,
    );
    expect(verifyTributeSignature(body, 'deadbeef', key)).toBe(false);
    expect(verifyTributeSignature(body, undefined, key)).toBe(false);
    expect(verifyTributeSignature(body, digest.toString('hex'), '')).toBe(
      false,
    );
  });

  it('товар → 30 дней, чужой товар — пропуск', () => {
    const hook = {
      name: 'new_digital_product',
      payload: { telegram_user_id: 42, product_id: 7, purchase_id: 100 },
    };
    expect(tributeAction(hook, { productId: '7' })).toEqual({
      kind: 'grant',
      key: 'product:100',
      chatId: 42n,
      days: 30,
    });
    expect(tributeAction(hook, { productId: '8' }).kind).toBe('ignore');
  });

  it('подписка → до expires_at, отмена — пропуск', () => {
    const payload = {
      telegram_user_id: 42,
      subscription_id: 5,
      expires_at: '2026-11-12T00:00:00Z',
    };
    const a = tributeAction({ name: 'renewed_subscription', payload }, {});
    expect(a.kind).toBe('extend');
    expect(a.kind === 'extend' && a.until.toISOString()).toBe(
      '2026-11-12T00:00:00.000Z',
    );
    expect(
      tributeAction({ name: 'cancelled_subscription', payload }, {}).kind,
    ).toBe('ignore');
  });
});
