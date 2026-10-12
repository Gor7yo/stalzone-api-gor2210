import { createHmac, timingSafeEqual } from 'node:crypto';

/** Конверт вебхука Tribute (https://tribute.tg/api/v1/openapi/ru). */
export interface TributeWebhook {
  name: string;
  created_at?: string;
  sent_at?: string;
  payload?: Record<string, unknown>;
}

/** Сколько дней Pro даёт разовая покупка цифрового товара. */
export const PRODUCT_DAYS = 30;

/**
 * trbt-signature — HMAC-SHA256 тела запроса ключом API. Кодировка в документации
 * не указана, поэтому принимаем и hex, и base64.
 */
export function verifyTributeSignature(
  raw: Buffer,
  signature: string | undefined,
  apiKey: string,
): boolean {
  if (!signature || !apiKey) return false;
  const mac = createHmac('sha256', apiKey).update(raw).digest();
  const sig = signature.trim();
  for (const candidate of [
    Buffer.from(sig, 'hex'),
    Buffer.from(sig, 'base64'),
  ]) {
    if (candidate.length === mac.length && timingSafeEqual(candidate, mac))
      return true;
  }
  return false;
}

export type TributeAction =
  | { kind: 'grant'; key: string; chatId: bigint; days: number }
  | { kind: 'extend'; key: string; chatId: bigint; until: Date }
  | { kind: 'ignore'; reason: string };

const num = (v: unknown) =>
  typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))
    ? String(v)
    : null;

/**
 * Что сделать по событию. productId/subscriptionId из env — чтобы чужие товары
 * того же автора не выдавали Pro; пустые — принимаем любые.
 */
export function tributeAction(
  hook: TributeWebhook,
  filter: { productId?: string; subscriptionId?: string },
): TributeAction {
  const p = hook.payload ?? {};
  const tg = num(p.telegram_user_id);
  if (!tg) return { kind: 'ignore', reason: 'нет telegram_user_id' };
  const chatId = BigInt(tg);

  switch (hook.name) {
    case 'new_digital_product': {
      const productId = num(p.product_id);
      const purchaseId = num(p.purchase_id);
      if (filter.productId && productId !== filter.productId)
        return { kind: 'ignore', reason: `чужой товар ${productId}` };
      if (!purchaseId) return { kind: 'ignore', reason: 'нет purchase_id' };
      return {
        kind: 'grant',
        key: `product:${purchaseId}`,
        chatId,
        days: PRODUCT_DAYS,
      };
    }
    case 'new_subscription':
    case 'renewed_subscription': {
      const subId = num(p.subscription_id);
      if (filter.subscriptionId && subId !== filter.subscriptionId)
        return { kind: 'ignore', reason: `чужая подписка ${subId}` };
      const until = new Date(String(p.expires_at));
      if (Number.isNaN(until.getTime()))
        return { kind: 'ignore', reason: 'нет expires_at' };
      return {
        kind: 'extend',
        key: `sub:${subId}:${chatId}:${until.toISOString()}`,
        chatId,
        until,
      };
    }
    default:
      // cancelled_subscription и прочее: оплаченный срок просто дотекает
      return { kind: 'ignore', reason: hook.name };
  }
}
