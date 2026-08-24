// End-to-end test of the OAuth 2.1 + DCR flow. No ELO, no network, no test
// framework — a stub IX server, the real MCP server, and node:assert.
//
//   npm run test:oauth
//
// The stub speaks just enough IX to be convincing: it accepts one password,
// answers a wrong one the way IX really does (HTTP 200 with an `exception`
// body, BUGFIXES #1), and records which ELO session made each call. That last
// part is what lets the interesting assertion work — that a tool invoked with
// a user's access token really does run on that user's IX session and not on
// the technical account's.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IX_PORT = Number(process.env.TEST_IX_PORT ?? 13401);
const MCP_PORT = Number(process.env.TEST_OAUTH_PORT ?? 13402);
const BASE = `http://127.0.0.1:${MCP_PORT}`;
// Generous on purpose: on Windows a run that follows a fresh `tsc` competes
// with the virus scanner reading dist/, and a slow boot is not a failure.
const BOOT_TIMEOUT_MS = 25_000;

const SHARED_SECRET = 'shared-' + randomBytes(12).toString('base64url');
const TOKEN_SECRET = randomBytes(32).toString('base64url');
const SESSION_SECRET = randomBytes(32).toString('base64url');
const STATE_KEY = randomBytes(32).toString('base64url');
// A real directory, because the point is that this survives a process restart.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'elo-mcp-state-'));
const STATE_FILE = join(STATE_DIR, 'state.json');
const TECH_USER = 'elo-technical';
const TECH_PASS = 'technical-pw';
const END_USER = 'testuser';
const END_USER_PW = 'correct-horse';
const REDIRECT_URI = 'http://localhost:9911/callback';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean | string): void {
  checks++;
  if (ok === true) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}`);
  console.log(`       ${typeof ok === 'string' ? ok : 'assertion failed'}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Stub IX ----------------------------------------------------------------

interface IxCall {
  endpoint: string;
  /** Which ELO user's session made the call, resolved from JSESSIONID. */
  user: string | undefined;
  /** The Basic Auth account presented to the proxy layer. */
  basicUser: string | undefined;
}

const ixCalls: IxCall[] = [];
const ixSessions = new Map<string, string>();
let ixSessionCounter = 0;

function basicUserOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return undefined;
  return Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')[0];
}

function sessionUserOf(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/JSESSIONID=([^;]+)/);
  return match?.[1] ? ixSessions.get(match[1]) : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const ixServer = createServer(async (req, res) => {
  const endpoint = (req.url ?? '').split('?')[0] ?? '';
  const raw = await readBody(req);
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    /* leave empty */
  }

  const json = (payload: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  if (endpoint.endsWith('/login')) {
    const userName = String(body.userName ?? '');
    const userPwd = String(body.userPwd ?? '');
    ixCalls.push({ endpoint: 'login', user: userName, basicUser: basicUserOf(req) });

    const ok =
      (userName === END_USER && userPwd === END_USER_PW) ||
      (userName === TECH_USER && userPwd === TECH_PASS);
    if (!ok) {
      // Exactly how IX reports it: 200, an exception body, and a cookie for an
      // anonymous session that is of no use to anybody.
      json({
        exception: {
          name: 'IXExceptionC',
          message: '[ELOIX:3008] Unbekannter Benutzer, falsches Passwort oder Konto gesperrt.',
        },
      });
      return;
    }
    const sid = `sess-${++ixSessionCounter}`;
    ixSessions.set(sid, userName);
    json(
      { result: { clientInfo: { ticket: 'de.elo.ix.client.ticket_from_cookie' } } },
      { 'set-cookie': `JSESSIONID=${sid}; Path=/`, 'elo-approved': 'true' },
    );
    return;
  }

  ixCalls.push({
    endpoint: endpoint.split('/').pop() ?? endpoint,
    user: sessionUserOf(req),
    basicUser: basicUserOf(req),
  });

  if (endpoint.endsWith('/findFirstSords')) {
    json({ result: { sords: [], searchId: 'search-1', moreResults: false, estimatedCount: 0 } });
    return;
  }
  if (endpoint.endsWith('/findClose')) {
    json({ result: {} });
    return;
  }
  if (endpoint.endsWith('/checkoutUser')) {
    json({ result: { id: '42', name: END_USER, desc: 'Test User' } });
    return;
  }
  json({ result: {} });
});

// --- Helpers ----------------------------------------------------------------

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Resolves once /health answers, or with the reason it never will. */
async function waitForBoot(child: ChildProcess): Promise<true | string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A crash on startup — a bad env, a port already taken — would otherwise be
    // indistinguishable from a slow boot and get reported as a timeout.
    if (child.exitCode !== null) {
      return `the server exited with code ${child.exitCode} before serving /health`;
    }
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return `no response on /health within ${BOOT_TIMEOUT_MS / 1000}s`;
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    child.on('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function form(path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

async function rpc(token: string, method: string, params: unknown, id = 1): Promise<Response> {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Fetch a fresh login form and return the txn hidden field. */
async function newTxn(clientId: string, challenge: string, state: string): Promise<string> {
  const url =
    `${BASE}/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&state=${encodeURIComponent(state)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp`;
  const html = await (await fetch(url)).text();
  return html.match(/name="txn" value="([^"]+)"/)?.[1] ?? '';
}

// --- Main -------------------------------------------------------------------

/** Boot a server against the shared stub IX, optionally with a different key. */
async function startServer(encryptionKey = STATE_KEY): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: String(MCP_PORT),
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_AUTH_MODE: 'both',
      MCP_SHARED_SECRET: SHARED_SECRET,
      PUBLIC_BASE_URL: BASE,
      // Fixed across restarts: a new signing key would invalidate every token
      // for reasons unrelated to what these checks are about.
      OAUTH_TOKEN_SECRET: TOKEN_SECRET,
      OAUTH_SESSION_SECRET: SESSION_SECRET,
      OAUTH_ACCESS_TOKEN_TTL: '300',
      STATE_FILE,
      STATE_ENCRYPTION_KEY: encryptionKey,
      ELO_BASE_URL: `http://127.0.0.1:${IX_PORT}`,
      ELO_WEBCLIENT_URL: 'https://elo-link.example',
      ELO_USERNAME: TECH_USER,
      ELO_PASSWORD: TECH_PASS,
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const booted = await waitForBoot(child);
  if (booted !== true) throw new Error(`MCP server did not start: ${booted}`);
  return child;
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => ixServer.listen(IX_PORT, '127.0.0.1', resolve));
  console.log(`Stub IX on :${IX_PORT}`);

  let server: ChildProcess;
  try {
    server = await startServer();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    ixServer.close();
    process.exit(1);
  }

  console.log('Running checks:');
  try {
    // --- Discovery ---------------------------------------------------------
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
    check(
      'PRM advertises this server as the resource and itself as the AS',
      (prm.resource === `${BASE}/mcp` && prm.authorization_servers?.[0] === BASE) ||
        `got ${JSON.stringify(prm)}`,
    );

    const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    check(
      'AS metadata names all four endpoints and requires S256',
      (asMeta.issuer === BASE &&
        asMeta.authorization_endpoint === `${BASE}/authorize` &&
        asMeta.token_endpoint === `${BASE}/token` &&
        asMeta.registration_endpoint === `${BASE}/register` &&
        asMeta.code_challenge_methods_supported?.[0] === 'S256') ||
        `got ${JSON.stringify(asMeta)}`,
    );

    const unauth = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
    check(
      '401 carries WWW-Authenticate with resource_metadata (the discovery trigger)',
      (unauth.status === 401 && wwwAuth.includes('resource_metadata=')) ||
        `status ${unauth.status}, header "${wwwAuth}"`,
    );

    // --- Dynamic client registration ---------------------------------------
    const regRes = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'OAuth Flow Test',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      }),
    });
    const registration = await regRes.json();
    const clientId: string = registration.client_id ?? '';
    check(
      'DCR returns 201 with a client_id',
      (regRes.status === 201 && clientId.length > 0) || `status ${regRes.status}`,
    );

    // A client asking to authenticate with a secret must still get registered,
    // as a public one. Refusing left such clients unable to register at all,
    // and a client falling back to a cached client_id then looks — from the
    // server — exactly like one that never registered.
    const confidentialRes = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Confidential Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    const confidential = await confidentialRes.json();
    check(
      'a client asking for a secret is registered as public, not refused',
      (confidentialRes.status === 201 &&
        typeof confidential.client_id === 'string' &&
        // RFC 7591 §3.2.1: tell the client what it actually got.
        confidential.token_endpoint_auth_method === 'none') ||
        `status ${confidentialRes.status}, body ${JSON.stringify(confidential)}`,
    );

    // --- Wrong password ----------------------------------------------------
    const bad = pkcePair();
    const badTxn = await newTxn(clientId, bad.challenge, 'state-bad');
    check('GET /authorize renders the login form', badTxn.length > 0 || 'no txn in the form');

    const wrongPw = await form('/authorize', {
      txn: badTxn,
      userName: END_USER,
      password: 'not-the-password',
    });
    const wrongPwHtml = await wrongPw.text();
    check(
      'wrong password re-renders the form and issues no code',
      (wrongPw.status === 200 &&
        wrongPw.headers.get('location') === null &&
        /Benutzername oder Passwort ist falsch/.test(wrongPwHtml)) ||
        `status ${wrongPw.status}, location ${wrongPw.headers.get('location')}`,
    );
    check(
      'a rejected login opens no ELO session',
      ixCalls.filter((c) => c.endpoint === 'findFirstSords').length === 0 ||
        'the stub saw a search after a failed login',
    );

    // --- The happy path ----------------------------------------------------
    const good = pkcePair();
    const txn = await newTxn(clientId, good.challenge, 'state-good');
    const authorized = await form('/authorize', {
      txn,
      userName: END_USER,
      password: END_USER_PW,
    });
    const location = authorized.headers.get('location') ?? '';
    const redirect = location ? new URL(location) : undefined;
    const code = redirect?.searchParams.get('code') ?? '';
    check(
      'correct password redirects with code, state and iss',
      (authorized.status === 302 &&
        code.length > 0 &&
        redirect?.searchParams.get('state') === 'state-good' &&
        redirect?.searchParams.get('iss') === BASE) ||
        `status ${authorized.status}, location ${location}`,
    );

    // The gotcha this whole design turns on: the end user authenticates to IX,
    // but the proxy in front of it must still see the technical account.
    const userLogin = ixCalls.find((c) => c.endpoint === 'login' && c.user === END_USER);
    check(
      'the user signs in to IX under their own name',
      userLogin !== undefined || 'no login for the end user reached the stub',
    );
    check(
      'Basic Auth still presents the technical account, not the user',
      userLogin?.basicUser === TECH_USER ||
        `Basic Auth user was "${userLogin?.basicUser}" (expected "${TECH_USER}")`,
    );

    const verified = ixCalls.some((c) => c.endpoint === 'findFirstSords' && c.user === END_USER);
    check(
      'sign-in is verified with a real read on the new session',
      verified || 'no findFirstSords ran on the user session during login',
    );

    // --- Token endpoint ----------------------------------------------------
    const wrongVerifier = await form('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkcePair().verifier,
    });
    const wrongVerifierBody = await wrongVerifier.json();
    check(
      'a mismatched PKCE verifier is refused',
      (wrongVerifier.status === 400 && wrongVerifierBody.error === 'invalid_grant') ||
        `status ${wrongVerifier.status}, body ${JSON.stringify(wrongVerifierBody)}`,
    );
    // The code above was spent by that attempt, so run the flow again to get a
    // usable one — which is itself the evidence that codes are single use.
    const second = pkcePair();
    const txn2 = await newTxn(clientId, second.challenge, 'state-2');
    const authorized2 = await form('/authorize', {
      txn: txn2,
      userName: END_USER,
      password: END_USER_PW,
    });
    const code2 =
      new URL(authorized2.headers.get('location') ?? `${BASE}/`).searchParams.get('code') ?? '';

    const tokenRes = await form('/token', {
      grant_type: 'authorization_code',
      code: code2,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: second.verifier,
    });
    const tokens = await tokenRes.json();
    check(
      'token endpoint returns an access and a refresh token',
      (tokenRes.status === 200 &&
        typeof tokens.access_token === 'string' &&
        typeof tokens.refresh_token === 'string' &&
        tokens.token_type === 'Bearer') ||
        `status ${tokenRes.status}, body ${JSON.stringify(tokens)}`,
    );

    const replay = await form('/token', {
      grant_type: 'authorization_code',
      code: code2,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: second.verifier,
    });
    check(
      'replaying an authorization code is refused',
      replay.status === 400 || `status ${replay.status}`,
    );

    const claims = decodeJwtPayload(tokens.access_token);
    check(
      'the access token names the issuer, audience and subject',
      (claims.iss === BASE && claims.aud === `${BASE}/mcp` && claims.sub === END_USER) ||
        `got ${JSON.stringify(claims)}`,
    );
    check(
      'the token carries an opaque session handle and no credentials',
      (typeof claims.elo_sid === 'string' &&
        !JSON.stringify(claims).includes(END_USER_PW)) ||
        'elo_sid missing, or the password leaked into the token',
    );

    // --- Using the token ---------------------------------------------------
    const toolsList = await rpc(tokens.access_token, 'tools/list', {});
    const toolsBody = await toolsList.text();
    const expectedTools = [
      'elo_search',
      'elo_get_metadata',
      'elo_get_document_link',
      'elo_find_project_folder',
      'elo_list_folder',
      'elo_get_document_content',
    ];
    const missing = expectedTools.filter((t) => !toolsBody.includes(t));
    check(
      'tools/list works with the OAuth token',
      (toolsList.status === 200 && missing.length === 0) ||
        `status ${toolsList.status}, missing ${missing.join(', ')}`,
    );

    const callsBefore = ixCalls.length;
    const toolCall = await rpc(tokens.access_token, 'tools/call', {
      name: 'elo_search',
      arguments: { query: 'Vertrag', maxResults: 1 },
    });
    const toolBody = await toolCall.text();
    check(
      'a tool call over the OAuth token succeeds',
      (toolCall.status === 200 && !toolBody.includes('"isError":true')) ||
        `status ${toolCall.status}, body ${toolBody.slice(0, 300)}`,
    );

    const duringCall = ixCalls.slice(callsBefore).filter((c) => c.endpoint === 'findFirstSords');
    check(
      'the tool ran on the USER session, not the technical account',
      (duringCall.length > 0 && duringCall.every((c) => c.user === END_USER)) ||
        `sessions used: ${duringCall.map((c) => c.user).join(', ') || 'none'}`,
    );

    // --- Coexistence with the shared secret --------------------------------
    const sharedBefore = ixCalls.length;
    const sharedCall = await rpc(SHARED_SECRET, 'tools/call', {
      name: 'elo_search',
      arguments: { query: 'Vertrag', maxResults: 1 },
    });
    check(
      'the shared secret still reaches /mcp in mode "both"',
      sharedCall.status === 200 || `status ${sharedCall.status}`,
    );
    const sharedSessions = ixCalls
      .slice(sharedBefore)
      .filter((c) => c.endpoint === 'findFirstSords');
    check(
      'a shared-secret call runs as the technical account',
      (sharedSessions.length > 0 && sharedSessions.every((c) => c.user === TECH_USER)) ||
        `sessions used: ${sharedSessions.map((c) => c.user).join(', ') || 'none'}`,
    );

    // --- Refresh rotation --------------------------------------------------
    const refreshed = await form('/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    const refreshedBody = await refreshed.json();
    check(
      'the refresh grant issues a new pair',
      (refreshed.status === 200 &&
        typeof refreshedBody.access_token === 'string' &&
        refreshedBody.refresh_token !== tokens.refresh_token) ||
        `status ${refreshed.status}, body ${JSON.stringify(refreshedBody)}`,
    );

    const reused = await form('/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    check(
      'the rotated-out refresh token is refused',
      reused.status === 400 || `status ${reused.status}`,
    );

    // --- Token integrity ---------------------------------------------------
    const parts = tokens.access_token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
    const tamperedRes = await rpc(tampered, 'tools/list', {});
    check(
      'a token with a broken signature is refused',
      tamperedRes.status === 401 || `status ${tamperedRes.status}`,
    );

    // A second client registers a different callback. Asking to be redirected
    // to somebody else's registered URI must fail as a page, not as a redirect
    // — sending the error to an unverified URI would be an open redirect.
    const otherRes = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://other.example/cb'] }),
    });
    const other = await otherRes.json();
    const crossUrl =
      `${BASE}/authorize?client_id=${encodeURIComponent(other.client_id)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&state=s&code_challenge=${pkcePair().challenge}` +
      `&code_challenge_method=S256`;
    const cross = await fetch(crossUrl, { redirect: 'manual' });
    const crossHtml = await cross.text();
    check(
      'a client cannot authorize against a redirect_uri it did not register',
      (cross.status === 400 &&
        cross.headers.get('location') === null &&
        !/name="txn"/.test(crossHtml)) ||
        `status ${cross.status}, location ${cross.headers.get('location')}`,
    );

    // --- Surviving a redeploy ----------------------------------------------
    //
    // The regression this section exists for: before persistence, a restart
    // dropped the DCR registrations, and a client that had stored its
    // client_id — Notion and claude.ai both do — got "Diese Anwendung ist
    // nicht (mehr) registriert" on an error page it never saw, so nothing
    // recovered without a human re-adding the connector.
    // Saves ride a one-second coalescing timer. Wait for it rather than lean
    // on the shutdown flush: Windows does not deliver a real SIGTERM to a child
    // killed from another process, so the handler never runs here. It does run
    // in the container, and the check further down covers it where it can.
    await sleep(1_400);
    await stop(server);

    let stateBytes: Buffer;
    try {
      stateBytes = readFileSync(STATE_FILE);
      check('state is written to disk', true);
    } catch {
      stateBytes = Buffer.alloc(0);
      check('state is written to disk', 'no state file was written');
    }
    check(
      'the state file holds no plaintext credentials',
      (stateBytes.length > 0 &&
        !stateBytes.includes(END_USER_PW) &&
        !stateBytes.includes(END_USER) &&
        !stateBytes.includes(tokens.refresh_token)) ||
        'the state file is empty or contains something that should have been encrypted',
    );

    server = await startServer();

    const afterRestart = await fetch(
      `${BASE}/authorize?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code&state=s&code_challenge=${pkcePair().challenge}` +
        `&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    const afterRestartHtml = await afterRestart.text();
    check(
      'a registration survives a restart',
      (afterRestart.status === 200 && /name="txn"/.test(afterRestartHtml)) ||
        `status ${afterRestart.status} — ` +
          (afterRestartHtml.match(/<div class="error">([^<]*)</)?.[1] ?? 'no login form'),
    );

    const restartCallsBefore = ixCalls.length;
    const afterRestartCall = await rpc(refreshedBody.access_token, 'tools/call', {
      name: 'elo_search',
      arguments: { query: 'Vertrag', maxResults: 1 },
    });
    const afterRestartBody = await afterRestartCall.text();
    check(
      'a token issued before the restart still works, with no new login',
      (afterRestartCall.status === 200 && !afterRestartBody.includes('"isError":true')) ||
        `status ${afterRestartCall.status}, body ${afterRestartBody.slice(0, 200)}`,
    );
    const restartSearches = ixCalls
      .slice(restartCallsBefore)
      .filter((c) => c.endpoint === 'findFirstSords');
    check(
      'and it still runs on the user session, not the technical account',
      (restartSearches.length > 0 && restartSearches.every((c) => c.user === END_USER)) ||
        `sessions used: ${restartSearches.map((c) => c.user).join(', ') || 'none'}`,
    );

    // --- Flush on shutdown --------------------------------------------------
    //
    // The reference implementation unrefs its save timer, so the last second
    // before a redeploy is discarded — precisely what a state file is for.
    // Only checkable where SIGTERM is real.
    if (process.platform === 'win32') {
      console.log('  SKIP shutdown flush — Windows does not deliver SIGTERM to a killed child');
    } else {
      const late = await fetch(`${BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Late', redirect_uris: [REDIRECT_URI] }),
      });
      const lateClient = (await late.json()).client_id as string;
      // No sleep: stop inside the coalescing window, so only the flush can save it.
      await stop(server);
      server = await startServer();
      const lateAuth = await fetch(
        `${BASE}/authorize?client_id=${encodeURIComponent(lateClient)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&response_type=code&state=s&code_challenge=${pkcePair().challenge}` +
          `&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      check(
        'a registration made just before shutdown is still flushed',
        lateAuth.status === 200 || `status ${lateAuth.status}`,
      );
    }

    // --- A wrong key must not destroy the file ------------------------------
    await stop(server);
    server = await startServer(randomBytes(32).toString('base64url'));
    const parked = readdirSync(STATE_DIR).filter((f) => f.includes('.unreadable-'));
    check(
      'an unreadable state file is set aside rather than overwritten',
      parked.length === 1 || `found ${parked.length} parked files: ${parked.join(', ')}`,
    );
  } finally {
    await stop(server);
    ixServer.close();
    rmSync(STATE_DIR, { recursive: true, force: true });
  }

  console.log(
    failures === 0 ? `\nAll ${checks} checks passed.` : `\n${failures} of ${checks} checks FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  ixServer.close();
  process.exit(1);
});
