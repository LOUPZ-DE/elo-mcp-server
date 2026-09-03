import { logger } from '../utils/logger.js';
import type { WriteOperation } from './preflight.js';

/**
 * One line per attempted write, on every path — success, refusal, and failure.
 *
 * A write log that only records successes answers the wrong question. What an
 * operator needs afterwards is "who tried what, and what came of it", and the
 * refusals are the interesting half of that.
 *
 * What deliberately never appears here: file bytes, extracted text, index field
 * *values*, credentials, tokens, upload URLs. Field names yes, contents no —
 * the point is accountability, not a second copy of the archive in the log.
 * Note that pino's redaction in src/utils/logger.ts only matches one level
 * deep, so this cannot be left to it; the shaping happens here.
 */

export type WriteOutcome = 'prepared' | 'committed' | 'refused' | 'failed' | 'replayed';

export interface AuditEntry {
  operation: WriteOperation;
  outcome: WriteOutcome;
  /** ELO login name — the accountable party. */
  userName: string;
  /** OAuth client the call came through. */
  clientId?: string;
  /** Object written to, or the parent a new object went into. */
  targetId?: string;
  /** Object that resulted, once there is one. */
  resultObjId?: string;
  /** Index field NAMES only. Never their values. */
  fieldNames?: string[];
  /** File metadata without the file. */
  fileName?: string;
  contentType?: string;
  byteLength?: number;
  /** Why it was refused or how it failed. Already user-facing prose. */
  reason?: string;
  durationMs?: number;
}

export function auditWrite(entry: AuditEntry): void {
  const level = entry.outcome === 'failed' ? 'error' : entry.outcome === 'refused' ? 'warn' : 'info';
  logger[level]({ audit: 'write', ...entry }, `Write ${entry.outcome}: ${entry.operation}`);
}

/**
 * Run an operation and audit whatever happens to it.
 *
 * Wrapping rather than leaving it to the caller because "every error path also
 * writes an audit result" is exactly the kind of requirement that survives
 * review and then quietly rots as branches are added.
 */
export async function withAudit<T>(
  base: Omit<AuditEntry, 'outcome' | 'durationMs'>,
  run: () => Promise<{ value: T; resultObjId?: string; replayed?: boolean }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { value, resultObjId, replayed } = await run();
    auditWrite({
      ...base,
      outcome: replayed ? 'replayed' : 'committed',
      resultObjId,
      durationMs: Date.now() - started,
    });
    return value;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A refusal is a decision this server made; a failure is something that
    // broke. They belong at different log levels and read differently in a
    // post-mortem.
    const refused =
      typeof (err as { code?: unknown })?.code === 'string' &&
      String((err as { code?: unknown }).code).startsWith('WRITE_');
    auditWrite({
      ...base,
      outcome: refused ? 'refused' : 'failed',
      reason,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
