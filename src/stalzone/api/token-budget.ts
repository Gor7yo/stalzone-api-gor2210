const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Квота кончилась, а ждать запросу нельзя (фоновый сборщик) — пропускаем ход. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('Квота STALZONE API на эту минуту исчерпана');
  }
}

export type Priority = 'user' | 'background';

/**
 * Общий для всего приложения «кошелёк» токенов STALCRAFT API (token bucket).
 *
 * EXBO выдаёт приложению N токенов в минуту, запрос к аукциону стоит 2, остальные — 1;
 * при перерасходе — 429 до следующей минуты. Мы тратим токены сами и заранее:
 * - запросы пользователей идут первыми и при нехватке немного ждут;
 * - фоновый сборщик берёт только остаток сверх резерва, иначе пропускает ход;
 * - на 429 обнуляемся и ждём, а если EXBO присылает свои заголовки лимита — сверяемся с ними.
 */
export class TokenBudget {
  private tokens: number;
  private updatedAt = Date.now();
  private blockedUntil = 0;
  /** расход по типам за текущую минуту — для статуса сборщика */
  private spent = { user: 0, background: 0, since: Date.now() };

  constructor(
    public perMinute: number,
    /** сколько токенов сборщик обязан оставить людям */
    public reserve: number,
    /** доля резерва — чтобы пересчитать его, когда EXBO сообщит свой лимит */
    private readonly reserveShare = reserve / perMinute,
  ) {
    this.tokens = perMinute;
  }

  /** EXBO сообщил лимит (x-ratelimit-limit) — подстраиваемся под него. */
  setLimit(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0 || limit === this.perMinute)
      return false;
    this.refill();
    this.perMinute = limit;
    this.reserve = Math.round(limit * this.reserveShare);
    this.tokens = Math.min(this.tokens, limit);
    return true;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(
      this.perMinute,
      this.tokens + ((now - this.updatedAt) / 60_000) * this.perMinute,
    );
    this.updatedAt = now;
    if (now - this.spent.since >= 60_000) {
      this.spent = { user: 0, background: 0, since: now };
    }
  }

  /** Взять токены: пользователь ждёт до maxWaitMs, сборщик — либо сразу, либо ошибка. */
  async take(cost: number, priority: Priority, maxWaitMs = 8_000) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      this.refill();
      const blocked = Date.now() < this.blockedUntil;
      const floor = priority === 'background' ? this.reserve : 0;
      if (!blocked && this.tokens - cost >= floor) {
        this.tokens -= cost;
        this.spent[priority] += cost;
        return;
      }
      if (priority === 'background') throw new BudgetExhaustedError();
      // сколько ждать до нужного количества токенов
      const need = Math.max(0, cost - this.tokens);
      const wait = blocked
        ? this.blockedUntil - Date.now()
        : (need / this.perMinute) * 60_000;
      if (Date.now() + wait > deadline) throw new BudgetExhaustedError();
      await sleep(Math.max(50, wait));
    }
  }

  /** EXBO ответил 429: токенов нет до следующей минуты (или до Retry-After). */
  onRateLimited(retryAfterSec?: number, resetAt?: number) {
    this.tokens = 0;
    const now = Date.now();
    this.updatedAt = now;
    const untilNextMinute = 60_000 - (now % 60_000);
    // точнее всего — время сброса от EXBO (x-ratelimit-reset, мс), если оно в разумных пределах
    const untilReset =
      resetAt && resetAt > now && resetAt - now <= 120_000
        ? resetAt - now
        : undefined;
    this.blockedUntil =
      now +
      (untilReset ??
        (retryAfterSec && Number.isFinite(retryAfterSec)
          ? retryAfterSec * 1000
          : untilNextMinute));
  }

  /** EXBO сообщил остаток сам (заголовок) — доверяем ему больше, чем своему счёту. */
  sync(remaining: number) {
    if (!Number.isFinite(remaining)) return;
    this.refill();
    this.tokens = Math.min(this.tokens, remaining);
  }

  status() {
    this.refill();
    return {
      perMinute: this.perMinute,
      reserve: this.reserve,
      available: Math.floor(this.tokens),
      blocked: Date.now() < this.blockedUntil,
      spentThisMinute: {
        user: this.spent.user,
        background: this.spent.background,
      },
    };
  }
}
