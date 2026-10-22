import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { type Button, esc, type Screen } from './bot-ui';
import { alertTitle, formatShort, REGION_LABEL } from './format';
import { CATEGORIES, type Category, MAX_OPEN } from './support-categories';

/**
 * Экраны меню бота — чистые функции от данных. Навигация — callback_data:
 * menu, alerts, em, pro, sup, sup:new:<тема>, sup:t:<id>, sup:reply:<id>…
 */

export const PRO_BUY_URL = 'https://web.tribute.tg/p/GO6';
const PRICE = '199 ₽ / 30 дней';

const dateRu = (d: Date | string) =>
  new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });

const back = (to = 'menu', text = '← Назад'): Button[] => [{ text, data: to }];

export interface MenuData {
  site: string;
  name?: string;
  login?: string;
  proUntil?: Date | null;
  priceAlerts: number;
  flipRegions: string[];
  emission: Region[];
  openTickets: number;
}

export function mainMenu(d: MenuData): Screen {
  const pro =
    d.proUntil && d.proUntil > new Date()
      ? `⭐ до ${dateRu(d.proUntil)}`
      : 'нет';
  const alerts = [
    d.priceAlerts ? `🔔 ${d.priceAlerts}` : null,
    d.flipRegions.length ? `💰 ${d.flipRegions.join(', ')}` : null,
    d.emission.length
      ? `☢️ ${d.emission.map((r) => REGION_LABEL[r]).join(', ')}`
      : null,
  ].filter(Boolean);
  return {
    blocks: [
      { type: 'banner', src: `${d.site}/opengraph-image.png` },
      { type: 'h', text: `Привет${d.name ? `, ${esc(d.name)}` : ''}! 👋` },
      {
        type: 'p',
        text: 'Это STALZONE INFO - рынок STALZONE в Telegram. Цены и флиппер - в приложении, уведомления - здесь.',
      },
      {
        type: 'table',
        head: ['', ''],
        rows: [
          ['Аккаунт', d.login ? `<code>${esc(d.login)}</code>` : 'не привязан'],
          ['Pro', pro],
          ['Уведомления', alerts.length ? alerts.join(' · ') : 'выключены'],
          ...(d.openTickets
            ? [['Поддержка', `открытых обращений: ${d.openTickets}`]]
            : []),
        ],
      },
    ],
    buttons: [
      [{ text: '🌐 Открыть STALZONE INFO', webApp: d.site, style: 'primary' }],
      [
        { text: '🔔 Алерты', data: 'alerts' },
        { text: '☢️ Выброс', data: 'em' },
      ],
      [
        { text: '⭐ Pro', data: 'pro' },
        { text: '🛟 Поддержка', data: 'sup' },
      ],
      [{ text: '📖 Как пользоваться', url: `${d.site}/guide` }],
    ],
  };
}

type PriceAlertRow = Parameters<typeof alertTitle>[0] & {
  id: string;
  region: string;
  maxPrice: number;
};

export function alertsScreen(d: {
  site: string;
  price: PriceAlertRow[];
  flip: { region: string; minProfit: number }[];
  limit: number;
}): Screen {
  const region = (r: string) => REGION_LABEL[r as Region] ?? r;
  const blocks: Screen['blocks'] = [{ type: 'h', text: '🔔 Мои алерты' }];
  if (d.price.length) {
    blocks.push({
      type: 'table',
      head: ['#', 'Предмет', 'Регион', 'Цена до'],
      rows: d.price.map((a, i) => [
        String(i + 1),
        esc(alertTitle(a)),
        region(a.region),
        formatShort(a.maxPrice),
      ]),
    });
  } else {
    blocks.push({
      type: 'p',
      text: 'Алертов цен пока нет. Откройте предмет в приложении и нажмите 🔔 - пришлю, когда появится лот дешевле вашей цены.',
    });
  }
  blocks.push({
    type: 'p',
    text: d.flip.length
      ? `💰 Флип-алерты: ${d.flip.map((f) => `${region(f.region)} от ${formatShort(f.minProfit)}`).join(', ')}`
      : '💰 Флип-алерты выключены - включаются во «Флиппере» (Pro).',
  });
  blocks.push({
    type: 'footer',
    text: `Алертов цен: ${d.price.length} из ${d.limit}. Кнопка ✖ удаляет алерт.`,
  });

  const del: Button[] = d.price.map((a, i) => ({
    text: `✖ ${i + 1}`,
    data: `del:${a.id}`,
  }));
  const rows: Button[][] = [];
  for (let i = 0; i < del.length; i += 5) rows.push(del.slice(i, i + 5));
  for (const f of d.flip) {
    rows.push([
      {
        text: `✖ Флипы ${region(f.region)}`,
        data: `fdel:${f.region}`,
        style: 'danger',
      },
    ]);
  }
  rows.push([
    { text: '➕ Новый алерт', webApp: `${d.site}/auction`, style: 'primary' },
  ]);
  rows.push(back());
  return { blocks, buttons: rows };
}

export function emissionScreen(enabled: Region[]): Screen {
  return {
    blocks: [
      { type: 'h', text: '☢️ Уведомления о выбросе' },
      {
        type: 'p',
        text: 'Отметьте регионы - напишу, как только начнётся выброс. Нажмите ещё раз, чтобы выключить.',
      },
    ],
    buttons: [
      REGIONS.map((r) => ({
        text: `${enabled.includes(r) ? '✅' : '▫️'} ${REGION_LABEL[r]}`,
        data: `em:${r}`,
        ...(enabled.includes(r) && { style: 'success' as const }),
      })),
      back(),
    ],
  };
}

export interface ProData {
  site: string;
  linked: boolean;
  pro: boolean;
  proUntil: string | null;
  trialAvailable: boolean;
  /** реферальная ссылка — только для привязанного аккаунта */
  referral?: {
    link: string;
    invited: number;
    rewardedMonth: number;
    monthLimit: number;
    bonusDays: number;
    trialDays: number;
    minHours: number;
  };
}

/** Кнопка «Поделиться»: Telegram откроет выбор чата с готовым текстом и ссылкой. */
const shareUrl = (link: string, text: string) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;

export function proScreen(d: ProData): Screen {
  const blocks: Screen['blocks'] = [
    { type: 'h', text: d.pro ? '⭐ Pro активен' : '⭐ STALZONE INFO Pro' },
  ];
  if (d.pro && d.proUntil) {
    blocks.push({
      type: 'p',
      text: `Действует до <b>${dateRu(d.proUntil)}</b>.`,
    });
  }
  blocks.push({
    type: 'list',
    items: [
      '💰 <b>Флиппер</b> и флип-алерты - выгодные лоты сразу в Telegram',
      '🔔 <b>20 ценовых алертов</b> с точным качеством и заточкой',
      '📈 Графики цен и помощник продажи',
      '🎯 Фильтры лотов по качеству и заточке',
    ],
  });
  const buttons: Button[][] = [];
  if (!d.linked) {
    blocks.push({
      type: 'quote',
      text: 'Pro живёт на аккаунте EXBO. Войдите на сайте и привяжите этот Telegram - тогда пробный период и оплата заработают здесь.',
    });
    buttons.push([
      {
        text: '🔗 Войти и привязать',
        webApp: `${d.site}/account`,
        style: 'primary',
      },
    ]);
  } else if (!d.pro) {
    if (d.trialAvailable) {
      buttons.push([
        { text: '🎁 3 дня бесплатно', data: 'pro:trial', style: 'success' },
      ]);
    }
    buttons.push([
      { text: `💳 Оформить - ${PRICE}`, url: PRO_BUY_URL, style: 'primary' },
    ]);
    blocks.push({
      type: 'footer',
      text: 'Оплата через Tribute картой или Telegram Stars. Данные карты к нам не попадают.',
    });
  } else {
    buttons.push([{ text: `💳 Продлить - ${PRICE}`, url: PRO_BUY_URL }]);
  }
  const r = d.referral;
  if (r) {
    blocks.push(
      { type: 'h', text: '🤝 Пригласи друга' },
      {
        type: 'p',
        text: `Друг получит <b>${r.trialDays} дня Pro</b>, а вы - <b>+${r.bonusDays} день</b> за каждого, кто придёт по ссылке, привяжет Telegram и наиграет ${r.minHours} часов.`,
      },
      {
        type: 'table',
        head: ['', ''],
        rows: [
          ['Ваша ссылка', `<code>${esc(r.link)}</code>`],
          ['Приглашено', String(r.invited)],
          ['Бонусов за 30 дней', `${r.rewardedMonth} из ${r.monthLimit}`],
        ],
      },
    );
    buttons.push([
      {
        text: '📤 Поделиться',
        url: shareUrl(
          r.link,
          `Цены, флиппер и алерты STALZONE в Telegram. По ссылке - ${r.trialDays} дня Pro бесплатно.`,
        ),
        style: 'success',
      },
      { text: '📋 Скопировать', copy: r.link },
    ]);
  }
  buttons.push(back());
  return { blocks, buttons };
}

/** Приветствие по реферальной ссылке: что сделать, чтобы получить пробный. */
export function referralWelcomeScreen(
  site: string,
  inviter: string,
  trialDays: number,
): Screen {
  return {
    blocks: [
      { type: 'banner', src: `${site}/opengraph-image.png` },
      { type: 'h', text: `🎁 Вас пригласил ${esc(inviter)}` },
      {
        type: 'p',
        text: `Вам положено <b>${trialDays} дня Pro бесплатно</b>: флиппер, флип-алерты, 20 ценовых алертов и графики.`,
      },
      {
        type: 'list',
        items: [
          'Откройте STALZONE INFO кнопкой ниже',
          'Войдите через EXBO - пароль вводится только на сайте EXBO',
          'Привяжите этот Telegram - Pro включится сам',
        ],
      },
    ],
    buttons: [
      [
        {
          text: '🔗 Войти и получить Pro',
          webApp: `${site}/account`,
          style: 'success',
        },
      ],
      [{ text: '🏠 Меню', data: 'menu' }],
    ],
  };
}

const STATUS: Record<string, string> = {
  open: '⏳ ждёт ответа',
  answered: '💬 есть ответ',
  closed: '✅ закрыто',
};

export interface TicketRow {
  id: number;
  category: string;
  status: string;
  updatedAt: Date;
}

const catOf = (c: string) => CATEGORIES[c as Category] ?? CATEGORIES.question;

export function supportScreen(d: {
  tickets: TicketRow[];
  enabled: boolean;
}): Screen {
  const open = d.tickets.filter((t) => t.status !== 'closed');
  const blocks: Screen['blocks'] = [
    { type: 'h', text: '🛟 Поддержка' },
    {
      type: 'p',
      text: 'Выберите тему и опишите вопрос - можно приложить скриншот. Отвечает живой человек, ответ придёт в этот чат.',
    },
  ];
  if (d.tickets.length) {
    blocks.push({
      type: 'table',
      head: ['#', 'Тема', 'Статус', 'Обновлено'],
      rows: d.tickets.map((t) => [
        String(t.id),
        `${catOf(t.category).icon} ${catOf(t.category).label}`,
        STATUS[t.status] ?? t.status,
        dateRu(t.updatedAt),
      ]),
    });
  }
  if (!d.enabled) {
    blocks.push({
      type: 'quote',
      text: 'Сейчас поддержка отвечает с задержкой - но обращение не потеряется.',
    });
  }
  const buttons: Button[][] = [];
  if (open.length < MAX_OPEN) {
    const cats = Object.entries(CATEGORIES).map(([key, c]) => ({
      text: `${c.icon} ${c.label}`,
      data: `sup:new:${key}`,
    }));
    buttons.push(cats.slice(0, 2), cats.slice(2));
  } else {
    blocks.push({
      type: 'footer',
      text: `Открыто ${open.length} обращения - это максимум. Дождитесь ответа или закройте одно.`,
    });
  }
  for (const t of d.tickets.slice(0, 6)) {
    buttons.push([
      {
        text: `#${t.id} ${catOf(t.category).icon} ${STATUS[t.status] ?? ''}`,
        data: `sup:t:${t.id}`,
      },
    ]);
  }
  buttons.push(back());
  return { blocks, buttons };
}

export function newTicketScreen(category: Category): Screen {
  const c = CATEGORIES[category];
  const hint: Record<Category, string> = {
    question: 'Что непонятно? Чем подробнее - тем быстрее ответим.',
    payment:
      'Укажите, когда и как платили (карта или Stars). Скриншот оплаты очень поможет.',
    bug: 'Что делали, что ожидали и что случилось? Приложите скриншот и напишите, сайт это или мини-приложение.',
    idea: 'Что добавить или улучшить? Любые идеи приветствуются.',
  };
  return {
    blocks: [
      { type: 'h', text: `${c.icon} ${c.label}` },
      { type: 'p', text: hint[category] },
      {
        type: 'quote',
        text: 'Напишите одним сообщением в этот чат. Можно отправить фото со скриншотом и подписью.',
      },
    ],
    buttons: [[{ text: '✖ Отмена', data: 'sup' }]],
  };
}

export function ticketCreatedScreen(id: number): Screen {
  return {
    blocks: [
      { type: 'h', text: `✅ Обращение #${id} создано` },
      {
        type: 'p',
        text: 'Ответ придёт в этот чат. Если хотите что-то добавить - просто напишите сюда, сообщение попадёт в это обращение.',
      },
    ],
    buttons: [
      [{ text: '🛟 Мои обращения', data: 'sup' }],
      back('menu', '🏠 В меню'),
    ],
  };
}

export function ticketScreen(
  t: TicketRow,
  messages: {
    fromAdmin: boolean;
    text: string | null;
    photo: string | null;
    createdAt: Date;
  }[],
): Screen {
  const c = catOf(t.category);
  const blocks: Screen['blocks'] = [
    { type: 'h', text: `#${t.id} · ${c.icon} ${c.label}` },
    { type: 'p', text: `Статус: ${STATUS[t.status] ?? t.status}` },
  ];
  for (const m of messages.slice(-6)) {
    const who = m.fromAdmin ? '💬 Поддержка' : '👤 Вы';
    const body = [m.text ? esc(m.text) : '', m.photo ? '📎 вложение' : '']
      .filter(Boolean)
      .join('<br>');
    blocks.push({
      type: 'quote',
      text: `<b>${who}</b> · ${dateRu(m.createdAt)}<br>${body}`,
    });
  }
  const buttons: Button[][] =
    t.status === 'closed'
      ? []
      : [
          [
            {
              text: '✍️ Написать',
              data: `sup:reply:${t.id}`,
              style: 'primary',
            },
            {
              text: '✅ Вопрос решён',
              data: `sup:close:${t.id}`,
              style: 'success',
            },
          ],
        ];
  buttons.push(back('sup', '← К обращениям'));
  return { blocks, buttons };
}

export function replyPromptScreen(id: number): Screen {
  return {
    blocks: [
      { type: 'h', text: `✍️ Обращение #${id}` },
      {
        type: 'p',
        text: 'Напишите сообщение в этот чат - можно с фото. Оно уйдёт в поддержку.',
      },
    ],
    buttons: [[{ text: '✖ Отмена', data: `sup:t:${id}` }]],
  };
}
