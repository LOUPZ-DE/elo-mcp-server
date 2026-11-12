/**
 * Minimal concurrency limiter.
 *
 * Downloading and parsing a document holds the whole file in memory, several
 * times over once the parser builds its own structures. The HTTP transport is
 * stateless per request and applies no backpressure of its own, so without this
 * a handful of simultaneous large PDFs can exhaust a small container.
 */
export type Semaphore = <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  // A finishing holder hands its slot straight to the next waiter instead of
  // freeing it. Freeing first left a gap — between the decrement and the
  // waiter resuming — in which a newcomer could take the same slot.
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  return async function run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (active < limit) {
      active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', leave);
          resolve();
        };
        // A caller whose client gave up leaves the queue rather than holding
        // its place: before this, an abandoned read still ran when its turn
        // came, and everyone behind it waited for a result nobody would read.
        const leave = (): void => {
          const at = queue.indexOf(wake);
          if (at < 0) return; // already woken; the slot is ours and is released below
          queue.splice(at, 1);
          reject(signal!.reason);
        };
        queue.push(wake);
        signal?.addEventListener('abort', leave, { once: true });
      });
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
