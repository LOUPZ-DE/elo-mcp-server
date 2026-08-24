import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import { registerSlice, scheduleSave } from '../utils/stateFile.js';
import type { AuthnIdentity } from '../authn/identity.js';

// Authorization-server state. Held in memory and, when STATE_FILE is
// configured, mirrored into an encrypted file so a redeploy does not wipe it.
//
// The registrations are what made persistence necessary: a client that stored
// its client_id — Notion and claude.ai both do — hits an error page at
// /authorize after a restart, and because that page renders in the browser
// rather than reaching the client, nothing recovers on its own.
//
// Refresh tokens ride along because they are only useful while the ELO session
// behind them is alive, and that session is persisted too. Authorization codes
// and pending logins are not: both expire faster than a restart takes.

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
  const before = refreshTokens.size;
  const found = getLive(refreshTokens, token);
  // getLive drops the entry when it has expired; persist that removal so a
  // spent token cannot come back from the file after a restart.
  if (refreshTokens.size !== before) scheduleSave();
  return found;
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
  scheduleSave();
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
    const ephemeral = sweepExpired(pendingAuths) + sweepExpired(authCodes);
    const persisted = sweepExpired(refreshTokens);
    if (persisted > 0) scheduleSave();
    if (ephemeral + persisted > 0) {
      logger.debug({ removed: ephemeral + persisted }, 'OAuth store sweep');
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open just to run a cleanup timer.
  timer.unref();
  return timer;
}

// --- Persistence -------------------------------------------------------------

const RegisteredClientSchema = z.object({
  client_id: z.string().min(1),
  client_id_issued_at: z.number(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()).min(1),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.literal('none'),
  scope: z.string().optional(),
});

const AuthnIdentitySchema = z.object({
  userName: z.string().min(1),
  displayName: z.string(),
  idp: z.string(),
  eloSid: z.string().min(1),
});

const RefreshTokenSchema = z.object({
  clientId: z.string().min(1),
  scope: z.string().optional(),
  resource: z.string().optional(),
  notionUserId: z.string().optional(),
  identity: AuthnIdentitySchema,
  expiresAt: z.number(),
});

const OAuthStateSchema = z.object({
  clients: z.array(z.tuple([z.string(), RegisteredClientSchema])),
  refreshTokens: z.array(z.tuple([z.string(), RefreshTokenSchema])),
});

type OAuthState = z.infer<typeof OAuthStateSchema>;

// Validated rather than cast. The file is encrypted and authenticated, so a
// mismatch here means our own format drifted — but a blind cast would turn that
// into confusing failures much later, and this is cheap.
registerSlice<OAuthState>({
  name: 'oauth',
  serialise: () => ({
    clients: [...clients],
    refreshTokens: [...refreshTokens],
  }),
  parse: (data) => OAuthStateSchema.parse(data),
  apply: (state) => {
    for (const [id, client] of state.clients) clients.set(id, client);
    const now = Date.now();
    let expired = 0;
    for (const [token, record] of state.refreshTokens) {
      if (record.expiresAt > now) refreshTokens.set(token, record);
      else expired++;
    }
    logger.info(
      { clients: clients.size, refreshTokens: refreshTokens.size, expiredSkipped: expired },
      'OAuth state restored',
    );
  },
});
