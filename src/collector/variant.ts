/**
 * Вариант предмета, от которого зависит цена, кроме качества и заточки.
 *
 * Сейчас это ключевая характеристика оружейного модуля - последняя в названии, в кавычках
 * («Снайпер», «Садист»…). В лоте EXBO она лежит в additional.attributes: атрибут с type 2
 * (без type - приставка, type 1 - суффикс). У модулей «sadist» и «aiming_speed» цены
 * отличаются в 20+ раз, поэтому медианы и флипы считаются по каждому варианту отдельно.
 *
 * "" - у предмета вариантов нет (или EXBO не прислал атрибуты).
 */
export function variantOf(additional?: Record<string, unknown>): string {
  const attributes = additional?.attributes;
  if (!Array.isArray(attributes)) return '';
  for (const a of attributes as unknown[]) {
    if (!a || typeof a !== 'object') continue;
    const { type, definitionId } = a as {
      type?: unknown;
      definitionId?: unknown;
    };
    if (
      type === 2 &&
      typeof definitionId === 'string' &&
      /^[a-z0-9_]{1,64}$/.test(definitionId)
    ) {
      return definitionId;
    }
  }
  return '';
}
