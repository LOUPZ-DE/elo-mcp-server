import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';
import { config } from './runtimeConfig.js';

// Encrypted, atomic persistence for the OAuth authorization server's state.
//
// Without it, every redeploy wipes the DCR registrations, and a client that
// stored its client_id — Notion and claude.ai both do — lands on an error page
// at /authorize that it never gets to see. Nothing recovers on its own, so a
// human has to remove and re-add the connector after every deploy.
//
// What makes this file sensitive is the credential vault: ELO user names and
// passwords, held in memory so EloClient can re-login every eight minutes.
// Persisting those means writing them to a volume, which is why the whole file
// is a single AES-256-GCM message and not the plain JSON the reference
// implementation writes.
//
// Single instance only. Every save rewrites the complete state, so two replicas
// sharing a volume would take turns discarding each other's work.

const STATE_VERSION = 1;
/** Bound into the AEAD so an envelope from another version cannot be replayed. */
const AAD = Buffer.from('elo-mcp-state-v1', 'utf8');
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SAVE_DELAY_MS = 1_000;

/**
 * One module's share of the state file.
 *
 * `parse` and `apply` are separate on purpose. Restoring in one step means that
 * a slice failing halfway leaves the earlier slices already mutated while the
 * log says the state was discarded — a wart the reference implementation has.
 * Parsing everything first and only then applying makes a load all-or-nothing.
 */
export interface StateSlice<T = unknown> {
  name: string;
  serialise(): T;
  /** Validate untrusted data. Throw on anything unexpected. */
  parse(data: unknown): T;
  /** Apply a value that `parse` already accepted. Must not throw. */
  apply(value: T): void;
}

const slices: StateSlice<unknown>[] = [];

export function registerSlice<T>(slice: StateSlice<T>): void {
  slices.push(slice as StateSlice<unknown>);
}

/** Test seam: forget every registered slice. */
export function resetSlices(): void {
  slices.length = 0;
}

function enabled(): boolean {
  return Boolean(config().STATE_FILE);
}

/**
 * Decode a configured key into 32 raw bytes.
 *
 * Accepts hex or base64url so whichever generator was to hand works — the
 * `randomBytes(32).toString('base64url')` one-liner already used elsewhere in
 * this project included. Exported because config validation rejects a bad key
 * at boot rather than at the first write.
 */
export function decodeStateKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64url');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `STATE_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  return key;
}

interface Envelope {
  v: number;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  tag: string;
}

/**
 * A readable JSON envelope around opaque ciphertext.
 *
 * Deliberately not a raw binary blob: an operator looking at the volume should
 * be able to tell at a glance that the file *is* encrypted and which version
 * wrote it, without that revealing anything.
 */
export function encryptState(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: Envelope = {
    v: STATE_VERSION,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
  return JSON.stringify(envelope);
}

export function decryptState(raw: string, key: Buffer): string {
  const envelope = JSON.parse(raw) as Partial<Envelope>;
  if (envelope.v !== STATE_VERSION) {
    throw new Error(`unsupported state file version ${String(envelope.v)}`);
  }
  if (envelope.alg !== 'A256GCM') {
    throw new Error(`unsupported algorithm ${String(envelope.alg)}`);
  }
  if (!envelope.iv || !envelope.ct || !envelope.tag) {
    throw new Error('state file envelope is missing iv, ct or tag');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(AAD);
  // Throws on a wrong key or a single flipped bit — this is the integrity
  // check that lets `parse` below trust the shape it is handed.
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Confirm at boot that the state directory can actually be written.
 *
 * A bind mount owned by root gives the `node` user EACCES, and a write error
 * inside the save path is only a log line — the server would keep serving and
 * nobody would find out until the next restart lost everything.
 */
export function ensureStateWritable(): void {
  const file = config().STATE_FILE;
  if (!file) return;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = join(dir, `.write-probe-${randomBytes(4).toString('hex')}`);
  writeFileSync(probe, 'ok', { encoding: 'utf8', mode: 0o600 });
  unlinkSync(probe);
}

/**
 * Move an unreadable state file aside instead of overwriting it.
 *
 * The likeliest cause of a decryption failure is a mistyped or rotated
 * STATE_ENCRYPTION_KEY, and silently starting fresh would destroy every
 * registration and session for what is really a config mistake.
 */
function setAside(file: string, reason: string): void {
  const parked = `${file}.unreadable-${Date.now()}`;
  try {
    renameSync(file, parked);
    logger.error(
      { stateFile: file, parked, reason },
      'State file could not be read — moved aside and starting with empty state. ' +
        'If the key is wrong, fix STATE_ENCRYPTION_KEY and rename the file back.',
    );
  } catch (err) {
    logger.error(
      { stateFile: file, reason, err: err instanceof Error ? err.message : err },
      'State file could not be read and could not be moved aside',
    );
  }
}

export function loadState(): void {
  const file = config().STATE_FILE;
  if (!file) return;

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    logger.info({ stateFile: file }, 'No state file yet — starting with empty state');
    return;
  }

  let plaintext: string;
  try {
    plaintext = decryptState(raw, decodeStateKey(config().STATE_ENCRYPTION_KEY!));
  } catch (err) {
    setAside(file, err instanceof Error ? err.message : String(err));
    return;
  }

  // Parse everything before touching anything.
  const staged: Array<{ slice: StateSlice<unknown>; value: unknown }> = [];
  try {
    const payload = JSON.parse(plaintext) as { v?: number; slices?: Record<string, unknown> };
    if (payload.v !== STATE_VERSION) {
      throw new Error(`unsupported payload version ${String(payload.v)}`);
    }
    for (const slice of slices) {
      const data = payload.slices?.[slice.name];
      if (data === undefined) continue;
      staged.push({ slice, value: slice.parse(data) });
    }
  } catch (err) {
    logger.error(
      { stateFile: file, err: err instanceof Error ? err.message : err },
      'State file contents were rejected — starting with empty state',
    );
    return;
  }

  for (const { slice, value } of staged) slice.apply(value);
  logger.info(
    { stateFile: file, slices: staged.map((s) => s.slice.name) },
    'State restored',
  );
}

let saveTimer: NodeJS.Timeout | null = null;

/**
 * Coalescing throttle, not a debounce.
 *
 * A pending timer swallows further calls rather than being pushed back, so the
 * write lands one second after the *first* mutation of a burst. That bounds the
 * loss window; a true debounce would defer the write indefinitely under
 * sustained traffic.
 *
 * The timer is deliberately NOT unref'd. The reference implementation unrefs
 * it, and an unref'd timer is discarded when the process exits — losing exactly
 * the last second before a redeploy, which is the case this whole file exists
 * to prevent.
 */
export function scheduleSave(): void {
  if (!enabled() || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DELAY_MS);
}

/** Write immediately, cancelling any pending save. Safe to call when disabled. */
export function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (enabled()) saveNow();
}

function saveNow(): void {
  const file = config().STATE_FILE;
  if (!file) return;

  let envelope: string;
  try {
    const payload = {
      v: STATE_VERSION,
      slices: Object.fromEntries(slices.map((s) => [s.name, s.serialise()])),
    };
    envelope = encryptState(JSON.stringify(payload), decodeStateKey(config().STATE_ENCRYPTION_KEY!));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'State could not be serialised');
    return;
  }

  // Random suffix so two writes can never share a temp file, and 0600 because
  // the plaintext inside is ELO credentials.
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, envelope, { encoding: 'utf8', mode: 0o600 });
    // Atomic within the directory: a reader sees the old file or the new one.
    renameSync(tmp, file);
    logger.debug({ stateFile: file, bytes: envelope.length }, 'State written');
  } catch (err) {
    logger.error(
      { stateFile: file, err: err instanceof Error ? err.message : err },
      'State file could not be written',
    );
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
  }
}

/** Constant-time compare, for config checks that must not leak by timing. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
