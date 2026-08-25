import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getEloSession } from '../authn/eloLogin.js';
import { SHARED_SECRET_CLIENT_ID } from '../oauth/verifier.js';

// Answers "whose ELO permissions am I seeing?".
//
// That question is not idle here. With MCP_AUTH_MODE=both the same endpoint
// serves two very different callers: an OAuth user running under their own ELO
// rights, and an API-key caller running under the technical account. A search
// returning nothing means something different in each case, and until now
// nothing in the protocol let anyone tell which one they were.

export interface WhoAmIOptions {
  /** ELO_USERNAME — the account API-key callers act as. */
  technicalUser: string;
  /** Configured MCP_AUTH_MODE, so the answer explains what else is possible. */
  authMode: 'shared' | 'oauth' | 'both';
}

export interface WhoAmIResult {
  /** 'elo-user' when someone signed in; 'service-account' for the shared secret. */
  identity: 'elo-user' | 'service-account';
  eloUser: string;
  displayName?: string;
  /** Plain-language statement of what the permissions actually are. */
  note: string;
  authMode: string;
  oauthClientId?: string;
  scopes?: string[];
  tokenExpiresAt?: string;
  /** Notion passes this through the authorization request; echoed for support. */
  notionUserId?: string;
  sessionOpenedAt?: string;
  sessionLastUsedAt?: string;
}

function asIso(seconds: number | undefined): string | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : undefined;
}

export function eloWhoAmI(
  authInfo: AuthInfo | undefined,
  opts: WhoAmIOptions,
): WhoAmIResult {
  const extra = authInfo?.extra ?? {};
  const eloSid = typeof extra.eloSid === 'string' ? extra.eloSid : undefined;

  // No sid means the caller authenticated with the shared secret, or over
  // stdio where there is no bearer token at all.
  if (!eloSid) {
    return {
      identity: 'service-account',
      eloUser: opts.technicalUser,
      note:
        `This connection is not signed in as a person. Tool calls run as the technical ELO account "${opts.technicalUser}", ` +
        'so results reflect that account\'s permissions rather than any individual\'s.' +
        (opts.authMode === 'both'
          ? ' To act under your own ELO rights, reconnect using "Sign in with OAuth" instead of an API key.'
          : ''),
      authMode: opts.authMode,
      ...(authInfo && authInfo.clientId !== SHARED_SECRET_CLIENT_ID
        ? { oauthClientId: authInfo.clientId }
        : {}),
    };
  }

  const session = getEloSession(eloSid);
  const userName =
    session?.userName ?? (typeof extra.userName === 'string' ? extra.userName : 'unknown');
  const displayName =
    session?.displayName ?? (typeof extra.displayName === 'string' ? extra.displayName : undefined);

  return {
    identity: 'elo-user',
    eloUser: userName,
    displayName,
    note:
      `Signed in as the ELO user "${userName}". Every search, listing and document read runs under that account's ELO permissions, ` +
      'so anything invisible to them is invisible here — "not found" does not mean "does not exist".',
    authMode: opts.authMode,
    oauthClientId: authInfo?.clientId,
    scopes: authInfo?.scopes,
    tokenExpiresAt: asIso(authInfo?.expiresAt),
    ...(typeof extra.notionUserId === 'string' ? { notionUserId: extra.notionUserId } : {}),
    ...(session
      ? {
          sessionOpenedAt: new Date(session.createdAt).toISOString(),
          sessionLastUsedAt: new Date(session.lastUsed).toISOString(),
        }
      : {}),
  };
}
