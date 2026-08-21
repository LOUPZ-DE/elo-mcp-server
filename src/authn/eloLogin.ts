import axios from 'axios';
import { EloClient } from '../elo/client.js';
import { runFind, findInFolder } from '../elo/find.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import { randomToken } from '../oauth/pkce.js';
import type { CheckoutUserResponse } from '../elo/types.js';

// The credential vault.
//
// This is what makes per-user ELO access work at all. `runAsUser` impersonation
// is refused by the live instance (BUGFIXES #21), so the only way to run tool
// calls under a user's own ELO permissions is to hold a session that user
// authenticated themselves. IX times sessions out after ~10 minutes and
// `EloClient` re-logins on demand (client.ts:165) — which it can only do while
// it still has the credentials. Hence: they stay in memory for the lifetime of
// the session, and never anywhere else.
//
// They are never written to disk, never logged, and never put into a token: the
// access token carries only the opaque `sid` handle into this map.

/** The archive root. Listing its children is the cheapest real read there is. */
const ARCHIVE_ROOT_ID = '1';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type EloLoginFailureKind =
  /** IX said the user is unknown, the password wrong, or the account locked. */
  | 'credentials'
  /** IX refused the sign-in for some other reason (licence limit, for example). */
  | 'ix-rejected'
  /** The proxy in front of IX rejected our Basic Auth — a server misconfiguration. */
  | 'proxy-auth'
  /** IX could not be reached at all. */
  | 'unreachable'
  /** Sign-in was accepted but the resulting session cannot read anything. */
  | 'session-unusable';

export class EloLoginError extends Error {
  constructor(
    readonly kind: EloLoginFailureKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'EloLoginError';
  }
}

export interface EloUserSession {
  /** Opaque handle. Travels in the access token; nothing else here does. */
  sid: string;
  /** ELO login name exactly as IX accepted it. */
  userName: string;
  displayName: string;
  /** Authenticated as this user — holds their credentials for re-login. */
  client: EloClient;
  createdAt: number;
  lastUsed: number;
}

const sessions = new Map<string, EloUserSession>();

function idleTtlMs(): number {
  return config().ELO_USER_SESSION_TTL * 1000;
}

/**
 * Build a client that signs in to IX as `userName`.
 *
 * The Basic Auth pair must be passed explicitly. `EloClient` otherwise falls
 * back to `basicAuthUser ?? username` (client.ts:67), which would send the end
 * user's credentials to the nginx sitting in front of IX instead of the
 * technical account it expects — and that layer is not where the user
 * authenticates. Getting this wrong fails for every user at once, silently.
 */
function clientForUser(userName: string, password: string): EloClient {
  const cfg = config();
  return new EloClient({
    baseUrl: cfg.ELO_BASE_URL,
    username: userName,
    password,
    basicAuthUser: cfg.ELO_BASIC_AUTH_USER ?? cfg.ELO_USERNAME,
    basicAuthPass: cfg.ELO_BASIC_AUTH_PASS ?? cfg.ELO_PASSWORD,
    language: cfg.ELO_LANGUAGE,
    country: cfg.ELO_COUNTRY,
    timeZone: cfg.ELO_TIMEZONE,
  });
}

/**
 * Turn whatever went wrong during sign-in into something the login form can
 * say honestly.
 *
 * The distinction that matters most: `[ELOIX:3008]` is the user's problem,
 * an HTTP 401 from the proxy is ours. Both look like "login failed" from the
 * outside and telling them apart is the difference between the user retyping
 * their password and someone checking ELO_BASIC_AUTH_*.
 */
export function classifyLoginError(err: unknown): EloLoginError {
  const detail = err instanceof Error ? err.message : String(err);

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    // /login is the one path the proxy lets through unauthenticated, so a 401
    // here means our Basic Auth pair was refused, not the user's password.
    if (status === 401 || status === 403 || status === 407) {
      return new EloLoginError(
        'proxy-auth',
        'Der Server konnte sich nicht bei ELO ausweisen.',
        detail,
      );
    }
    if (!err.response) {
      return new EloLoginError('unreachable', 'ELO ist derzeit nicht erreichbar.', detail);
    }
    return new EloLoginError('unreachable', 'ELO hat unerwartet geantwortet.', detail);
  }

  // IX reports bad credentials as HTTP 200 with an exception body, which
  // EloClient.login() already turns into an Error (BUGFIXES #1). 3008 covers
  // unknown user, wrong password and locked account alike — it does not
  // distinguish them, so neither may we.
  if (/\b3008\b|Unbekannter Benutzer|Unknown user/i.test(detail)) {
    return new EloLoginError(
      'credentials',
      'Benutzername oder Passwort ist falsch, oder das Konto ist gesperrt.',
      detail,
    );
  }
  if (/ELO login rejected/i.test(detail)) {
    return new EloLoginError('ix-rejected', 'ELO hat die Anmeldung abgelehnt.', detail);
  }
  return new EloLoginError(
    'session-unusable',
    'Die Anmeldung wurde angenommen, aber der Zugriff auf ELO schlägt fehl.',
    detail,
  );
}

/**
 * Resolve the user's display name. Best effort by design: `checkoutUser` may
 * be restricted in some installations, and a missing display name must never
 * be the reason somebody cannot sign in.
 */
async function resolveDisplayName(client: EloClient, userName: string): Promise<string> {
  try {
    const response = await client.request<CheckoutUserResponse>(
      '/rest/IXServicePortIF/checkoutUser',
      // The parameter is `id`, not `userId`, and CheckoutUsersC rejects the
      // bset '-1' used everywhere else in this codebase. Both per BUGFIXES #19.
      { id: userName, checkoutUsersZ: { bset: '1' }, lockZ: { bset: '0' } },
    );
    const info = response.result;
    const candidate = info?.desc?.trim() || info?.name?.trim();
    return candidate && candidate.length > 0 ? candidate : userName;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      'checkoutUser failed — falling back to the login name',
    );
    return userName;
  }
}

/**
 * Verify ELO credentials and open a session for them.
 *
 * Two stages, because "IX accepted the sign-in" and "the session can do
 * something" are different claims and only the second one is what the user
 * actually needs:
 *
 *   1. `login()` — checks the exception body, not just the status code.
 *   2. One real read on the fresh session, using the same code path the tools
 *      use. An empty result is a pass: it means the call worked and this user
 *      simply sees nothing at the root.
 *
 * Throws `EloLoginError` with a classified `kind`; never leaks the password.
 */
export async function loginElo(userName: string, password: string): Promise<EloUserSession> {
  const client = clientForUser(userName, password);

  try {
    await client.login();
  } catch (err) {
    throw classifyLoginError(err);
  }

  try {
    await runFind(client, findInFolder(ARCHIVE_ROOT_ID, { depth: 1 }), { max: 1 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ detail }, 'ELO sign-in accepted but the session could not read the archive');
    throw new EloLoginError(
      'session-unusable',
      'Die Anmeldung wurde angenommen, aber der Zugriff auf ELO schlägt fehl.',
      detail,
    );
  }

  const displayName = await resolveDisplayName(client, userName);

  evictToFit();
  const now = Date.now();
  const session: EloUserSession = {
    sid: randomToken(24),
    userName,
    displayName,
    client,
    createdAt: now,
    lastUsed: now,
  };
  sessions.set(session.sid, session);
  logger.info(
    { userName, sessions: sessions.size },
    'ELO user session opened',
  );
  return session;
}

/**
 * Look up a live session, refreshing its idle timer.
 *
 * Returns undefined for an unknown or expired handle. Callers must treat that
 * as "authenticate again" and never as "fall back to the technical account" —
 * the latter would silently hand a user permissions they do not have.
 */
export function getEloSession(sid: string): EloUserSession | undefined {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (Date.now() - session.lastUsed > idleTtlMs()) {
    sessions.delete(sid);
    logger.info({ userName: session.userName }, 'ELO user session expired (idle)');
    return undefined;
  }
  session.lastUsed = Date.now();
  return session;
}

export function dropEloSession(sid: string): void {
  const session = sessions.get(sid);
  if (!session) return;
  sessions.delete(sid);
  logger.info({ userName: session.userName }, 'ELO user session dropped');
}

/**
 * Does this error mean the stored credentials stopped working?
 *
 * The case that matters is a password change: `ensureSession()` re-logins
 * behind the scenes every eight minutes, and after a change that re-login
 * fails. Recognising it lets us drop the session so the client is sent back
 * through the login widget instead of failing every call from then on.
 */
export function isStaleCredentialError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ELO login rejected/i.test(message) || /\b3008\b/.test(message);
}

/** Make room for one more session by dropping the least recently used ones. */
function evictToFit(): void {
  const max = config().ELO_MAX_USER_SESSIONS;
  while (sessions.size >= max) {
    let oldestSid: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sid, session] of sessions) {
      if (session.lastUsed < oldestAt) {
        oldestAt = session.lastUsed;
        oldestSid = sid;
      }
    }
    if (!oldestSid) break;
    sessions.delete(oldestSid);
    logger.warn({ max }, 'ELO session cap reached — evicted the least recently used session');
  }
}

export function eloSessionCount(): number {
  return sessions.size;
}

/** Test seam: forget every session. Not used in production code. */
export function resetEloSessions(): void {
  sessions.clear();
}

export function startEloSessionSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const cutoff = Date.now() - idleTtlMs();
    let removed = 0;
    for (const [sid, session] of sessions) {
      if (session.lastUsed < cutoff) {
        sessions.delete(sid);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info({ removed, remaining: sessions.size }, 'ELO user sessions swept');
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
