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

export interface ModuleAttribute {
  /** нет - приставка, 1 - суффикс, 2 - ключевая */
  type?: number;
  definitionId: string;
  quality?: number;
  statsRandom?: number;
}

/**
 * Атрибуты модуля для хранения: только нужные сайту поля (по ним он считает проценты).
 * null - атрибутов нет (не модуль).
 */
export function attributesOf(
  additional?: Record<string, unknown>,
): ModuleAttribute[] | null {
  const attributes = additional?.attributes;
  if (!Array.isArray(attributes)) return null;
  const out: ModuleAttribute[] = [];
  for (const a of attributes as unknown[]) {
    if (!a || typeof a !== 'object') continue;
    const { type, definitionId, quality, statsRandom } = a as Record<
      string,
      unknown
    >;
    if (typeof definitionId !== 'string') continue;
    if (!/^[a-z0-9_]{1,64}$/.test(definitionId)) continue;
    out.push({
      definitionId,
      ...(typeof type === 'number' && { type }),
      ...(typeof quality === 'number' && { quality }),
      ...(typeof statsRandom === 'number' &&
        Number.isFinite(statsRandom) && { statsRandom }),
    });
  }
  return out.length ? out : null;
}
