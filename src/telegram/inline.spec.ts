// регионы берутся из DTO с декораторами class-validator
import 'reflect-metadata';
import { ITEM_INFO } from 'src/collector/item-info';
import { card, describe as line } from './inline.service';
import { parseQuery, searchItems } from './inline-search';

jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }));
// inline.service тянет сервис игроков, а он — сгенерированный клиент Prisma
jest.mock('generated/prisma/client', () => ({ Prisma: {} }), { virtual: true });

const nameOf = (id: string) => ITEM_INFO[id][0];

describe('inline-поиск', () => {
  it('регион префиксом, по умолчанию RU', () => {
    expect(parseQuery('комета')).toEqual({ region: 'ru', text: 'комета' });
    expect(parseQuery('EU  Комета ')).toEqual({ region: 'eu', text: 'комета' });
    expect(parseQuery('')).toEqual({ region: 'ru', text: '' });
  });

  it('находит по-русски, в английской раскладке и «ё» как «е»', () => {
    const ru = searchItems('комета');
    expect(ru.length).toBeGreaterThan(0);
    expect(nameOf(ru[0]).toLowerCase()).toContain('комета');
    expect(searchItems('rjvtnf')[0]).toBe(ru[0]);
  });

  it('совпадение с начала названия — выше, чем внутри', () => {
    const ids = searchItems('ком', 20);
    const starts = ids.findIndex(
      (id) => !nameOf(id).toLowerCase().startsWith('ком'),
    );
    const after = ids
      .slice(starts)
      .some((id) => nameOf(id).toLowerCase().startsWith('ком'));
    expect(after).toBe(false);
  });

  it('слишком короткий запрос — пусто', () => {
    expect(searchItems('к')).toEqual([]);
  });
});

describe('inline-карточка', () => {
  const s = {
    itemId: 'x',
    best: 1_200_000,
    lots: 95,
    deals: 37,
    median: 1_300_000,
    change: 4.5,
  };

  it('цена, сделки и изменение; название экранируется', () => {
    const text = card('<Комета>', 'ru', s, 'stalzoneinfo_bot');
    expect(text).toContain('&lt;Комета&gt;');
    expect(text).toContain('от 1,2кк');
    expect(text).toContain('+4,5 %');
    expect(text).toContain('@stalzoneinfo_bot');
  });

  it('без лотов и сделок — честно «лотов нет»', () => {
    const none = {
      ...s,
      best: null,
      lots: 0,
      deals: 0,
      median: null,
      change: null,
    };
    expect(line(none)).toBe('лотов нет');
    expect(card('Комета', 'eu', none, 'bot')).toContain('Сейчас лотов нет');
  });
});
