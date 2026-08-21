import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import { getEloSession } from '../authn/eloLogin.js';
import type { AuthnIdentity } from '../authn/identity.js';
import { authCodes, getAuthCode, getRefreshToken, refreshTokens } from './store.js';
import { randomToken, verifyS256 } from './pkce.js';
import { signAccessToken } from './jwt.js';

function firstParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function tokenError(res: Response, error: string, description: string, status = 400): void {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .json({ error, error_description: description });
}

interface GrantContext {
  clientId: string;
  identity: AuthnIdentity;
  scope?: string;
  resource?: string;
  notionUserId?: string;
}

async function issueTokenPair(res: Response, ctx: GrantContext): Promise<void> {
  const cfg = config();
  const accessToken = await signAccessToken({
    userName: ctx.identity.userName,
    displayName: ctx.identity.displayName,
    clientId: ctx.clientId,
    scope: ctx.scope,
    notionUserId: ctx.notionUserId,
    eloSid: ctx.identity.eloSid,
  });

  // Opaque and stored server-side, unlike the access token: a refresh token
  // has to be revocable, and rotation needs somewhere to record that the
  // previous one is spent.
  const refreshToken = randomToken(32);
  refreshTokens.set(refreshToken, {
    clientId: ctx.clientId,
    scope: ctx.scope,
    resource: ctx.resource,
    notionUserId: ctx.notionUserId,
    identity: ctx.identity,
    expiresAt: Date.now() + cfg.OAUTH_REFRESH_TOKEN_TTL * 1000,
  });

  res.status(200).set('Cache-Control', 'no-store').json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: cfg.OAUTH_ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: ctx.scope ?? 'mcp',
  });
}

export async function tokenHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = firstParam(body.grant_type);
  const clientId = firstParam(body.client_id);

  if (grantType === 'authorization_code') {
    const code = firstParam(body.code);
    const redirectUri = firstParam(body.redirect_uri);
    const codeVerifier = firstParam(body.code_verifier);

    if (!code || !redirectUri || !clientId || !codeVerifier) {
      tokenError(
        res,
        'invalid_request',
        'code, redirect_uri, client_id and code_verifier are required',
      );
      return;
    }

    // Consume the code before validating anything else, so a failed attempt
    // cannot be retried against the same code.
    const stored = getAuthCode(code);
    authCodes.delete(code);

    if (!stored) {
      tokenError(res, 'invalid_grant', 'Authorization code is unknown or expired');
      return;
    }
    if (stored.clientId !== clientId) {
      tokenError(res, 'invalid_grant', 'client_id does not match the authorization code');
      return;
    }
    if (stored.redirectUri !== redirectUri) {
      tokenError(res, 'invalid_grant', 'redirect_uri differs from the authorization request');
      return;
    }
    if (!verifyS256(codeVerifier, stored.codeChallenge)) {
      logger.warn({ clientId }, 'Token: PKCE verification failed');
      tokenError(res, 'invalid_grant', 'PKCE verification failed');
      return;
    }
    // The ELO session is what the token is worth. If it went away between the
    // login and this call, minting a token would only produce 401s later.
    if (!getEloSession(stored.identity.eloSid)) {
      tokenError(res, 'invalid_grant', 'The ELO session has expired — please sign in again');
      return;
    }

    logger.info({ clientId, userName: stored.identity.userName }, 'Token: authorization_code grant');
    await issueTokenPair(res, {
      clientId,
      identity: stored.identity,
      scope: stored.scope,
      resource: stored.resource,
      notionUserId: stored.notionUserId,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = firstParam(body.refresh_token);
    if (!refreshToken || !clientId) {
      tokenError(res, 'invalid_request', 'refresh_token and client_id are required');
      return;
    }

    const stored = getRefreshToken(refreshToken);
    if (!stored || stored.clientId !== clientId) {
      tokenError(res, 'invalid_grant', 'refresh_token is unknown, expired, or issued to another client');
      return;
    }
    if (!getEloSession(stored.identity.eloSid)) {
      // Idle expiry or a restart. Dropping the refresh token too means the
      // client stops retrying and runs the authorization flow again, which is
      // what actually gets the user working.
      refreshTokens.delete(refreshToken);
      tokenError(res, 'invalid_grant', 'The ELO session has expired — please sign in again');
      return;
    }

    // Rotation: the presented token is spent, whatever happens next.
    refreshTokens.delete(refreshToken);
    logger.info({ clientId, userName: stored.identity.userName }, 'Token: refresh_token grant (rotated)');
    await issueTokenPair(res, {
      clientId,
      identity: stored.identity,
      scope: stored.scope,
      resource: stored.resource,
      notionUserId: stored.notionUserId,
    });
    return;
  }

  tokenError(
    res,
    'unsupported_grant_type',
    'Only authorization_code and refresh_token are supported',
  );
}
