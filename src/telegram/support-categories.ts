/** Темы обращений: подпись, значок и цвет темы в группе (допустимые цвета createForumTopic). */
export const CATEGORIES = {
  question: { label: 'Вопрос', icon: '❓', color: 0x6fb9f0 },
  payment: { label: 'Оплата и Pro', icon: '💳', color: 0xffd67e },
  bug: { label: 'Ошибка на сайте', icon: '🐞', color: 0xfb6f5f },
  idea: { label: 'Идея', icon: '💡', color: 0x8eee98 },
} as const;
export type Category = keyof typeof CATEGORIES;
export const isCategory = (s: string | undefined): s is Category =>
  !!s && Object.hasOwn(CATEGORIES, s);

/** Открытых обращений у одного человека одновременно. */
export const MAX_OPEN = 3;
