import { timingSafeEqual } from 'node:crypto';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { config } from '../utils/runtimeConfig.js';
import { getEloSession } from '../authn/eloLogin.js';
import { verifyAccessTokenJwt } from './jwt.js';

// The single place where the two ways of reaching /mcp meet.
//
// Both branches produce an `AuthInfo`. `requireBearerAuth` puts it on
// `req.auth`, the streamable-HTTP transport reads it off there and hands it to
// every tool callback as `extra.authInfo`. So the difference between "an API
// key called us" and "a signed-in ELO user called us" reduces to whether
// `extra.eloSid` is set — which is all src/index.ts has to look at.

/** Marks a caller that authenticated with the shared secret, not as a person. */
export const SHARED_SECRET_CLIENT_ID = 'shared-secret';

function matchesSharedSecret(token: string): boolean {
  const secret = config().MCP_SHARED_SECRET;
  if (!secret) return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export class McpTokenVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const cfg = config();

    // --- Branch 1: the existing API key -------------------------------------
    if (cfg.sharedSecretEnabled && matchesSharedSecret(token)) {
      return {
        token,
        clientId: SHARED_SECRET_CLIENT_ID,
        scopes: ['mcp'],
        // requireBearerAuth insists on a numeric expiry and rejects the token
        // without one. A shared secret does not expire; this is a placeholder
        // far enough out never to bite, not a lifetime.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        // No eloSid: tool calls on this path run as the technical account,
        // exactly as they did before OAuth existed.
        extra: {},
      };
    }

    if (!cfg.oauthEnabled) {
      throw new InvalidTokenError('Invalid token');
    }

    // --- Branch 2: an access token we minted ---------------------------------
    let payload;
    try {
      payload = await verifyAccessTokenJwt(token);
    } catch (err) {
      throw new InvalidTokenError(
        `Token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof payload.exp !== 'number') {
      throw new InvalidTokenError('Token has no exp claim');
    }

    const eloSid = typeof payload.elo_sid === 'string' ? payload.elo_sid : undefined;
    if (!eloSid || !getEloSession(eloSid)) {
      // The signature is fine but the ELO session behind it is gone — idle
      // expiry, an evicted entry, or a container restart.
      //
      // This has to be a 401 and NOT a fall back to the technical account:
      // silently serving the request under different permissions would hand
      // the user access they never had. A 401 carries WWW-Authenticate, so the
      // client re-runs the flow and the user simply signs in again.
      throw new InvalidTokenError('The ELO session for this token no longer exists');
    }

    return {
      token,
      clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      expiresAt: payload.exp,
      resource: new URL(cfg.MCP_RESOURCE),
      extra: {
        eloSid,
        userName: typeof payload.sub === 'string' ? payload.sub : undefined,
        displayName: typeof payload.name === 'string' ? payload.name : undefined,
        notionUserId:
          typeof payload.notion_user_id === 'string' ? payload.notion_user_id : undefined,
      },
    };
  }
}
