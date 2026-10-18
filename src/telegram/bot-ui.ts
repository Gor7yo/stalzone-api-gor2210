import { escapeHtml } from './format';

/**
 * Экран бота: описывается один раз, рисуется двумя способами —
 * rich-сообщением (Bot API 10.1+: заголовки, таблицы, картинки) и обычным HTML,
 * если rich-сообщения выключены или Telegram их не принял.
 *
 * Текст в блоках — уже готовый inline-HTML (<b>, <i>, <a>, <code>):
 * пользовательские строки экранирует тот, кто строит экран (esc()).
 */
export type Block =
  | { type: 'banner'; src: string }
  | { type: 'h'; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; head?: string[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'footer'; text: string };

/** Цвет кнопки (Bot API 9.4): primary - синяя, success - зелёная, danger - красная. */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export type Button = { text: string; style?: ButtonStyle } & (
  { data: string } | { url: string } | { webApp: string }
);

export interface Screen {
  blocks: Block[];
  buttons?: Button[][];
}

export const esc = escapeHtml;
const attr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

/** Rich HTML: https://core.telegram.org/bots/api#rich-html-style */
export function toRichHtml(screen: Screen) {
  return screen.blocks
    .map((b) => {
      switch (b.type) {
        case 'banner':
          return `<img src="${attr(b.src)}"/>`;
        case 'h':
          return `<h3>${b.text}</h3>`;
        case 'p':
          return `<p>${b.text}</p>`;
        case 'list':
          return `<ul>${b.items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
        case 'table': {
          const head = b.head
            ? `<tr>${b.head.map((c) => `<th>${c}</th>`).join('')}</tr>`
            : '';
          const rows = b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('');
          return `<table bordered striped compact>${head}${rows}</table>`;
        }
        case 'quote':
          return `<blockquote>${b.text}</blockquote>`;
        case 'footer':
          return `<footer>${b.text}</footer>`;
      }
    })
    .join('');
}

/**
 * Обычный HTML Telegram (для старых клиентов и запасной вариант).
 * Баннер — превью ссылки над текстом, таблица — строки «ячейка · ячейка».
 */
export function toLegacy(screen: Screen) {
  const banner = screen.blocks.find((b) => b.type === 'banner');
  const parts = screen.blocks.flatMap((b) => {
    switch (b.type) {
      case 'banner':
        return [];
      case 'h':
        return [`<b>${b.text}</b>`];
      case 'p':
        return [b.text];
      case 'list':
        return [b.items.map((i) => `• ${i}`).join('\n')];
      case 'table':
        return [
          b.rows
            .map((r) =>
              b.head && r.length === 2
                ? `${r[0]}: ${r[1]}`
                : r.filter(Boolean).join(' · '),
            )
            .join('\n'),
        ];
      case 'quote':
        return [`<blockquote>${b.text}</blockquote>`];
      case 'footer':
        return [`<i>${b.text}</i>`];
    }
  });
  return { html: parts.join('\n\n'), banner: banner?.src };
}

/** Кнопки → inline_keyboard. */
export function toKeyboard(buttons: Button[][] = []) {
  return buttons.map((row) =>
    row.map((b) => ({
      text: b.text,
      ...(b.style && { style: b.style }),
      ...('data' in b
        ? { callback_data: b.data }
        : 'url' in b
          ? { url: b.url }
          : { web_app: { url: b.webApp } }),
    })),
  );
}
