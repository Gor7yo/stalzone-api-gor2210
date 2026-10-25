// Отзывы: правила и тексты без зависимостей (тесты).
import { escapeHtml } from './format';

/** Один отзыв на Telegram за столько. */
export const REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;
export const REVIEW_TEXT = { min: 10, max: 500 } as const;
export const REVIEW_NICK = { min: 2, max: 32 } as const;

/** Пробелы и переносы — по-человечески: без пустых строк подряд и пробелов по краям. */
export const cleanText = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const cleanNick = (s: string) => s.replace(/\s+/g, ' ').trim();

export const stars = (rating: number) =>
  '★'.repeat(rating) + '☆'.repeat(5 - rating);

/** Когда можно оставить следующий отзыв; null — уже можно. */
export function nextReviewAt(
  lastAt: Date | null | undefined,
  now = Date.now(),
) {
  if (!lastAt) return null;
  const next = lastAt.getTime() + REVIEW_EVERY_MS;
  return next > now ? new Date(next) : null;
}

export interface ReviewView {
  id: number;
  nick: string;
  rating: number;
  text: string;
}

/** Карточка для модерации админу. */
export const moderationText = (r: ReviewView, login: string) =>
  [
    `📝 <b>Новый отзыв #${r.id}</b>`,
    `${stars(r.rating)} · <b>${escapeHtml(r.nick)}</b>`,
    '',
    escapeHtml(r.text),
    '',
    `<i>Аккаунт EXBO: ${escapeHtml(login)}</i>`,
  ].join('\n');

/** Пост в канал отзывов. */
export const channelText = (r: ReviewView, site: string) =>
  [
    `${stars(r.rating)}`,
    `<b>${escapeHtml(r.nick)}</b>`,
    '',
    escapeHtml(r.text),
    '',
    `<a href="${site}/reviews">Все отзывы о STALZONE INFO</a>`,
  ].join('\n');
