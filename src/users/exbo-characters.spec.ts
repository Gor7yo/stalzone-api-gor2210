import { parseCharacters } from './exbo-characters';

describe('parseCharacters', () => {
  it('разбирает формат EXBO: information + clan', () => {
    const data = [
      {
        information: {
          id: 'u-1',
          name: 'gor2210',
          creationTime: '2023-01-01T00:00:00Z',
        },
        clan: {
          info: { id: 'c-1', name: 'Клан', tag: 'TAG', level: 5 },
          member: {
            name: 'gor2210',
            rank: 'LEADER',
            joinTime: '2023-02-01T00:00:00Z',
          },
        },
      },
      { information: { id: 'u-2', name: 'alt' } },
    ];
    expect(parseCharacters('ru', data)).toEqual([
      {
        region: 'ru',
        name: 'gor2210',
        id: 'u-1',
        createdAt: '2023-01-01T00:00:00Z',
        clan: { id: 'c-1', name: 'Клан', tag: 'TAG', rank: 'LEADER' },
      },
      { region: 'ru', name: 'alt', id: 'u-2', createdAt: null, clan: null },
    ]);
  });

  it('принимает плоский формат и обёртку { characters }', () => {
    expect(
      parseCharacters('eu', { characters: [{ id: 'x', name: 'Flat' }] }),
    ).toEqual([
      { region: 'eu', name: 'Flat', id: 'x', createdAt: null, clan: null },
    ]);
  });

  it('пропускает мусор и пустой ответ', () => {
    expect(parseCharacters('na', [null, 1, {}, { information: {} }])).toEqual(
      [],
    );
    expect(parseCharacters('na', null)).toEqual([]);
    expect(parseCharacters('na', 'oops')).toEqual([]);
  });
});
