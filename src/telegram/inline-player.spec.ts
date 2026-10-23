// регионы берутся из DTO с декораторами class-validator
import 'reflect-metadata';

jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import type { InlinePlayer } from 'src/players/players.service';
import {
  describePlayer,
  playerCard,
  playerResult,
  playerTitle,
} from './inline-player';
import { rawNick } from './inline-search';

const basic = { kd: 0.8946, kills: 30594, hours: 3243.2 };

const ready = {
  status: 'ready',
  username: 'Ivan<Kil>',
  population: 3000,
  basic,
  overall: 70,
  tier: 'silver',
  archetype: 'sniper',
  percentiles: {
    kd: 66,
    kills: 55,
    damage: 49,
    accuracy: 58,
    headshots: 98.2,
    streak: 99,
    mutants: 29,
    played: 43,
    survival: 52,
  },
} as unknown as InlinePlayer;

describe('inline: карточка игрока', () => {
  it('ник из запроса — с регистром, без префикса региона', () => {
    expect(rawNick('eu Bandit_Ivan')).toBe('Bandit_Ivan');
    expect(rawNick(' Bandit_Ivan ')).toBe('Bandit_Ivan');
  });

  it('заголовок и строка в списке', () => {
    expect(playerTitle(ready)).toBe('🎯 Ivan<Kil> · 70🥈');
    expect(describePlayer(ready, 'ru')).toBe(
      'Снайпер · K/D 0.89 · 30 594 убийств · RU',
    );
  });

  it('сообщение: архетип, рейтинг, лучшая сторона без «серии», ник экранирован', () => {
    const text = playerCard(ready, 'ru', 'https://x/p', 'bot');
    expect(text).toContain('<b>Ivan&lt;Kil&gt;</b>');
    expect(text).toContain('🎯 <b>Снайпер</b> · рейтинг <b>70</b> 🥈');
    // серия (99%) в хвастовство не идёт — берём хедшоты
    expect(text).toContain('🏆 Хедшоты лучше, чем у 98% игроков');
  });

  it('новичок — без рейтинга, с пояснением', () => {
    const newbie = {
      status: 'newbie',
      username: 'Nub',
      population: 3000,
      basic,
    } as InlinePlayer;
    expect(playerTitle(newbie)).toBe('🃏 Nub');
    expect(playerCard(newbie, 'ru', 'u', 'bot')).toContain('🌱 Новичок');
  });

  it('результат: крупное превью ссылки на профиль над текстом', () => {
    const r = playerResult(ready, 'eu', 'https://site', 'bot');
    expect(r.input_message_content.link_preview_options).toEqual({
      url: 'https://site/character/eu/Ivan%3CKil%3E',
      prefer_large_media: true,
      show_above_text: true,
    });
    expect(r.id.length).toBeLessThanOrEqual(64);
  });
});
