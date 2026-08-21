import type { Request, Response, NextFunction } from 'express';

// Browser-based MCP clients (the MCP Inspector, claude.ai's web client) need
// CORS on the discovery, registration, token and /mcp routes. Notion calls
// server-side and does not.
//
// Hand-rolled rather than pulling in `cors`: the package is only present as a
// transitive dependency of the MCP SDK and `@types/cors` is not installed at
// all, so a direct import would mean two new dependencies for the twelve lines
// below. Applied per route, never globally — /authorize is a browser
// *navigation* endpoint and must not advertise cross-origin access.
const ALLOWED_HEADERS = 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id';
const EXPOSED_HEADERS = 'Mcp-Session-Id, WWW-Authenticate';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Reflect the origin rather than sending `*`: `*` is invalid once a request
  // carries credentials, and every MCP client sends an Authorization header.
  res.setHeader('Access-Control-Allow-Origin', req.header('origin') ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
