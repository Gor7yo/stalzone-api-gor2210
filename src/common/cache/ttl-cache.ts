/** Просроченные записи выметаем не чаще, чем раз в столько. */
const SWEEP_EVERY_MS = 30_000;

/**
 * Кеш с временем жизни и ограничением размера (LRU) + склейка одинаковых запросов.
 *
 * Если 20 человек одновременно открыли «Комету», к API EXBO уйдёт один запрос:
 * остальные дождутся того же промиса (in-flight dedupe), а следующие получат ответ из кеша.
 * Просроченные записи удаляются при записи новых: иначе они висели бы в памяти до вытеснения
 * по размеру (у кеша EXBO это сотни МБ ответов, процесс падал от нехватки памяти).
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expires: number }>();
  private readonly inflight = new Map<string, Promise<T>>();
  private sweptAt = 0;

  constructor(private readonly maxEntries = 2000) {}

  /** Забыть всё (данные под кешем обновились). Идущие загрузки доживают как есть. */
  clear() {
    this.store.clear();
  }

  async getOrLoad(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = this.store.get(key);
    if (hit && hit.expires > Date.now()) {
      // обновляем позицию в LRU
      this.store.delete(key);
      this.store.set(key, hit);
      return hit.value;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        if (ttlMs > 0) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  private set(key: string, value: T, ttlMs: number) {
    const now = Date.now();
    if (now - this.sweptAt >= SWEEP_EVERY_MS) {
      this.sweptAt = now;
      for (const [k, entry] of this.store)
        if (entry.expires <= now) this.store.delete(k);
    }
    this.store.delete(key);
    this.store.set(key, { value, expires: now + ttlMs });
    // вытесняем самые старые записи
    if (this.store.size <= this.maxEntries) return;
    for (const oldest of this.store.keys()) {
      this.store.delete(oldest);
      if (this.store.size <= this.maxEntries) break;
    }
  }

  get size() {
    return this.store.size;
  }
}
