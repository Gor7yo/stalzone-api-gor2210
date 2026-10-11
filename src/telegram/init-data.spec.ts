import { createHmac } from 'node:crypto';
import { verifyInitData } from './init-data';

const TOKEN = '123456:TEST-token-for-unit-tests-only-abcdef';

function sign(fields: Record<string, string>, token = TOKEN) {
  const check = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = 1_800_000_000;
const user = JSON.stringify({ id: 42, first_name: 'Сталкер' });

describe('verifyInitData', () => {
  it('принимает корректно подписанные данные', () => {
    const data = sign({ auth_date: String(now - 60), query_id: 'q', user });
    expect(verifyInitData(data, TOKEN, now)).toMatchObject({ id: 42 });
  });

  it('отклоняет подпись чужим токеном', () => {
    const data = sign(
      { auth_date: String(now), user },
      '1:other-token-xxxxxxxxxxxxxxxxxxxxxxx',
    );
    expect(verifyInitData(data, TOKEN, now)).toBeNull();
  });

  it('отклоняет подмену пользователя', () => {
    const data = sign({ auth_date: String(now), user }).replace(
      encodeURIComponent('"id":42'),
      encodeURIComponent('"id":43'),
    );
    expect(verifyInitData(data, TOKEN, now)).toBeNull();
  });

  it('отклоняет устаревшие данные', () => {
    const data = sign({ auth_date: String(now - 2 * 86_400), user });
    expect(verifyInitData(data, TOKEN, now)).toBeNull();
  });

  it('отклоняет мусор', () => {
    expect(verifyInitData('', TOKEN, now)).toBeNull();
    expect(verifyInitData('hash=zz&user=1', TOKEN, now)).toBeNull();
  });
});
