/**
 * Minimal concurrency limiter.
 *
 * Downloading and parsing a document holds the whole file in memory, several
 * times over once the parser builds its own structures. The HTTP transport is
 * stateless per request and applies no backpressure of its own, so without this
 * a handful of simultaneous large PDFs can exhaust a small container.
 */
export function createSemaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    queue.shift()?.();
  };

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
