/**
 * A small in-memory cache for expensive reads, with shared in-flight loads.
 *
 * Built for extracted document text. Paging through the 747-page BKI catalogue
 * meant a full download and parse — 26 s — for every 50 000 characters, and
 * Notion was seen sending two calls at once. With this, the first call pays
 * and every later page is a slice of text already in memory; calls that arrive
 * while the first is still parsing wait for that parse instead of starting
 * their own.
 *
 * - Entries expire a fixed time after their **last** read (sliding), so a
 *   document someone is working through stays, and one nobody reads goes.
 * - A size budget, in whatever unit `sizeOf` returns, bounds the memory; the
 *   least recently read entries are evicted first. An entry larger than the
 *   whole budget is not stored at all.
 * - A load is shared by everyone waiting for the same key, and is cancelled
 *   only when the **last** of them gives up. One impatient caller must not
 *   take the result away from the others.
 *
 * It holds whatever it is given and makes no access decisions. Callers must
 * check that the caller may read the key *before* asking — for documents, the
 * per-user checkout does that on every call, cached or not.
 */
export type CacheSource = 'hit' | 'miss' | 'joined';

export interface ReadCacheOptions<T> {
  /** Idle lifetime of an entry, in milliseconds. */
  ttlMs: number;
  /** Total budget, in the unit `sizeOf` returns. */
  maxSize: number;
  sizeOf: (value: T) => number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  size: number;
  expiresAt: number;
}

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

export class ReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>(); // oldest read first
  private readonly flights = new Map<string, Flight<T>>();
  private total = 0;
  private readonly now: () => number;

  constructor(private readonly options: ReadCacheOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The cached value for `key`, or the result of `load` — shared with any
   * other caller already loading the same key. `signal` ends this caller's
   * wait; the load itself stops only once every waiter has left.
   */
  async fetch(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; source: CacheSource }> {
    signal?.throwIfAborted();

    const hit = this.read(key);
    if (hit !== undefined) return { value: hit, source: 'hit' };

    let flight = this.flights.get(key);
    // A flight everyone has left is being cancelled; joining it would hand a
    // fresh caller an abort it never asked for.
    const joined = flight !== undefined && !flight.controller.signal.aborted;
    if (!joined) flight = this.start(key, load);

    return { value: await this.wait(flight!, signal), source: joined ? 'joined' : 'miss' };
  }

  /** Number of stored entries — for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  private read(key: string): T | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Move to the back: most recently read, and the furthest from expiry.
    this.entries.delete(key);
    entry.expiresAt = this.now() + this.options.ttlMs;
    this.entries.set(key, entry);
    return entry.value;
  }

  private store(key: string, value: T): void {
    const size = this.options.sizeOf(value);
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.total -= previous.size;
    }
    if (size > this.options.maxSize) return;

    this.entries.set(key, { value, size, expiresAt: this.now() + this.options.ttlMs });
    this.total += size;
    this.prune();
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.options.maxSize) break;
      this.entries.delete(oldest);
      this.total -= entry.size;
    }
  }

  /** Drop expired entries. Sliding expiry keeps them ordered by expiry, so stop at the first live one. */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(key);
      this.total -= entry.size;
    }
  }

  private start(key: string, load: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const controller = new AbortController();
    const flight: Flight<T> = { controller, waiters: 0, promise: undefined as unknown as Promise<T> };
    flight.promise = load(controller.signal)
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    // A load that every waiter left still settles; nobody is listening then.
    flight.promise.catch(() => {});
    this.flights.set(key, flight);
    return flight;
  }

  private wait(flight: Flight<T>, signal?: AbortSignal): Promise<T> {
    flight.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (): boolean => {
        if (done) return false;
        done = true;
        flight.waiters--;
        signal?.removeEventListener('abort', leave);
        return true;
      };
      const leave = (): void => {
        if (!finish()) return;
        if (flight.waiters === 0) flight.controller.abort(signal!.reason);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', leave, { once: true });
      flight.promise.then(
        (value) => finish() && resolve(value),
        (err: unknown) => finish() && reject(err),
      );
    });
  }
}
