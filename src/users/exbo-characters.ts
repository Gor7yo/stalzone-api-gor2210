/** Персонаж игрока из EXBO /{region}/characters - то, что храним и отдаём сайту. */
export interface ExboCharacter {
  region: string;
  name: string;
  /** uuid персонажа в EXBO; null, если EXBO его не прислал */
  id: string | null;
  createdAt: string | null;
  clan: {
    id: string;
    name: string;
    tag: string | null;
    rank: string | null;
  } | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown) =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

/**
 * Ответ /characters в OpenAPI EXBO не описан (просто object), поэтому разбираем осторожно:
 * ждём массив `{ information: { id, name, creationTime }, clan: { info, member } }`,
 * но принимаем и плоский `{ id, name }`. Всё, что не похоже на персонажа, пропускаем.
 */
export function parseCharacters(
  region: string,
  data: unknown,
): ExboCharacter[] {
  const list = Array.isArray(data)
    ? data
    : (obj(data)?.characters ?? obj(data)?.items);
  if (!Array.isArray(list)) return [];

  const result: ExboCharacter[] = [];
  for (const raw of list) {
    const item = obj(raw);
    if (!item) continue;
    const info = obj(item.information) ?? item;
    const name = str(info.name) ?? str(info.username);
    if (!name) continue;

    const clanInfo = obj(obj(item.clan)?.info);
    const member = obj(obj(item.clan)?.member);
    const clanId = str(clanInfo?.id);
    result.push({
      region,
      name,
      id: str(info.id) ?? str(info.uuid),
      createdAt: str(info.creationTime),
      clan:
        clanId && clanInfo
          ? {
              id: clanId,
              name: str(clanInfo.name) ?? clanId,
              tag: str(clanInfo.tag),
              rank: str(member?.rank),
            }
          : null,
    });
  }
  return result;
}
