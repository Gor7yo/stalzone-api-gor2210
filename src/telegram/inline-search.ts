import { REGIONS, type Region } from 'src/api/dto/queries.dto';
import { ITEM_INFO } from 'src/collector/item-info';

/** Группы без рыночной ценности: мебель и оборудование убежища (как на сайте). */
const SKIP_GROUPS = new Set(['other']);

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const layout = new Map([...EN].map((c, i) => [c, RU[i]]));

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();
/** «rjvtnf» → «комета»: набрали в английской раскладке. */
const fromLayout = (s: string) =>
  [...s].map((c) => layout.get(c) ?? c).join('');

export interface InlineQuery {
  region: Region;
  text: string;
}

/** «eu комета» → регион EU и текст «комета»; без префикса — RU. */
export function parseQuery(raw: string): InlineQuery {
  const words = norm(raw).split(/\s+/).filter(Boolean);
  const first = words[0] as Region | undefined;
  if (first && (REGIONS as readonly string[]).includes(first)) {
    return { region: first, text: words.slice(1).join(' ') };
  }
  return { region: 'ru', text: words.join(' ') };
}

/** Ник из запроса как набрали (с регистром): «eu Bandit_Ivan» → «Bandit_Ivan». */
export function rawNick(raw: string) {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.toLowerCase();
  return (
    first && (REGIONS as readonly string[]).includes(first)
      ? words.slice(1)
      : words
  ).join(' ');
}

/**
 * Поиск предметов по названию (рус/англ, «ё» = «е», неправильная раскладка).
 * Сначала — совпадение с начала названия, потом — по слову, потом — где-то внутри; короткие названия выше.
 */
export function searchItems(text: string, limit = 8): string[] {
  const q = norm(text);
  if (q.length < 2) return [];
  const variants = [...new Set([q, fromLayout(q)])];
  const scored: { id: string; score: number; len: number }[] = [];
  for (const [id, [name, group, , nameEn]] of Object.entries(ITEM_INFO)) {
    if (SKIP_GROUPS.has(group)) continue;
    let best = Infinity;
    for (const n of [norm(name), norm(nameEn)]) {
      for (const v of variants) {
        const at = n.indexOf(v);
        if (at < 0) continue;
        const score = at === 0 ? 0 : n[at - 1] === ' ' ? 1 : 2;
        best = Math.min(best, score);
      }
    }
    if (best < Infinity) scored.push({ id, score: best, len: name.length });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.len - b.len)
    .slice(0, limit)
    .map((s) => s.id);
}
