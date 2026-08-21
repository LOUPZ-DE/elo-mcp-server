import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import type { AuthnIdentity } from '../authn/identity.js';

// All authorization-server state lives here, in memory.
//
// That is a deliberate first step, not an oversight: refresh-token records and
// the identities attached to them are the index into the credential vault, and
// writing them to a plain file — as the reference implementation does — would
// put a map of live ELO sessions on the container's disk. Encrypted persistence
// is tracked in issue #4; see docs/oauth-dcr.md.
//
// Consequence to keep in mind: a redeploy drops every registration and every
// session, so clients re-register and users log in again.

/** A client that registered itself via RFC 7591. Public clients only. */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope?: string;
}

/** An authorization request parked while the user is at the login form. */
export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
  /** Notion sends this on /authorize; we echo it into the token as a claim. */
  notionUserId?: string;
  expiresAt: number;
}

/** A minted authorization code, redeemable exactly once. */
export interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
  notionUserId?: string;
  identity: AuthnIdentity;
  expiresAt: number;
}

/** An opaque refresh token. Rotated on every use. */
export interface RefreshToken {
  clientId: string;
  scope?: string;
  resource?: string;
  notionUserId?: string;
  identity: AuthnIdentity;
  expiresAt: number;
}

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const clients = new Map<string, RegisteredClient>();
export const pendingAuths = new Map<string, PendingAuth>();
export const authCodes = new Map<string, AuthCode>();
export const refreshTokens = new Map<string, RefreshToken>();

interface Expiring {
  expiresAt: number;
}

/** Read-through with lazy expiry, so a stale entry is never handed out. */
function getLive<T extends Expiring>(map: Map<string, T>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

export function getPendingAuth(txn: string): PendingAuth | undefined {
  return getLive(pendingAuths, txn);
}

export function getAuthCode(code: string): AuthCode | undefined {
  return getLive(authCodes, code);
}

export function getRefreshToken(token: string): RefreshToken | undefined {
  return getLive(refreshTokens, token);
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return clients.get(clientId);
}

/**
 * Register a client, evicting the oldest registration once the cap is reached.
 *
 * Registration is unauthenticated by design (RFC 7591 §3.1 and how every MCP
 * client expects it to work), so the map needs a ceiling — otherwise anyone who
 * can reach the endpoint can grow it without bound.
 */
export function addClient(client: RegisteredClient): void {
  const max = config().OAUTH_MAX_CLIENTS;
  while (clients.size >= max) {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of clients) {
      if (entry.client_id_issued_at < oldestAt) {
        oldestAt = entry.client_id_issued_at;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    clients.delete(oldestId);
    logger.warn({ clientId: oldestId, max }, 'DCR client cap reached — evicted oldest registration');
  }
  clients.set(client.client_id, client);
}

function sweepExpired<T extends Expiring>(map: Map<string, T>): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Periodic sweep. `getLive` already hides expired entries from callers; this
 * only stops abandoned ones (a login the user never finished) from accumulating.
 */
export function startStoreSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const removed =
      sweepExpired(pendingAuths) + sweepExpired(authCodes) + sweepExpired(refreshTokens);
    if (removed > 0) {
      logger.debug({ removed }, 'OAuth store sweep');
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open just to run a cleanup timer.
  timer.unref();
  return timer;
}
