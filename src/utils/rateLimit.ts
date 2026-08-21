import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

// A fixed-window limiter for the browser-facing OAuth endpoints.
//
// Hand-rolled rather than pulling in `express-rate-limit`: the version resolved
// in this tree comes in as a transitive dependency of the MCP SDK and targets
// Express 5, while this app runs Express 4. Thirty lines with no version risk
// beat a peer-dependency mismatch.
//
// What it is for: /authorize accepts passwords, and /register accepts anonymous
// writes. This makes both expensive to hammer. It is not a defence against a
// distributed attacker, and is not claimed to be.

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Included in the log line so a trip can be traced to an endpoint. */
  name: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const windows = new Map<string, Window>();

  // Bounded by sweeping on write; nothing else holds a reference to this map.
  const sweep = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (windows.size > 5_000) sweep(now);

    // `trust proxy` is set, so req.ip is the client address from
    // X-Forwarded-For rather than the reverse proxy's.
    const key = req.ip ?? 'unknown';
    const window = windows.get(key);

    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    window.count++;
    if (window.count > opts.max) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      logger.warn({ limiter: opts.name, retryAfter }, 'Rate limit exceeded');
      res
        .status(429)
        .set('Retry-After', String(retryAfter))
        .json({ error: 'too_many_requests', error_description: 'Too many requests' });
      return;
    }
    next();
  };
}
