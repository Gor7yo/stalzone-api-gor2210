// Нормализация для поиска кланов. Без зависимостей (тесты).

/** Цветовые коды Minecraft в названиях кланов: «§c», «§#ff00aa». */
const MC_CODES = /§(#[0-9a-f]{6}|[0-9a-fk-or])/gi;

/** Ключ поиска: без цветовых кодов, в нижнем регистре, ё → е, без лишних пробелов. */
export const searchKey = (s: string) =>
  s
    .replace(MC_CODES, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const toRu = new Map([...EN].map((c, i) => [c, RU[i]]));
const toEn = new Map([...RU].map((c, i) => [c, EN[i]]));

/**
 * Что искать: сам запрос и он же в другой раскладке («ащкпу» → «forge»,
 * «ысфкф» ← «scara»). Варианты, совпавшие с запросом, не повторяем.
 */
export function queryVariants(raw: string): string[] {
  const q = searchKey(raw);
  if (!q) return [];
  const swap = (m: Map<string, string>) =>
    [...q].map((c) => m.get(c) ?? c).join('');
  return [...new Set([q, swap(toRu), swap(toEn)].map(searchKey))].filter(
    Boolean,
  );
}

/** Экранирование для LIKE: «%» и «_» в запросе — обычные символы. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
