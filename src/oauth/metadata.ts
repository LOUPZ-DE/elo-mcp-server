import type { Request, Response } from 'express';
import { config } from '../utils/runtimeConfig.js';

// Discovery documents. A client that gets a 401 from /mcp reads the
// `resource_metadata` URL out of the WWW-Authenticate header, fetches the
// protected-resource document below, follows it to the authorization server
// document, and registers itself — all without anybody pasting a token.

const SCOPES = ['mcp'];

/** RFC 9728 — protected resource metadata. */
export function prmHandler(_req: Request, res: Response): void {
  const cfg = config();
  res.set('Cache-Control', 'public, max-age=300').json({
    resource: cfg.MCP_RESOURCE,
    authorization_servers: [cfg.PUBLIC_BASE_URL],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
    resource_name: cfg.OAUTH_SERVER_NAME,
  });
}

/** RFC 8414 — authorization server metadata. */
export function asMetadataHandler(_req: Request, res: Response): void {
  const cfg = config();
  const base = cfg.PUBLIC_BASE_URL;
  res.set('Cache-Control', 'public, max-age=300').json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients only: there is no client secret to authenticate with.
    token_endpoint_auth_methods_supported: ['none'],
    // OAuth 2.1 makes PKCE mandatory and drops `plain`.
    code_challenge_methods_supported: ['S256'],
  });
}

/**
 * Notion's convention: a short descriptor so the connector can show a name for
 * the server before any OAuth round trip has happened.
 */
export function mcpDescriptorHandler(_req: Request, res: Response): void {
  const cfg = config();
  res.set('Cache-Control', 'public, max-age=300').json({
    name: cfg.OAUTH_SERVER_NAME,
    description:
      'Read-only access to the ELO document archive. Sign in with your own ELO account; ' +
      'searches and documents are scoped to your ELO permissions.',
    endpoint: cfg.MCP_RESOURCE,
  });
}
