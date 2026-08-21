import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../utils/runtimeConfig.js';

// Access tokens are self-contained HS256 JWTs, so verifying one costs no
// lookup. They are SIGNED, NOT ENCRYPTED — every claim below is readable by
// whoever holds the token, which is why the ELO credentials stay server-side
// and only the opaque `elo_sid` handle travels.

export interface AccessTokenClaims {
  userName: string;
  displayName: string;
  clientId: string;
  scope?: string;
  /** Notion passes a notion_user_id on /authorize; echoed back for its logs. */
  notionUserId?: string;
  /** Handle into the credential vault (src/authn/eloLogin.ts). */
  eloSid: string;
}

function signingKey(): Uint8Array {
  // Presence is guaranteed by loadConfig() whenever OAuth is enabled.
  return new TextEncoder().encode(config().OAUTH_TOKEN_SECRET!);
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const cfg = config();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    name: claims.displayName,
    client_id: claims.clientId,
    scope: claims.scope ?? 'mcp',
    elo_sid: claims.eloSid,
    idp: 'elo',
    ...(claims.notionUserId ? { notion_user_id: claims.notionUserId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer(cfg.PUBLIC_BASE_URL!)
    .setAudience(cfg.MCP_RESOURCE)
    .setSubject(claims.userName)
    .setJti(randomUUID())
    .setExpirationTime(now + cfg.OAUTH_ACCESS_TOKEN_TTL)
    .sign(signingKey());
}

/**
 * Verify an access token. Throws on anything unacceptable.
 *
 * `algorithms` is pinned so a token claiming `alg: none` — or an RS256 token
 * offering its own key — cannot be substituted. Issuer and audience are
 * enforced by jose, which is what stops a token minted for another deployment
 * sharing the same secret from being replayed here.
 */
export async function verifyAccessTokenJwt(token: string): Promise<JWTPayload> {
  const cfg = config();
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: ['HS256'],
    issuer: cfg.PUBLIC_BASE_URL!,
    audience: cfg.MCP_RESOURCE,
  });
  return payload;
}
