// Smoke test for the HTTP transport. Boots the server with a test secret,
// runs through health/auth/initialize/tools/list against the live port, then
// shuts it down. Optionally also exercises an actual tool call when ELO env
// vars are configured.
//
// Usage:  npm run test:http
//
// Exit code 0 on all-pass, 1 on any failure.

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.TEST_HTTP_PORT ?? 13000);
const SECRET = 'test-' + Math.random().toString(36).slice(2);
const BASE = `http://127.0.0.1:${PORT}`;
// 8 s was occasionally too short on Windows when the run follows a fresh `tsc`
// and the virus scanner is still reading dist/. A slow boot is not a failure
// worth reporting; a crashed one is, and waitForBoot now tells them apart.
const BOOT_TIMEOUT_MS = 25_000;

let failures = 0;

async function check(
  label: string,
  request: () => Promise<Response>,
  expect: (r: Response, body: string) => boolean | string,
): Promise<void> {
  process.stdout.write(`  ${label} … `);
  try {
    const r = await request();
    const body = await r.text();
    const result = expect(r, body);
    if (result === true) {
      console.log(`OK (${r.status})`);
    } else {
      const reason = typeof result === 'string' ? result : `status=${r.status}`;
      console.log(`FAIL — ${reason}`);
      if (body) console.log(`     body: ${body.slice(0, 200)}`);
      failures += 1;
    }
  } catch (err) {
    console.log(`ERROR — ${err instanceof Error ? err.message : String(err)}`);
    failures += 1;
  }
}

function jsonRpc(method: string, params: unknown, id: number, auth = SECRET): Promise<Response> {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

/** Resolves once /health answers, or with the reason it never will. */
async function waitForBoot(child: ChildProcess): Promise<true | string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A server that exited will never answer, so stop waiting on it and report
    // the exit code — otherwise a crash on startup looks exactly like slowness.
    if (child.exitCode !== null) {
      return `the server exited with code ${child.exitCode} before serving /health`;
    }
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return `no response on /health within ${BOOT_TIMEOUT_MS / 1000}s`;
}

function stop(server: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
    }, 1500);
  });
}

async function main(): Promise<void> {
  console.log(`Booting server on :${PORT} …`);

  const server = spawn(
    process.execPath,
    ['dist/index.js'],
    {
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_HTTP_PORT: String(PORT),
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_SHARED_SECRET: SECRET,
        // Allow boot without real ELO creds; tool calls will fail but the
        // transport-level tests don't need them.
        ELO_BASE_URL: process.env.ELO_BASE_URL ?? 'https://example.com/ix-test',
        ELO_WEBCLIENT_URL:
          process.env.ELO_WEBCLIENT_URL ?? 'https://example.com',
        ELO_USERNAME: process.env.ELO_USERNAME ?? 'test',
        ELO_PASSWORD: process.env.ELO_PASSWORD ?? 'test',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );

  const booted = await waitForBoot(server);
  if (booted !== true) {
    console.error(`Server did not start: ${booted}.`);
    await stop(server);
    process.exit(1);
  }

  console.log('Running checks:');

  await check(
    'GET /health → 200',
    () => fetch(`${BASE}/health`),
    (r) => r.status === 200,
  );

  await check(
    'POST /mcp without Authorization → 401',
    () =>
      fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    (r) => r.status === 401,
  );

  // MCP_AUTH_MODE is unset here, so the server is in its default 'shared' mode.
  // The next three checks are the promise that adding OAuth changed nothing for
  // an existing deployment: no new public endpoints, and no advertisement of an
  // authorization server that is not running. The OAuth flow itself is covered
  // end to end by scripts/test-oauth.ts.
  await check(
    'default mode: no protected-resource document is published',
    () => fetch(`${BASE}/.well-known/oauth-protected-resource`),
    (r) => r.status === 404 || `expected 404, got ${r.status}`,
  );

  await check(
    'default mode: dynamic client registration is not exposed',
    () =>
      fetch(`${BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"redirect_uris":["https://example.com/cb"]}',
      }),
    (r) => r.status === 404 || `expected 404, got ${r.status}`,
  );

  await check(
    'default mode: 401 states the scheme but points at no authorization server',
    () =>
      fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    (r) => {
      const header = r.headers.get('www-authenticate') ?? '';
      if (!header.startsWith('Bearer')) return `WWW-Authenticate was "${header}"`;
      if (header.includes('resource_metadata')) {
        return 'shared mode must not advertise resource_metadata';
      }
      return true;
    },
  );

  await check(
    'POST /mcp with wrong Bearer → 401',
    () =>
      fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{}',
      }),
    (r) => r.status === 401,
  );

  await check(
    'POST /mcp initialize → 200',
    () =>
      jsonRpc(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-http', version: '0.0.0' },
        },
        1,
      ),
    (r) => r.status === 200,
  );

  await check(
    'POST /mcp tools/list returns all ELO tools',
    () => jsonRpc('tools/list', {}, 2),
    (r, body) => {
      if (r.status !== 200) return `status=${r.status}`;
      // Streamable HTTP returns either JSON or SSE-framed text; both contain
      // the tool names verbatim.
      const needed = [
        'elo_search',
        'elo_get_metadata',
        'elo_get_document_link',
        'elo_find_project_folder',
        'elo_list_folder',
        'elo_get_document_content',
      ];
      const missing = needed.filter((n) => !body.includes(n));
      return missing.length === 0 || `missing tools: ${missing.join(', ')}`;
    },
  );

  // The link policy lives in prose — in the server instructions and the tool
  // descriptions. That prose is the actual fix for "sometimes the wrong ELO
  // link", so it gets a regression test like any other behaviour.
  await check(
    'initialize carries the verbatim-link instructions',
    () =>
      jsonRpc(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-http', version: '0.0.0' } },
        11,
      ),
    (r, body) => {
      if (r.status !== 200) return `status=${r.status}`;
      if (!body.includes('instructions')) return 'no instructions field';
      if (!body.includes('VERBATIM')) return 'instructions do not demand verbatim links';
      return true;
    },
  );

  await check(
    'tool descriptions steer scoping and forbid link construction',
    () => jsonRpc('tools/list', {}, 12),
    (r, body) => {
      if (r.status !== 200) return `status=${r.status}`;
      const required: Array<[string, string]> = [
        ['eloLink', 'descriptions never mention eloLink'],
        ['parentId', 'elo_search does not expose parentId'],
        ['folderId', 'elo_list_folder does not expose folderId'],
        ['Never build an ELO URL yourself', 'link tool does not forbid URL construction'],
        ['authoritative', 'exact-match guidance missing'],
      ];
      const missing = required.filter(([needle]) => !body.includes(needle));
      return missing.length === 0 || missing.map(([, msg]) => msg).join('; ');
    },
  );

  // Regression for the Notion connect failure: a long-lived GET SSE stream must
  // not block a concurrent POST. With a shared singleton server this threw
  // "Already connected" → HTTP 500. Each request now gets its own server.
  await check(
    'GET /mcp SSE stream open + concurrent POST initialize → 200',
    async () => {
      const sseAbort = new AbortController();
      const sse = await fetch(`${BASE}/mcp`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          Accept: 'text/event-stream',
        },
        signal: sseAbort.signal,
      });
      if (sse.status !== 200) {
        sseAbort.abort();
        return sse;
      }
      try {
        // Stream stays open; fire the overlapping POST while it is held.
        return await jsonRpc(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-http', version: '0.0.0' },
          },
          10,
        );
      } finally {
        sseAbort.abort();
      }
    },
    (r) => r.status === 200 || `status=${r.status}`,
  );

  const haveRealElo =
    process.env.ELO_BASE_URL &&
    process.env.ELO_USERNAME &&
    process.env.ELO_PASSWORD &&
    !process.env.ELO_BASE_URL.includes('example.com');

  if (haveRealElo) {
    await check(
      'POST /mcp tools/call elo_search → 200 with non-empty result',
      () =>
        jsonRpc(
          'tools/call',
          {
            name: 'elo_search',
            arguments: { query: 'Vertrag', maxResults: 1 },
          },
          3,
        ),
      (r, body) => {
        if (r.status !== 200) return `status=${r.status}`;
        if (body.includes('"isError":true')) return 'tool returned isError';
        return true;
      },
    );
  } else {
    console.log(
      '  POST /mcp tools/call elo_search → SKIPPED (no real ELO env)',
    );
  }

  await stop(server);

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
