import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { config } from '../utils/runtimeConfig.js';
import { renderErrorPage } from '../utils/html.js';
import { renderLoginPage } from '../authn/loginPage.js';
import { getSession, setSession, clearSession } from '../authn/session.js';
import { EloLoginError, getEloSession, loginElo } from '../authn/eloLogin.js';
import { getClient, getPendingAuth, pendingAuths, PENDING_TTL_MS, type PendingAuth } from './store.js';
import { randomToken } from './pkce.js';
import { completeAuthorization } from './complete.js';

function firstParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Report an error by redirecting back to the client.
 *
 * Only ever called once `redirect_uri` has been matched against the
 * registration — before that point an error must be rendered as a page,
 * because sending it to an unverified URI is an open redirect.
 */
function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state?: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', config().PUBLIC_BASE_URL!);
  res.set('Cache-Control', 'no-store').redirect(302, url.toString());
}

export function authorizeGetHandler(req: Request, res: Response): void {
  const query = req.query;
  const clientId = firstParam(query.client_id);
  const redirectUri = firstParam(query.redirect_uri);
  const responseType = firstParam(query.response_type);
  const state = firstParam(query.state);
  const codeChallenge = firstParam(query.code_challenge);
  const codeChallengeMethod = firstParam(query.code_challenge_method);
  const scope = firstParam(query.scope);
  const resource = firstParam(query.resource);
  // Notion sends this so it can correlate the grant with its own user.
  const notionUserId = firstParam(query.notion_user_id);

  if (!clientId) {
    renderErrorPage(res, 400, 'Ungültige Anfrage', 'Der Parameter client_id fehlt.');
    return;
  }
  const client = getClient(clientId);
  if (!client) {
    renderErrorPage(
      res,
      400,
      'Ungültige Anfrage',
      'Diese Anwendung ist nicht (mehr) registriert. Bitte die Verbindung im MCP-Client neu einrichten.',
    );
    return;
  }

  // Exact string match against the registered URIs — no prefix matching, no
  // normalisation. This is the check that keeps a stolen client_id from
  // redirecting codes somewhere else.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    renderErrorPage(
      res,
      400,
      'Ungültige Anfrage',
      'Die redirect_uri fehlt oder ist für diese Anwendung nicht registriert.',
    );
    return;
  }

  // Past this point the redirect target is trusted, so errors may go there.
  if (responseType !== 'code') {
    redirectWithError(res, redirectUri, 'unsupported_response_type', 'Only response_type=code is supported', state);
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    redirectWithError(res, redirectUri, 'invalid_request', 'PKCE with code_challenge_method=S256 is required', state);
    return;
  }

  // RFC 8707. Logged rather than rejected: clients differ on whether they send
  // the bare origin, the /mcp URL or a trailing slash, and refusing the flow
  // over that would be an opaque dead end. The audience we mint is always
  // MCP_RESOURCE regardless of what was asked for, so this cannot widen it.
  if (resource && resource !== config().MCP_RESOURCE) {
    logger.warn(
      { resource, expected: config().MCP_RESOURCE, clientId },
      'Authorize: resource parameter differs from MCP_RESOURCE',
    );
  }

  const pending: PendingAuth = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scope,
    resource,
    notionUserId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };

  // Already signed in? Only skip the form when the ELO session behind the
  // cookie is still live — otherwise the code would be redeemed for a token
  // whose vault entry no longer exists, and every tool call would 401.
  const session = getSession(req);
  if (session && getEloSession(session.eloSid)) {
    completeAuthorization(res, pending, session);
    return;
  }
  if (session) clearSession(res);

  const txn = randomToken(24);
  pendingAuths.set(txn, pending);
  renderLoginPage(res, { txn, clientName: client.client_name, scope });
}

export async function authorizePostHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const txn = typeof body.txn === 'string' ? body.txn : undefined;
  const userName = typeof body.userName === 'string' ? body.userName.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const pending = txn ? getPendingAuth(txn) : undefined;
  if (!txn || !pending) {
    renderErrorPage(
      res,
      400,
      'Anfrage abgelaufen',
      'Diese Anmeldung ist abgelaufen oder unbekannt. Bitte starten Sie die Verbindung im MCP-Client erneut.',
    );
    return;
  }
  const client = getClient(pending.clientId);

  const reject = (message: string): void => {
    renderLoginPage(res, {
      txn,
      clientName: client?.client_name,
      scope: pending.scope,
      error: message,
      userName,
    });
  };

  if (!userName || !password) {
    reject('Bitte Benutzername und Passwort eingeben.');
    return;
  }

  let session;
  try {
    session = await loginElo(userName, password);
  } catch (err) {
    if (err instanceof EloLoginError) {
      // The failure kind is logged, the attempted user name is not: a typo in
      // the name field would otherwise write someone's password into the log.
      logger.warn({ kind: err.kind, detail: err.detail }, 'ELO login attempt failed');
      reject(err.message);
      return;
    }
    logger.error({ err }, 'Unexpected error during ELO login');
    reject('Unerwarteter Fehler bei der Anmeldung. Bitte erneut versuchen.');
    return;
  }

  // Single use: the parked request is consumed whether or not the redirect
  // below succeeds.
  pendingAuths.delete(txn);

  const identity = {
    userName: session.userName,
    displayName: session.displayName,
    idp: 'elo',
    eloSid: session.sid,
  };
  setSession(res, identity);
  completeAuthorization(res, pending, identity);
}
