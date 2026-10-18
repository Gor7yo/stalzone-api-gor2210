// регионы берутся из DTO с декораторами class-validator
import 'reflect-metadata';
import {
  alertsScreen,
  emissionScreen,
  proScreen,
  supportScreen,
  ticketScreen,
} from './bot-screens';
import { type Screen, toKeyboard, toLegacy, toRichHtml } from './bot-ui';

const site = 'https://stalzone-info.ru';
const datas = (s: Screen) =>
  (s.buttons ?? []).flat().map((b) => ('data' in b ? b.data : null));

describe('bot-ui', () => {
  const screen: Screen = {
    blocks: [
      { type: 'banner', src: 'https://x.ru/a.png?b=1&c="2"' },
      { type: 'h', text: 'Заголовок' },
      { type: 'table', head: ['', ''], rows: [['Pro', 'нет']] },
    ],
    buttons: [[{ text: 'Ок', data: 'menu', style: 'success' }]],
  };

  it('rich HTML: картинка, заголовок и таблица, кавычки в атрибуте экранированы', () => {
    const html = toRichHtml(screen);
    expect(html).toContain(
      '<img src="https://x.ru/a.png?b=1&amp;c=&quot;2&quot;"/>',
    );
    expect(html).toContain('<h3>Заголовок</h3>');
    expect(html).toContain('<td>Pro</td><td>нет</td>');
  });

  it('обычный HTML: баннер уходит в превью ссылки, таблица — «ключ: значение»', () => {
    const { html, banner } = toLegacy(screen);
    expect(banner).toBe('https://x.ru/a.png?b=1&c="2"');
    expect(html).toBe('<b>Заголовок</b>\n\nPro: нет');
  });

  it('кнопки: цвет и тип', () => {
    expect(
      toKeyboard([
        [
          { text: 'a', data: 'x', style: 'danger' },
          { text: 'b', webApp: site },
        ],
      ]),
    ).toEqual([
      [
        { text: 'a', style: 'danger', callback_data: 'x' },
        { text: 'b', web_app: { url: site } },
      ],
    ]);
  });
});

describe('экраны бота', () => {
  it('название предмета в алертах экранируется', () => {
    const s = alertsScreen({
      site,
      price: [
        {
          id: 'a1',
          region: 'ru',
          maxPrice: 1_500_000,
          itemName: 'Ствол <script>',
          quality: null,
          upgrade: null,
        },
      ],
      flip: [],
      limit: 1,
    });
    const html = toRichHtml(s);
    expect(html).toContain('Ствол &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(datas(s)).toContain('del:a1');
  });

  it('выброс: включённые регионы зелёные', () => {
    const s = emissionScreen(['ru']);
    const ru = s.buttons![0].find((b) => b.text.includes('RU'))!;
    const eu = s.buttons![0].find((b) => b.text.includes('EU'))!;
    expect(ru.style).toBe('success');
    expect(eu.style).toBeUndefined();
  });

  it('Pro: без аккаунта — привязка, с аккаунтом — пробный и оплата', () => {
    const base = { site, pro: false, proUntil: null, trialAvailable: true };
    expect(datas(proScreen({ ...base, linked: false }))).not.toContain(
      'pro:trial',
    );
    expect(datas(proScreen({ ...base, linked: true }))).toContain('pro:trial');
    expect(
      datas(proScreen({ ...base, linked: true, trialAvailable: false })),
    ).not.toContain('pro:trial');
  });

  it('поддержка: при 3 открытых обращениях новые темы не предлагаются', () => {
    const t = (id: number, status = 'open') => ({
      id,
      category: 'bug',
      status,
      updatedAt: new Date('2026-10-18'),
    });
    expect(datas(supportScreen({ tickets: [t(1)], enabled: true }))).toContain(
      'sup:new:bug',
    );
    const full = supportScreen({ tickets: [t(1), t(2), t(3)], enabled: true });
    expect(datas(full).some((d) => d?.startsWith('sup:new'))).toBe(false);
    expect(datas(full)).toContain('sup:t:3');
  });

  it('карточка обращения: текст экранируется, у закрытого нет кнопки «Написать»', () => {
    const ticket = {
      id: 7,
      category: 'question',
      status: 'closed',
      updatedAt: new Date(),
    };
    const s = ticketScreen(ticket, [
      {
        fromAdmin: false,
        text: '<b>hi</b>',
        photo: null,
        createdAt: new Date(),
      },
    ]);
    expect(toRichHtml(s)).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(datas(s)).not.toContain('sup:reply:7');
  });
});
