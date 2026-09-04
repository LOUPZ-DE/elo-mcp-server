import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { SHARED_SECRET_CLIENT_ID } from '../oauth/verifier.js';
import { getEloSession, type EloUserSession } from '../authn/eloLogin.js';
import { WriteRefusedError } from './errors.js';

/**
 * The one gate every write goes through: is there a real person behind this call?
 *
 * This deliberately does NOT reuse `withEloClient` from src/index.ts. That
 * helper resolves an identity to a client and falls back to the technical
 * account whenever there is no `eloSid` — which is correct for reads, and which
 * makes it blind to the distinction that matters here: a shared-secret caller
 * and a stdio caller both arrive without an `eloSid` and both get the service
 * account. For writes those two must be refused, and refused with different
 * words, so the check has to look at `AuthInfo` itself before any client exists.
 *
 * There is no fallback of any kind. If this throws, nothing is written.
 */
export function requireEloUser(authInfo: AuthInfo | undefined): EloUserSession {
  if (!authInfo) {
    // stdio, or any transport that carries no bearer token at all.
    throw new WriteRefusedError(
      'Writing to ELO needs a signed-in ELO account, and this connection has no identity. ' +
        'Connect over HTTP with OAuth and sign in.',
    );
  }

  if (authInfo.clientId === SHARED_SECRET_CLIENT_ID) {
    throw new WriteRefusedError(
      'The shared API key is read-only. It acts as the technical ELO account, so a write through it ' +
        'would be attributed to that account rather than to a person — reconnect with "Sign in with OAuth" ' +
        'to write under your own ELO permissions.',
    );
  }

  const sid = typeof authInfo.extra?.eloSid === 'string' ? authInfo.extra.eloSid : undefined;
  if (!sid) {
    throw new WriteRefusedError(
      'This token carries no ELO session, so there is no account to write as. Sign in again.',
    );
  }

  const session = getEloSession(sid);
  if (!session) {
    // The bearer verifier normally rejects this first; reaching here means the
    // session lapsed between the token check and this call.
    throw new WriteRefusedError('Your ELO session has expired. Sign in again before writing.');
  }

  return session;
}
