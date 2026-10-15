/**
 * Русские названия ключевых характеристик оружейного модуля (id из EXBO → название в игре).
 * В базе EXBO их нет - справочник из игры; во фронте он же с эффектами (features/module-attrs.ts).
 * Нет в списке - показываем id без служебного хвоста.
 */
export const MODULE_STATS: Record<string, string> = {
  marksman: 'Снайпер',
  sadist: 'Охотник',
  sledgehammer: 'Перфоратор',
  gyroscope: 'Регулятор',
  aim_switch_time_aff: 'Стрелок',
  hip_spread_aff: 'Проектор',
  spread_aff: 'Контролер',
  recoil_aff: 'Держатель',
  horizontal_recoil_aff: 'Фиксатор',
  recoil_gain_aff: 'Седатор',
  ergonomics_aff: 'Биостабилизатор',
  shoot_factor_decrement_aff: 'Гаситель',
  wiggle_aff: 'Вариатор',
  draw_time_aff: 'Экстрактор',
  aiming_speed_modifier_aff: 'Оператор',
  equipped_speed_modifier_aff: 'Слайдер',
};

/** «Снайпер» - в кавычках, как в игре */
export const variantLabel = (id: string) =>
  `«${MODULE_STATS[id] ?? id.replace(/_(aff|op)$/, '').replace(/_/g, ' ')}»`;
