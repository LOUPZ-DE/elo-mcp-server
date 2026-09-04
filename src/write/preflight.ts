import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import { WriteConfirmationError } from './errors.js';

/**
 * The two-step guard: a prepare call reserves a token, a commit call spends it.
 *
 * What the token actually protects against is worth being precise about,
 * because it is easy to overclaim. It binds a commit to one user, one client,
 * one operation and one exact payload, it expires, and it works once. So it
 * stops a stale confirmation being replayed, a payload being swapped between
 * preview and execution, and one user's token being used by another.
 *
 * It is NOT a human confirmation. A model can call prepare and commit in the
 * same turn. Human approval is the client's job — which is why the commit tools
 * carry `readOnlyHint: false` and the destructive one carries
 * `destructiveHint: true`, so a client's approval UI engages where it matters.
 *
 * Held in memory only. TTLs are minutes, and a restart that voids an unconfirmed
 * preview fails in the safe direction.
 */

export type WriteOperation =
  | 'create_folder'
  | 'upload_document'
  | 'add_document_version'
  | 'update_metadata';

export interface PreparedWrite {
  operation: WriteOperation;
  /** ELO login name of the user who prepared it. */
  userName: string;
  /** OAuth client that prepared it — a token is not portable between clients. */
  clientId: string;
  /** Hash of the exact payload previewed. */
  payloadHash: string;
  /** The object being written to or into. */
  targetId: string;
  /**
   * What the target looked like at prepare time — version id, mask, changed
   * date, whatever identifies "still the thing I showed you". Re-checked before
   * the write so a concurrent change aborts instead of being overwritten.
   */
  baseline?: string;
  expiresAt: number;
  used: boolean;
}

const pending = new Map<string, PreparedWrite>();
const SWEEP_INTERVAL_MS = 60_000;

/** Stable hash over a payload, independent of key order. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function prepareWrite(
  entry: Omit<PreparedWrite, 'expiresAt' | 'used'>,
): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + config().ELO_WRITE_PREFLIGHT_TTL * 1000;
  const token = randomBytes(24).toString('base64url');
  pending.set(token, { ...entry, expiresAt, used: false });
  logger.info(
    { operation: entry.operation, targetId: entry.targetId, userName: entry.userName },
    'Write prepared',
  );
  return { token, expiresAt };
}

/**
 * Validate and spend a token.
 *
 * Marked used before the caller executes anything, so a write that fails
 * halfway cannot be retried with the same confirmation — the user has to look
 * at a fresh preview and confirm again, which is the correct outcome when
 * nobody knows how far the first attempt got.
 */
export function consumeWrite(
  token: string,
  expected: { userName: string; clientId: string; operation: WriteOperation; payloadHash: string },
): PreparedWrite {
  const entry = pending.get(token);
  if (!entry) {
    throw new WriteConfirmationError(
      'This confirmation is unknown or has already been used. Prepare the change again and confirm the fresh preview.',
    );
  }
  if (entry.expiresAt <= Date.now()) {
    pending.delete(token);
    throw new WriteConfirmationError(
      'This confirmation has expired. Prepare the change again — the preview may no longer be accurate.',
    );
  }
  if (entry.used) {
    throw new WriteConfirmationError('This confirmation has already been used.');
  }
  if (entry.operation !== expected.operation) {
    throw new WriteConfirmationError(
      `This confirmation was issued for "${entry.operation}", not "${expected.operation}".`,
    );
  }
  if (entry.userName !== expected.userName || entry.clientId !== expected.clientId) {
    // Not a mistake worth explaining in detail to whoever is holding someone
    // else's token.
    logger.warn(
      { operation: entry.operation, preparedBy: entry.userName, usedBy: expected.userName },
      'Write confirmation presented by a different user or client',
    );
    throw new WriteConfirmationError('This confirmation does not belong to this session.');
  }
  if (!hashesMatch(entry.payloadHash, expected.payloadHash)) {
    throw new WriteConfirmationError(
      'The values changed after the preview was confirmed. Prepare the change again so the preview matches what would be written.',
    );
  }

  entry.used = true;
  pending.delete(token);
  return entry;
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Test seam. */
export function resetPreflight(): void {
  pending.clear();
}

export function startPreflightSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(token);
        removed++;
      }
    }
    if (removed > 0) logger.debug({ removed }, 'Expired write confirmations swept');
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
