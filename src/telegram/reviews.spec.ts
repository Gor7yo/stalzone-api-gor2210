import {
  channelText,
  cleanNick,
  cleanText,
  moderationText,
  nextReviewAt,
  stars,
} from './reviews';

const DAY = 24 * 60 * 60_000;

describe('отзывы', () => {
  it('раз в неделю: следующий — через 7 дней после прошлого', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(nextReviewAt(null, now)).toBeNull();
    expect(nextReviewAt(new Date(now - 8 * DAY), now)).toBeNull();
    expect(nextReviewAt(new Date(now - 2 * DAY), now)?.toISOString()).toBe(
      new Date(now + 5 * DAY).toISOString(),
    );
  });

  it('текст и ник без лишних пробелов и пустых строк', () => {
    expect(cleanText('  Отличный   сайт\r\n\r\n\r\n\r\nСпасибо  ')).toBe(
      'Отличный сайт\n\nСпасибо',
    );
    expect(cleanNick('  Bandit   Ivan ')).toBe('Bandit Ivan');
  });

  it('звёзды и HTML экранируется (ник и текст — от пользователя)', () => {
    expect(stars(4)).toBe('★★★★☆');
    const r = { id: 7, nick: '<b>x</b>', rating: 5, text: 'a & b' };
    expect(moderationText(r, 'login')).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(channelText(r, 'https://site')).toContain('a &amp; b');
    expect(channelText(r, 'https://site')).toContain('https://site/reviews');
  });
});
