import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { addClient, type RegisteredClient } from './store.js';
import { randomToken } from './pkce.js';

// RFC 7591 Dynamic Client Registration.
//
// Unauthenticated on purpose: that is the point of DCR and how every MCP client
// expects it to work. What keeps it safe is that a registration on its own
// grants nothing — the client still has to send a user through the login form,
// and the redirect_uri it registered is matched exactly when the code is
// delivered. The store caps how many registrations can accumulate.

const redirectUriSchema = z.string().url().refine(
  (value) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') return true;
      // RFC 8252 loopback exception — this is what lets the MCP Inspector and
      // other local tooling register.
      return (
        url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      );
    } catch {
      return false;
    }
  },
  { message: 'must be https (exception: http://localhost or http://127.0.0.1)' },
);

const clientMetadataSchema = z
  .object({
    redirect_uris: z.array(redirectUriSchema).min(1, 'at least one redirect_uri is required'),
    token_endpoint_auth_method: z.string().optional().default('none'),
    grant_types: z.array(z.string()).optional().default(['authorization_code']),
    response_types: z.array(z.string()).optional().default(['code']),
    client_name: z.string().max(200).optional(),
    scope: z.string().max(200).optional(),
  })
  // Clients send plenty of other metadata (software_id, logo_uri, contacts…).
  // Accept and ignore it rather than rejecting registrations over fields we
  // have no use for.
  .passthrough();

/**
 * Refuse a registration — and say so in the log.
 *
 * A rejected registration used to be silent, which made it indistinguishable
 * from a client that never tried. When the client then falls back to a
 * client_id it cached earlier, the visible symptom is an "unknown client_id" at
 * /authorize with no clue as to why the client never got a new one.
 */
function dcrError(
  res: Response,
  status: number,
  error: string,
  description: string,
  body?: unknown,
): void {
  logger.warn(
    {
      status,
      error,
      description,
      // A registration request carries no secrets, so this is safe to log —
      // and it is the only way to see what a client actually asked for.
      requested: summariseMetadata(body),
    },
    'DCR: registration rejected',
  );
  res.status(status).json({ error, error_description: description });
}

function summariseMetadata(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  return {
    client_name: b.client_name,
    redirect_uris: b.redirect_uris,
    token_endpoint_auth_method: b.token_endpoint_auth_method,
    grant_types: b.grant_types,
    response_types: b.response_types,
  };
}

export function registerHandler(req: Request, res: Response): void {
  if (!req.is('application/json')) {
    dcrError(
      res,
      415,
      'invalid_client_metadata',
      'Content-Type must be application/json',
      req.body,
    );
    return;
  }

  const parsed = clientMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    dcrError(
      res,
      400,
      'invalid_client_metadata',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      req.body,
    );
    return;
  }
  const meta = parsed.data;

  // A client asking to authenticate with a secret gets registered anyway, as a
  // public one, and is told so in the response.
  //
  // RFC 7591 §3.2.1 is explicit that the server may return metadata differing
  // from the request and that the client must use what it gets back. Refusing
  // instead — which is what this did — left clients that ask for
  // `client_secret_basic` unable to register at all, and a client that then
  // falls back to a cached client_id looks, from the server, exactly like one
  // that never registered.
  //
  // Nothing is weakened by accepting: /token authenticates no client either
  // way. PKCE is mandatory and is what actually binds the code to the caller.
  if (meta.token_endpoint_auth_method !== 'none') {
    logger.info(
      {
        requested: meta.token_endpoint_auth_method,
        clientName: meta.client_name,
      },
      'DCR: client asked for a confidential auth method — registering it as public (PKCE only)',
    );
  }

  const client: RegisteredClient = {
    client_id: randomToken(24),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: meta.client_name,
    redirect_uris: meta.redirect_uris,
    grant_types: meta.grant_types,
    response_types: meta.response_types,
    token_endpoint_auth_method: 'none',
    scope: meta.scope,
  };
  addClient(client);

  logger.info(
    {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUris: client.redirect_uris,
    },
    'DCR: client registered',
  );

  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    ...(client.scope ? { scope: client.scope } : {}),
  });
}
