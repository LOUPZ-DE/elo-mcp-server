import 'dotenv/config';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { logger } from './logger.js';
import { decodeStateKey, secretsMatch } from './stateFile.js';
import { parseList } from '../write/policy.js';

const ConfigSchema = z.object({
  ELO_BASE_URL: z.string().url(),
  ELO_WEBCLIENT_URL: z.string().url(),
  ELO_USERNAME: z.string().min(1),
  ELO_PASSWORD: z.string().min(1),
  // The Loupz nginx in front of IX requires HTTP Basic Auth on every path
  // except /login. By default we reuse the ELO credentials (they work for
  // both layers). Override only if IT splits the two later.
  //
  // With MCP_AUTH_MODE=oauth|both this stops being cosmetic: per-user sessions
  // authenticate END USERS against IX, while the proxy layer in front of it
  // must keep using the technical account. See src/authn/eloLogin.ts.
  ELO_BASIC_AUTH_USER: z.string().optional(),
  ELO_BASIC_AUTH_PASS: z.string().optional(),
  ELO_LANGUAGE: z.string().default('de'),
  ELO_COUNTRY: z.string().default('DE'),
  ELO_TIMEZONE: z.string().default('UTC'),
  // Name of the ELO index field that holds the project number on your masks.
  // Default `PRJ_NO` matches the ELO Solutions standard project mask. Override
  // for custom mask designs.
  ELO_PROJECT_NUMBER_FIELD: z.string().default('PRJ_NO'),
  ELO_PROJECT_NAME_FIELD: z.string().default('PRJ_NAME'),
  // A project *data room* is marked by an index field, not by its position in
  // the tree. Without this check a sub-folder whose title happens to match the
  // query is offered with the same authority as the real project root — which
  // is how the pilot ended up with links into the wrong project.
  ELO_PROJECT_MARKER_FIELD: z.string().default('SOL_TYPE'),
  ELO_PROJECT_MARKER_VALUE: z.string().default('PROJEKT'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Document content -----------------------------------------------------
  // Hard cap on what we will pull out of ELO. Enforced by axios itself, so an
  // oversized file is rejected mid-transfer rather than after buffering it.
  ELO_MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  // Roughly 12–15k tokens. Larger documents are paged via the tool's `offset`.
  ELO_MAX_TEXT_CHARS: z.coerce.number().int().positive().max(500_000).default(50_000),
  // Reverse proxies typically cut a request at 60 s; a longer timeout here just
  // turns into a 504 the client cannot interpret. Raise both together.
  ELO_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Download + parse holds the whole file in memory. Three concurrent 15 MB
  // PDFs will OOM a small container, and the HTTP transport has no backpressure
  // of its own.
  ELO_CONTENT_CONCURRENCY: z.coerce.number().int().positive().max(8).default(2),
  // NOTE: not z.coerce.boolean() — that turns the string "false" into true.
  ELO_DOCUMENT_CONTENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Transport: `stdio` for local Claude Desktop subprocess usage; `http` for
  // remote hosting (Easypanel, etc.). HTTP mode requires MCP_SHARED_SECRET.
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3000),
  MCP_HTTP_HOST: z.string().default('0.0.0.0'),
  MCP_SHARED_SECRET: z.string().optional(),

  // --- OAuth 2.1 + Dynamic Client Registration ------------------------------
  // What the HTTP transport accepts as a bearer token on /mcp:
  //   shared — only MCP_SHARED_SECRET. Exactly today's behaviour, and the
  //            default, so an existing deployment is unaffected by a redeploy.
  //   oauth  — only access tokens minted by the built-in authorization server.
  //   both   — either. One endpoint serves API-key clients (n8n, Make, Open
  //            WebUI) and OAuth clients (Notion, claude.ai) side by side.
  MCP_AUTH_MODE: z.enum(['shared', 'oauth', 'both']).default('shared'),
  // Public origin of this server, no trailing slash. Must match byte-for-byte
  // what clients dial: it is the OAuth issuer, the token audience and the base
  // of every discovery document. A mismatch surfaces in the client as an
  // "issuer mismatch", which is not a hint anyone can act on.
  PUBLIC_BASE_URL: z.string().url().optional(),
  // HS256 signing key for access tokens, and HMAC key for the browser login
  // cookie. Separate keys so leaking one does not let you forge the other.
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  OAUTH_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  OAUTH_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  OAUTH_ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(3600),
  OAUTH_REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000),
  // Shown on the login page and in the discovery documents.
  OAUTH_SERVER_NAME: z.string().default('ELO MCP Server'),
  // Cap on registered DCR clients. Registration is unauthenticated by design
  // (RFC 7591), so without a cap anyone can grow the map without bound.
  OAUTH_MAX_CLIENTS: z.coerce.number().int().positive().default(500),

  // --- Write MVP (off by default) --------------------------------------------
  // Writing is disabled unless this is true, and a disabled write tool is not
  // advertised at all — same pattern as ELO_DOCUMENT_CONTENT_ENABLED.
  // NOTE: not z.coerce.boolean() — that turns the string "false" into true.
  ELO_WRITE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Every allowlist below defaults to empty, and empty means NOTHING is
  // permitted rather than everything. Comma-separated.
  ELO_WRITE_ROOT_IDS: z.string().default(''),
  ELO_WRITE_MASKS: z.string().default(''),
  ELO_WRITE_FIELDS: z.string().default(''),
  ELO_WRITE_MIME_TYPES: z.string().default(''),
  ELO_WRITE_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  // How long a prepared write stays confirmable, in seconds.
  ELO_WRITE_PREFLIGHT_TTL: z.coerce.number().int().positive().max(3600).default(300),
  // Sandbox folder for the live write test. Not read by the server itself —
  // scripts/test-live-write.ts refuses to run without it.
  ELO_TEST_FOLDER_ID: z.string().optional(),

  // --- Encrypted state persistence ------------------------------------------
  // Absolute path to the state file. Without it the server runs purely in
  // memory and every restart drops the DCR registrations, the refresh tokens
  // and every signed-in ELO session.
  STATE_FILE: z.string().min(1).optional(),
  // 32 bytes, hex or base64url. Mandatory whenever STATE_FILE is set — the
  // file holds ELO credentials, so there is no plaintext fallback.
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  STATE_ENCRYPTION_KEY: z.string().min(1).optional(),

  // --- Per-user ELO sessions (OAuth only) -----------------------------------
  // How long an idle user session survives before its credentials are dropped
  // from memory. Expiry sends the client back through the login widget.
  ELO_USER_SESSION_TTL: z.coerce.number().int().positive().default(28_800),
  // Each live session can hold one IX session. Cap it so a busy day cannot
  // exhaust the ELO licence pool.
  ELO_MAX_USER_SESSIONS: z.coerce.number().int().positive().max(500).default(50),
});

export type Config = z.infer<typeof ConfigSchema> & {
  /** True when the built-in OAuth authorization server is mounted. */
  oauthEnabled: boolean;
  /** True when MCP_SHARED_SECRET is still accepted on /mcp. */
  sharedSecretEnabled: boolean;
  /** RFC 8707 resource identifier and JWT audience. Empty unless oauthEnabled. */
  MCP_RESOURCE: string;
  /** RFC 9728 metadata URL, advertised in the 401 WWW-Authenticate header. */
  PRM_URL: string;
};

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }
  const data = parsed.data;
  const oauthEnabled = data.MCP_AUTH_MODE !== 'shared';
  const sharedSecretEnabled = data.MCP_AUTH_MODE !== 'oauth';

  if (data.MCP_TRANSPORT === 'http' && sharedSecretEnabled && !data.MCP_SHARED_SECRET) {
    throw new Error(
      'MCP_SHARED_SECRET is required when MCP_TRANSPORT=http and MCP_AUTH_MODE is "shared" or "both" ' +
        '(a publicly exposed endpoint must authenticate). Use MCP_AUTH_MODE=oauth to drop the shared secret entirely.',
    );
  }
  if (oauthEnabled) {
    // The authorization code flow runs in the user's browser, so there has to
    // be an HTTP listener to run it on.
    if (data.MCP_TRANSPORT !== 'http') {
      throw new Error(
        `MCP_AUTH_MODE=${data.MCP_AUTH_MODE} requires MCP_TRANSPORT=http — the OAuth login is a browser flow.`,
      );
    }
    const missing = (
      [
        ['PUBLIC_BASE_URL', data.PUBLIC_BASE_URL],
        ['OAUTH_TOKEN_SECRET', data.OAUTH_TOKEN_SECRET],
        ['OAUTH_SESSION_SECRET', data.OAUTH_SESSION_SECRET],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `MCP_AUTH_MODE=${data.MCP_AUTH_MODE} requires: ${missing.join(', ')}.\n` +
          'Generate the secrets with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
      );
    }
  }

  if (data.ELO_WRITE_ENABLED) {
    // Writes are attributable or they do not happen. The shared secret acts as
    // the technical account, so a deployment that cannot offer a personal
    // sign-in has no identity to attribute a write to.
    if (!oauthEnabled) {
      throw new Error(
        'ELO_WRITE_ENABLED=true requires MCP_AUTH_MODE=oauth or both — writing is only permitted ' +
          'for a signed-in ELO user, and the shared secret cannot provide one.',
      );
    }
    // Empty allowlists mean "nothing permitted", which would make every write
    // fail at run time with a policy error. Better to say so at boot.
    const emptyLists = (
      [
        ['ELO_WRITE_ROOT_IDS', data.ELO_WRITE_ROOT_IDS],
        ['ELO_WRITE_MASKS', data.ELO_WRITE_MASKS],
      ] as const
    )
      .filter(([, value]) => parseList(value).length === 0)
      .map(([name]) => name);
    if (emptyLists.length > 0) {
      throw new Error(
        `ELO_WRITE_ENABLED=true requires a non-empty ${emptyLists.join(' and ')}. ` +
          'An allowlist left blank permits nothing, so every write would be refused. ' +
          'Name the folder objId(s) writing is confined to, and the mask(s) new objects may use.',
      );
    }
  }

  if (data.STATE_FILE) {
    if (!isAbsolute(data.STATE_FILE)) {
      throw new Error(`STATE_FILE must be an absolute path (got "${data.STATE_FILE}").`);
    }
    // No silent plaintext fallback: the file holds ELO user names and
    // passwords, and a half-configured deployment must not write those to a
    // volume in the clear.
    if (!data.STATE_ENCRYPTION_KEY) {
      throw new Error(
        'STATE_ENCRYPTION_KEY is required when STATE_FILE is set — the state file holds ELO credentials.\n' +
          'Generate one with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
      );
    }
    // Fails here rather than at the first write, when it would only be a log line.
    decodeStateKey(data.STATE_ENCRYPTION_KEY);
    // One key per purpose: leaking the token signing key must not also hand
    // over the credential vault.
    for (const [name, other] of [
      ['OAUTH_TOKEN_SECRET', data.OAUTH_TOKEN_SECRET],
      ['OAUTH_SESSION_SECRET', data.OAUTH_SESSION_SECRET],
    ] as const) {
      if (other && secretsMatch(data.STATE_ENCRYPTION_KEY, other)) {
        throw new Error(`STATE_ENCRYPTION_KEY must differ from ${name}.`);
      }
    }
    if (!oauthEnabled) {
      logger.warn(
        'STATE_FILE is set but MCP_AUTH_MODE=shared — there is no OAuth state to persist.',
      );
    }
  }

  // A trailing slash silently breaks the issuer comparison clients perform, so
  // normalise once here rather than at every use site.
  const base = (data.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

  return {
    ...data,
    PUBLIC_BASE_URL: base || undefined,
    oauthEnabled,
    sharedSecretEnabled,
    MCP_RESOURCE: oauthEnabled ? `${base}/mcp` : '',
    PRM_URL: oauthEnabled ? `${base}/.well-known/oauth-protected-resource` : '',
  };
}
