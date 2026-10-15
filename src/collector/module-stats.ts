/**
 * Русские названия ключевых характеристик оружейного модуля (id из EXBO → название в игре).
 * В базе EXBO их нет - заполняются вручную; тот же список во фронте (features/modules.ts).
 * Нет в списке - показываем id без служебного хвоста.
 */
export const MODULE_STATS: Record<string, string> = {
  // marksman: 'Снайпер',
};

/** «Снайпер» - в кавычках, как в игре */
export const variantLabel = (id: string) =>
  `«${MODULE_STATS[id] ?? id.replace(/_(aff|op)$/, '').replace(/_/g, ' ')}»`;
