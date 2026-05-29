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
const BOOT_TIMEOUT_MS = 8_000;

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

async function waitForBoot(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return false;
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

  const booted = await waitForBoot();
  if (!booted) {
    console.error('Server did not respond on /health within the boot timeout.');
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
    'POST /mcp tools/list returns the four ELO tools',
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
      ];
      const missing = needed.filter((n) => !body.includes(n));
      return missing.length === 0 || `missing tools: ${missing.join(', ')}`;
    },
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
