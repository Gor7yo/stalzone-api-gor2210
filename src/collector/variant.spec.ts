import { attributesOf, variantOf } from './variant';

describe('attributesOf', () => {
  it('сохраняет три атрибута модуля с quality и statsRandom, без лишних полей', () => {
    expect(
      attributesOf({
        qlt: 3,
        attributes: [
          {
            type: 2,
            statsRandom: 2.4077475,
            definitionId: 'marksman',
            quality: 3,
            x: 1,
          },
          {
            type: 1,
            statsRandom: 1.6996375,
            definitionId: 'shoot_factor_decrement_suf',
            quality: 2,
          },
          {
            statsRandom: -0.128271,
            definitionId: 'hip_spread_pre',
            quality: 2,
          },
        ],
      }),
    ).toEqual([
      { type: 2, statsRandom: 2.4077475, definitionId: 'marksman', quality: 3 },
      {
        type: 1,
        statsRandom: 1.6996375,
        definitionId: 'shoot_factor_decrement_suf',
        quality: 2,
      },
      { statsRandom: -0.128271, definitionId: 'hip_spread_pre', quality: 2 },
    ]);
  });

  it('не модуль или мусор - null', () => {
    expect(attributesOf(undefined)).toBeNull();
    expect(attributesOf({ qlt: 3 })).toBeNull();
    expect(
      attributesOf({ attributes: [null, { definitionId: '../x' }] }),
    ).toBeNull();
  });
});

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
