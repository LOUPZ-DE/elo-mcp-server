#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { EloClient } from './elo/client.js';
import { eloSearch, SearchInputSchema } from './tools/elo_search.js';
import { eloGetMetadata, GetMetadataInputSchema } from './tools/elo_get_metadata.js';
import {
  eloGetDocumentLink,
  GetDocumentLinkInputSchema,
} from './tools/elo_get_document_link.js';
import {
  eloFindProjectFolder,
  FindProjectFolderInputSchema,
} from './tools/elo_find_project_folder.js';

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (err) {
  process.stderr.write(
    `${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

const eloClient = new EloClient({
  baseUrl: cfg.ELO_BASE_URL,
  username: cfg.ELO_USERNAME,
  password: cfg.ELO_PASSWORD,
  basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
  basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
  language: cfg.ELO_LANGUAGE,
  country: cfg.ELO_COUNTRY,
  timeZone: cfg.ELO_TIMEZONE,
});

const linkOptions = { webclientBaseUrl: cfg.ELO_WEBCLIENT_URL };
const projectFolderOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  projectNumberField: cfg.ELO_PROJECT_NUMBER_FIELD,
};

function asTextResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function asError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err: msg }, 'Tool invocation failed');
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${msg}` }],
  };
}

// Build a freshly-configured server instance. In stateless HTTP mode a server
// may only be bound to one transport at a time, so each request gets its own
// server + transport — otherwise a long-lived GET SSE stream (e.g. Notion's)
// keeps the singleton bound and a concurrent POST throws "Already connected".
function createServer(): McpServer {
  const server = new McpServer({
    name: 'elo-mcp-server',
    version: '0.1.0',
  });

  server.registerTool(
    'elo_search',
    {
      title: 'ELO full-text search',
      description:
        'Searches ELO for documents and folders by free-text query, project number, or keyword. Returns id, name, type (document/folder), mask name, owner, last-changed date.',
      inputSchema: SearchInputSchema,
    },
    async (args) => {
      try {
        return asTextResult(await eloSearch(eloClient, args));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'elo_get_metadata',
    {
      title: 'Get ELO object metadata',
      description:
        'Returns index fields, owner, mask, version info for a given ELO objId. Works for both folders and documents.',
      inputSchema: GetMetadataInputSchema,
    },
    async (args) => {
      try {
        return asTextResult(await eloGetMetadata(eloClient, args));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'elo_get_document_link',
    {
      title: 'Get ELO document links',
      description:
        'Returns a stable ELO webclient link and (when available) a short-lived download URL for a document. Download URLs are valid for ~1–10 minutes only.',
      inputSchema: GetDocumentLinkInputSchema,
    },
    async (args) => {
      try {
        return asTextResult(await eloGetDocumentLink(eloClient, args, linkOptions));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'elo_find_project_folder',
    {
      title: 'Find ELO project folder',
      description:
        'Finds project folders by project number or project name. Filters results to folders only and reconstructs their archive path.',
      inputSchema: FindProjectFolderInputSchema,
    },
    async (args) => {
      try {
        return asTextResult(await eloFindProjectFolder(eloClient, args, projectFolderOptions));
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  logger.info('ELO MCP server connected on stdio');
}

async function startHttp() {
  // Required at this point because config.ts already validated it.
  const secret = cfg.MCP_SHARED_SECRET!;
  const secretBuf = Buffer.from(secret);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, transport: 'http' });
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const provided = header.replace(/^Bearer\s+/i, '');
    const providedBuf = Buffer.from(provided);
    const ok =
      providedBuf.length === secretBuf.length &&
      timingSafeEqual(providedBuf, secretBuf);
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  app.all('/mcp', requireAuth, async (req, res) => {
    // Stateless: a fresh transport per request. Simpler model and fine for
    // automation clients (n8n/Make/Notion-agents/claude.ai) where each call
    // is an independent JSON-RPC exchange.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        'MCP request handling failed',
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  });

  app.listen(cfg.MCP_HTTP_PORT, cfg.MCP_HTTP_HOST, () => {
    logger.info(
      { host: cfg.MCP_HTTP_HOST, port: cfg.MCP_HTTP_PORT },
      'ELO MCP server listening on HTTP',
    );
  });
}

async function main() {
  if (cfg.MCP_TRANSPORT === 'http') {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'Fatal startup error');
  process.exit(1);
});
