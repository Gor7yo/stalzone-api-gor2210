// Радар рынка (Pro): резкие движения цен по ходовым позициям. Без зависимостей (тесты).

/** Скачок за час: медиана последнего часа против медианы за 3 дня — от 25 %. */
export const RADAR_JUMP = 0.25;
/** Для скачка нужно хотя бы столько сделок за час и за 3 дня. */
export const RADAR_HOUR_DEALS = 4;
export const RADAR_BASE_DEALS = 20;
/** Рост несколько дней подряд: каждые сутки дороже прошлых, в сумме от 15 %. */
export const RADAR_TREND = 0.15;
/** Один и тот же сигнал по позиции — не чаще раза в 12 часов. */
export const RADAR_REPEAT_MS = 12 * 60 * 60_000;

/** Позиция с медианами сделок (за штуку) — из SQL радара. */
export interface RadarRow {
  itemId: string;
  variant: string;
  quality: number;
  upgrade: number;
  hourMedian: number | null;
  hourN: number;
  baseMedian: number | null;
  baseN: number;
  /** медианы по суткам: [3 дня назад, 2 дня, вчера, последние сутки]; null — сделок не было */
  days: (number | null)[];
}

export type RadarKind = 'up' | 'down' | 'trend';

export interface RadarSignal {
  row: RadarRow;
  kind: RadarKind;
  /** изменение, доля: 0,32 — +32 %, −0,3 — −30 % */
  change: number;
  from: number;
  to: number;
}

export const radarKey = (r: RadarRow, kind: RadarKind) =>
  `${r.itemId}|${r.variant}|${r.quality}|${r.upgrade}|${kind}`;

/** Сигналы по позиции: скачок за час (вверх или вниз) и рост несколько суток подряд. */
export function radarSignals(r: RadarRow): RadarSignal[] {
  const out: RadarSignal[] = [];
  if (
    r.hourMedian &&
    r.baseMedian &&
    r.hourN >= RADAR_HOUR_DEALS &&
    r.baseN >= RADAR_BASE_DEALS
  ) {
    const change = r.hourMedian / r.baseMedian - 1;
    if (Math.abs(change) >= RADAR_JUMP) {
      out.push({
        row: r,
        kind: change > 0 ? 'up' : 'down',
        change,
        from: r.baseMedian,
        to: r.hourMedian,
      });
    }
  }
  const days = r.days;
  if (days.length >= 2 && days.every((d): d is number => !!d)) {
    const rising = days.every((d, i) => i === 0 || d > days[i - 1]);
    const change = days[days.length - 1] / days[0] - 1;
    if (rising && change >= RADAR_TREND) {
      out.push({
        row: r,
        kind: 'trend',
        change,
        from: days[0],
        to: days[days.length - 1],
      });
    }
  }
  return out;
}

/**
 * Новые сигналы: убирает те, о которых сообщали меньше 12 часов назад
 * (sent: prefix + radarKey → когда; prefix — например, регион).
 */
export function freshSignals(
  signals: RadarSignal[],
  sent: ReadonlyMap<string, number>,
  now: number,
  prefix = '',
) {
  return signals.filter((s) => {
    const at = sent.get(prefix + radarKey(s.row, s.kind));
    return at === undefined || now - at >= RADAR_REPEAT_MS;
  });
}
