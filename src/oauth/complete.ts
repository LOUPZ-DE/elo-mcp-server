import type { Response } from 'express';
import { config } from '../utils/runtimeConfig.js';
import { logger } from '../utils/logger.js';
import { authCodes, AUTH_CODE_TTL_MS, type PendingAuth } from './store.js';
import { randomToken } from './pkce.js';
import type { AuthnIdentity } from '../authn/identity.js';

/**
 * The seam between "who is this person" and "issue them a token".
 *
 * Every login method ends here: once an `AuthnIdentity` exists, this mints the
 * authorization code and redirects back to the client. Everything before it —
 * how the user proved who they are — is replaceable. Everything after it —
 * code, token, JWT, MCP — is not touched by that choice.
 */
export function completeAuthorization(
  res: Response,
  pending: PendingAuth,
  identity: AuthnIdentity,
): void {
  const code = randomToken(32);
  authCodes.set(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scope: pending.scope,
    resource: pending.resource,
    notionUserId: pending.notionUserId,
    identity,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  if (pending.state !== undefined) url.searchParams.set('state', pending.state);
  // RFC 9207: naming the issuer lets the client detect a code injected from a
  // different authorization server.
  url.searchParams.set('iss', config().PUBLIC_BASE_URL!);

  logger.info(
    { clientId: pending.clientId, userName: identity.userName },
    'Authorization code issued',
  );
  res.set('Cache-Control', 'no-store').redirect(302, url.toString());
}
