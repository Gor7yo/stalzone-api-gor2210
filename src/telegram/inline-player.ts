import type { Region } from 'src/api/dto/queries.dto';
import type { InlinePlayer } from 'src/players/players.service';
import type { Archetype, Metric, Tier } from 'src/players/rating';
import { escapeHtml, REGION_LABEL } from './format';

/** Архетипы — как на сайте (features/archetypes.ts). */
const ARCHETYPES: Record<Archetype, { emoji: string; ru: string }> = {
  kamikaze: { emoji: '💣', ru: 'Камикадзе' },
  tourist: { emoji: '🎒', ru: 'Турист' },
  allrounder: { emoji: '🧭', ru: 'Универсал' },
  pvp: { emoji: '⚔️', ru: 'ПвП-машина' },
  stormer: { emoji: '💥', ru: 'Штурмовик' },
  sniper: { emoji: '🎯', ru: 'Снайпер' },
  survivor: { emoji: '🛡️', ru: 'Выживальщик' },
  hunter: { emoji: '🐺', ru: 'Охотник на мутантов' },
  veteran: { emoji: '🎖️', ru: 'Ветеран' },
};

/** Медаль уровня карточки. */
const TIER: Record<Tier, string> = {
  bronze: '🥉',
  silver: '🥈',
  gold: '🥇',
  neon: '💎',
};

/** «Лучше, чем у X%» — какие показатели годятся для хвастовства и как называются. */
const BRAG: Partial<Record<Metric, string>> = {
  kd: 'K/D',
  kills: 'Убийств',
  accuracy: 'Точность',
  headshots: 'Хедшоты',
  survival: 'Выживаемость',
  mutants: 'Мутантов',
  played: 'Часов в игре',
  damage: 'Урон',
};

const int = (n: number) => Math.round(n).toLocaleString('ru-RU');

/** Самый сильный показатель: «Хедшоты лучше, чем у 98% игроков». */
function brag(p: InlinePlayer) {
  if (p.status !== 'ready') return null;
  const best = (Object.entries(p.percentiles) as [Metric, number][])
    .filter(([m]) => BRAG[m])
    .sort((a, b) => b[1] - a[1])[0];
  return best
    ? `${BRAG[best[0]]} лучше, чем у ${Math.round(best[1])}% игроков`
    : null;
}

/** Строка в списке результатов под заголовком. */
export function describePlayer(p: InlinePlayer, region: Region) {
  const parts = [
    p.status === 'ready' ? ARCHETYPES[p.archetype].ru : null,
    `K/D ${p.basic.kd.toFixed(2)}`,
    `${int(p.basic.kills)} убийств`,
    REGION_LABEL[region],
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Заголовок в списке результатов: «🎯 Ник · 70🥈». */
export function playerTitle(p: InlinePlayer) {
  if (p.status !== 'ready') return `🃏 ${p.username}`;
  return `${ARCHETYPES[p.archetype].emoji} ${p.username} · ${p.overall}${TIER[p.tier]}`;
}

/** Сообщение в чат. Над ним Telegram покажет превью ссылки — карточку игрока с сайта. */
export function playerCard(
  p: InlinePlayer,
  region: Region,
  url: string,
  botName: string,
) {
  const lines = [
    `🃏 <b>${escapeHtml(p.username)}</b> · ${REGION_LABEL[region]}`,
  ];
  if (p.status === 'ready') {
    const a = ARCHETYPES[p.archetype];
    lines.push(
      `${a.emoji} <b>${a.ru}</b> · рейтинг <b>${p.overall}</b> ${TIER[p.tier]}`,
    );
  } else if (p.status === 'newbie') {
    lines.push('🌱 Новичок - карточка появится после 5 часов в игре');
  }
  lines.push(
    `⚔️ K/D <b>${p.basic.kd.toFixed(2)}</b> · убийств ${int(p.basic.kills)} · ⏱ ${int(p.basic.hours)} ч`,
  );
  const top = brag(p);
  if (top) lines.push(`🏆 ${top}`);
  lines.push(
    '',
    `<a href="${url}">Карточка и прогресс на STALZONE INFO</a>`,
    `<i>Игроки и цены в любом чате - @${botName}</i>`,
  );
  return lines.join('\n');
}

/** Результат inline-запроса: статья с крупным превью карточки над текстом. */
export function playerResult(
  p: InlinePlayer,
  region: Region,
  site: string,
  botName: string,
) {
  const url = `${site}/character/${region}/${encodeURIComponent(p.username)}`;
  return {
    type: 'article',
    id: `p:${region}:${p.username}`.slice(0, 64),
    title: playerTitle(p),
    description: describePlayer(p, region),
    input_message_content: {
      message_text: playerCard(p, region, url, botName),
      parse_mode: 'HTML',
      // превью ссылки — картинка профиля (карточка FIFA), крупно и над текстом
      link_preview_options: {
        url,
        prefer_large_media: true,
        show_above_text: true,
      },
    },
    reply_markup: {
      inline_keyboard: [
        [{ text: '🃏 Открыть карточку', url }],
        [
          {
            text: '🔎 Найти другого игрока',
            switch_inline_query_current_chat: '',
          },
        ],
      ],
    },
  };
}
