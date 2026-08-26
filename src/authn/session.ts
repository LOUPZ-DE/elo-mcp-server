import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../utils/runtimeConfig.js';
import type { AuthnIdentity } from './identity.js';

// A signed browser cookie so a user who authorises a second MCP client does not
// have to type their password again. It carries the identity, not the
// credentials — the credentials live only in the vault keyed by `eloSid`.
//
// Signed, not encrypted: anyone holding the cookie can read the name inside it.
// That is acceptable for what it contains and is why nothing sensitive goes in.
//
// No cookie-parser dependency; one header, parsed by hand.

const COOKIE_NAME = 'elo_mcp_session';

interface SessionData extends AuthnIdentity {
  /** Unix seconds. */
  exp: number;
}

function sign(payload: string): string {
  return createHmac('sha256', config().OAUTH_SESSION_SECRET!).update(payload).digest('base64url');
}

// The browser cookie stays short regardless of the vault lifetime. The vault
// TTL is raised to match the refresh token (30 days) so Notion connectors
// survive; that TTL must NOT leak into client-side cookies — a month-long
// SSO cookie on a laptop is a different risk than server-side state. An
// expired cookie only forces one more login, not a broken connector.
const BROWSER_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

export function setSession(res: Response, identity: AuthnIdentity): void {
  // Deliberately decoupled from ELO_USER_SESSION_TTL: see the constant above.
  const maxAge = BROWSER_COOKIE_MAX_AGE_SECONDS;
  const data: SessionData = { ...identity, exp: Math.floor(Date.now() / 1000) + maxAge };
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const parts = [
    `${COOKIE_NAME}=${payload}.${sign(payload)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  // Only mark Secure on HTTPS — a Secure cookie is dropped outright over plain
  // HTTP, which would break local development without any visible reason.
  if (config().PUBLIC_BASE_URL?.startsWith('https://')) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSession(res: Response): void {
  res.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function getSession(req: Request): AuthnIdentity | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== COOKIE_NAME) continue;

    const value = pair.slice(eq + 1).trim();
    // base64url never contains a dot, so the last one is the separator.
    const lastDot = value.lastIndexOf('.');
    if (lastDot === -1) return undefined;

    const payload = value.slice(0, lastDot);
    const provided = Buffer.from(value.slice(lastDot + 1));
    const expected = Buffer.from(sign(payload));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return undefined;
    }

    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionData;
      if (!Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return undefined;
      if (
        typeof data.userName !== 'string' ||
        typeof data.displayName !== 'string' ||
        typeof data.idp !== 'string' ||
        typeof data.eloSid !== 'string'
      ) {
        return undefined;
      }
      return {
        userName: data.userName,
        displayName: data.displayName,
        idp: data.idp,
        eloSid: data.eloSid,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
