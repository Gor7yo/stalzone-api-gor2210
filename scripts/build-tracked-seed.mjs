// Стартовый список предметов для сборщика аукциона.
// Берёт справочник фронтенда (public/items.json, собирается `npm run items` во фронте)
// и оставляет то, что реально перепродают: артефакты, броню, оружие, контейнеры, рюкзаки.
//
//   node scripts/build-tracked-seed.mjs ../stalzone-front-nextjs/public
//
// Результат: src/collector/seed-items.ts (коммитится, обновлять после патчей игры).
import { readFileSync, writeFileSync } from 'node:fs';
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

// формат items.json: [id, nameRu, nameEn, colorIndex, categoryIndex]
const seed = items.items
  .filter(([id, , , , cat]) => {
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
    '// Стартовый список сборщика: артефакты, броня, оружие, контейнеры, рюкзаки.',
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
