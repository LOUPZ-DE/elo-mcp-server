import 'dotenv/config';
import { z } from 'zod';

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
