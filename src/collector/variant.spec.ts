import { variantOf } from './variant';

describe('variantOf', () => {
  it('ключевая характеристика модуля - атрибут с type 2', () => {
    expect(
      variantOf({
        qlt: 1,
        attributes: [
          { statsRandom: 0.2, definitionId: 'shoot_factor_decrement_pre' },
          { type: 2, statsRandom: -0.8, definitionId: 'marksman', quality: 1 },
          {
            type: 1,
            statsRandom: 0.9,
            definitionId: 'shoot_factor_decrement_suf',
          },
        ],
      }),
    ).toBe('marksman');
  });

  it('обычная ключевая характеристика (_aff) - тоже вариант', () => {
    expect(
      variantOf({ attributes: [{ type: 2, definitionId: 'recoil_aff' }] }),
    ).toBe('recoil_aff');
  });

  it('без атрибутов и с мусором - без варианта', () => {
    expect(variantOf(undefined)).toBe('');
    expect(variantOf({ qlt: 3 })).toBe('');
    expect(variantOf({ attributes: 'x' })).toBe('');
    expect(
      variantOf({ attributes: [null, { type: 1, definitionId: 'a_suf' }] }),
    ).toBe('');
    expect(
      variantOf({ attributes: [{ type: 2, definitionId: '../../etc' }] }),
    ).toBe('');
  });
});
