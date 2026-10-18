// Стартовый список предметов для сборщика аукциона.
// Берёт справочник фронтенда (public/items.json, собирается `npm run items` во фронте)
// и оставляет то, что реально перепродают: артефакты, броню, оружие, контейнеры, рюкзаки.
//
//   node scripts/build-tracked-seed.mjs ../stalzone-front-nextjs/public
//
// Результат: src/collector/seed-items.ts (коммитится, обновлять после патчей игры).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GROUPS = ['artefact', 'armor', 'weapon', 'containers', 'backpacks'];

const dir = process.argv[2];
if (!dir) {
  console.error('Укажите папку public фронтенда: node scripts/build-tracked-seed.mjs <path>');
  process.exit(1);
}

const items = JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8'));
const barter = JSON.parse(readFileSync(join(dir, 'barter.json'), 'utf8'));
const farm = new Set(Array.isArray(barter.farm) ? barter.farm : Object.keys(barter.farm));

// Ручной белый список (src/collector/seed-items.json, [{ id, name, group }]): если он есть,
// в сборщик идут только эти предметы — имена и категории берём свежие из справочника.
const curatedPath = join(import.meta.dirname, '..', 'src', 'collector', 'seed-items.json');
const curated = existsSync(curatedPath)
  ? new Set(JSON.parse(readFileSync(curatedPath, 'utf8')).map((x) => x.id))
  : null;
if (curated) {
  const known = new Set(items.items.map(([id]) => id));
  const missing = [...curated].filter((id) => !known.has(id));
  if (missing.length) console.warn(`Нет в справочнике (пропущены): ${missing.join(', ')}`);
}

// формат items.json: [id, nameRu, nameEn, colorIndex, categoryIndex]
const seed = items.items
  .filter(([id, , , , cat]) => {
    if (curated) return curated.has(id);
    const group = String(items.categories[cat] ?? '').split('/')[0];
    // weapon/device — детекторы и приборы, их не перепродают
    return GROUPS.includes(group) && !items.categories[cat].startsWith('weapon/device') && !farm.has(id);
  })
  // name — для текста уведомлений бота (флип-алерты)
  .map(([id, name, , , cat]) => ({ id, name, group: items.categories[cat].split('/')[0] }));

const out = join(import.meta.dirname, '..', 'src', 'collector', 'seed-items.ts');
writeFileSync(
  out,
  [
    '// Сгенерировано scripts/build-tracked-seed.mjs — не править руками.',
    curated
      ? '// Стартовый список сборщика — ручной белый список из src/collector/seed-items.json.'
      : '// Стартовый список сборщика: артефакты, броня, оружие, контейнеры, рюкзаки.',
    '/* prettier-ignore */',
    `export const SEED_ITEMS: { id: string; name: string; group: string }[] = ${JSON.stringify(seed)};`,
    '',
  ].join('\n'),
);
const byGroup = Object.groupBy(seed, (s) => s.group);
console.log(
  `seed-items.ts: ${seed.length} предметов —`,
  Object.entries(byGroup)
    .map(([g, list]) => `${g} ${list.length}`)
    .join(', '),
);

// Названия, группы и категории всех предметов (из базы EXBO через справочник фронтенда) — для текста
// уведомлений бота, фильтра категорий во флиппере и inline-поиска в боте (категория — путь к иконке).
const info = Object.fromEntries(
  items.items.map(([id, name, nameEn, , cat]) => {
    const category = String(items.categories[cat] ?? '');
    return [id, [name, category.split('/')[0], category, nameEn || name]];
  }),
);
writeFileSync(
  join(import.meta.dirname, '..', 'src', 'collector', 'item-info.ts'),
  [
    '// Сгенерировано scripts/build-tracked-seed.mjs — не править руками.',
    '// id предмета → [русское название, группа, категория, английское название] из базы EXBO (public/items.json фронтенда).',
    '/* prettier-ignore */',
    `export const ITEM_INFO: Record<string, [name: string, group: string, category: string, nameEn: string]> = ${JSON.stringify(info)};`,
    '',
  ].join('\n'),
);
console.log(`item-info.ts: ${items.items.length} предметов`);
