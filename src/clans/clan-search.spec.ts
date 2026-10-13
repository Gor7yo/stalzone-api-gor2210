import { escapeLike, queryVariants, searchKey } from './clan-search';

describe('clan-search', () => {
  it('убирает цветовые коды и регистр', () => {
    expect(searchKey('§cМ§#ff00aaАРТИРЫ  Ёж')).toBe('мартиры еж');
  });

  it('добавляет вариант в другой раскладке', () => {
    expect(queryVariants('ащкпу')).toEqual(['ащкпу', 'forge']);
    expect(queryVariants('Ыефдлук')).toEqual(['ыефдлук', 'stalker']);
    expect(queryVariants('scar')).toEqual(['scar', 'ысфк']);
  });

  it('пустой запрос — нечего искать', () => {
    expect(queryVariants('  §c ')).toEqual([]);
  });

  it('экранирует спецсимволы LIKE', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
