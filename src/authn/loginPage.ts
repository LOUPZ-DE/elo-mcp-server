import type { Response } from 'express';
import { config } from '../utils/runtimeConfig.js';
import { escapeHtml, page } from '../utils/html.js';

export interface LoginPageOpts {
  /** Handle for the parked authorization request. The only state in the form. */
  txn: string;
  clientName?: string;
  scope?: string;
  /** Already user-facing German; classified in src/authn/eloLogin.ts. */
  error?: string;
  /** Keep the typed name across a failed attempt; never the password. */
  userName?: string;
}

/**
 * The login widget.
 *
 * Note what is *not* in the form: redirect_uri, state, code_challenge, scope
 * and resource all stay server-side under `txn`. Nothing a browser posts back
 * can influence where the authorization code is delivered.
 */
export function renderLoginPage(res: Response, opts: LoginPageOpts): void {
  const client = opts.clientName ?? 'Ein MCP-Client';
  const body = `
    <h1>ELO-Anmeldung</h1>
    <p class="sub">${escapeHtml(client)} möchte in Ihrem Namen auf das ELO-Archiv zugreifen.${
      opts.scope ? ` Berechtigung: <code>${escapeHtml(opts.scope)}</code>.` : ''
    }</p>
    <form method="post" action="/authorize" accept-charset="utf-8" autocomplete="on">
      <input type="hidden" name="txn" value="${escapeHtml(opts.txn)}">
      <label for="userName">ELO-Benutzername</label>
      <input id="userName" name="userName" type="text" required autocapitalize="none"
             spellcheck="false" autocomplete="username"
             value="${escapeHtml(opts.userName ?? '')}" ${opts.userName ? '' : 'autofocus'}>
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" required
             autocomplete="current-password" ${opts.userName ? 'autofocus' : ''}>
      <button type="submit">Anmelden und freigeben</button>
    </form>
    ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
    <div class="meta">${escapeHtml(config().OAUTH_SERVER_NAME)} · Zugriff mit Ihren ELO-Rechten</div>`;

  res
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .status(200)
    .send(page('ELO-Anmeldung', body));
}
