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
import { eloListFolder, ListFolderInputSchema } from './tools/elo_list_folder.js';
import {
  eloGetDocumentContent,
  GetDocumentContentInputSchema,
} from './tools/elo_get_document_content.js';
import { createSemaphore } from './utils/semaphore.js';

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
  projectNameField: cfg.ELO_PROJECT_NAME_FIELD,
  projectMarkerField: cfg.ELO_PROJECT_MARKER_FIELD,
  projectMarkerValue: cfg.ELO_PROJECT_MARKER_VALUE,
};

const contentOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  maxBytes: cfg.ELO_MAX_DOCUMENT_BYTES,
  maxChars: cfg.ELO_MAX_TEXT_CHARS,
  timeoutMs: cfg.ELO_DOWNLOAD_TIMEOUT_MS,
};

/** Serialises document downloads so parallel large files cannot exhaust memory. */
const withContentSlot = createSemaphore(cfg.ELO_CONTENT_CONCURRENCY);

// Surfaced on every search/listing hit. Without these the model cannot tell
// two similarly named documents from different projects apart.
const listingOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  projectIndexFields: [
    cfg.ELO_PROJECT_NUMBER_FIELD,
    cfg.ELO_PROJECT_NAME_FIELD,
    cfg.ELO_PROJECT_MARKER_FIELD,
  ],
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

// Pull lightweight, non-sensitive identifiers out of a JSON-RPC body so each
// HTTP request can be logged with the method/id/client it carries. Handles the
// batch form (array) and the empty body of a GET SSE request.
function summarizeRpc(body: unknown): {
  rpcMethod?: string;
  rpcId?: unknown;
  client?: string;
} {
  const msg = Array.isArray(body) ? body[0] : body;
  if (!msg || typeof msg !== 'object') return {};
  const m = msg as Record<string, unknown>;
  const params =
    m.params && typeof m.params === 'object'
      ? (m.params as Record<string, unknown>)
      : undefined;
  const clientInfo =
    params?.clientInfo && typeof params.clientInfo === 'object'
      ? (params.clientInfo as Record<string, unknown>)
      : undefined;
  return {
    rpcMethod: typeof m.method === 'string' ? m.method : undefined,
    rpcId: m.id,
    client: typeof clientInfo?.name === 'string' ? clientInfo.name : undefined,
  };
}

// Build a freshly-configured server instance. In stateless HTTP mode a server
// may only be bound to one transport at a time, so each request gets its own
// server + transport — otherwise a long-lived GET SSE stream (e.g. Notion's)
// keeps the singleton bound and a concurrent POST throws "Already connected".
// One global rule beats repeating link policy in five tool descriptions: the
// pilot's "sometimes the right ELO link, sometimes a link into a different
// project" came from the model filling gaps from conversation context.
const SERVER_INSTRUCTIONS = `This server exposes a read-only view of the ELO document archive.

Link policy — this is not optional:
- Every ELO link you output must be copied VERBATIM from the \`eloLink\` field of a tool result.
- Never construct, guess, shorten or complete an ELO URL yourself, and never reuse a link seen earlier in the conversation or coming from another system for a different object.
- If you need a link you do not have, call elo_get_document_link. If that fails, say the link is unavailable.

Identifying the right object:
- Documents in different projects often have near-identical names. Always check the \`path\` field before attributing a hit to a project, and state the path when you cite a document.
- For any project-specific question, resolve the project first with elo_find_project_folder, then pass its objId as \`parentId\` to elo_search or as \`folderId\` to elo_list_folder. Do not answer a project question from an archive-wide search.
- When several projects match and none is an exact match, ask the user which one is meant rather than choosing.

Completeness:
- Results carry \`truncated\` and a \`note\`. When \`truncated\` is true the list is incomplete — never present it as exhaustive, and never call the first entry "the latest" or "the only" one.`;

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'elo-mcp-server',
      version: '0.3.0',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** Every tool here reads; none of them writes. */
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  server.registerTool(
    'elo_search',
    {
      title: 'ELO search',
      description:
        'Searches the ELO archive for documents and folders. Every hit carries its archive `path` and a ready-made `eloLink` — use both verbatim.\n\n' +
        'Archive-wide by default, which means hits from unrelated projects look identical apart from their `path`. For project-specific questions, first call elo_find_project_folder and pass its objId as `parentId`; that restricts the search to the project subtree.\n\n' +
        'Note the trade-off: ELO cannot combine full-text search with a folder restriction. Without `parentId` the search covers document *content*; with `parentId` it covers titles and index fields only. The response states which engine ran.\n\n' +
        'Check `truncated` before treating the result as complete.',
      inputSchema: SearchInputSchema,
      annotations: readOnly,
    },
    async (args) => {
      try {
        return asTextResult(await eloSearch(eloClient, args, listingOptions));
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
        'Resolves a project to its ELO data-room folder. Start here for any project-specific question, then use the returned objId as `parentId` (elo_search) or `folderId` (elo_list_folder).\n\n' +
        'Prefer `projectNumber` — it is matched exactly against the project index field. `matchType: "exact"` is authoritative; when an exact hit exists, ignore fuzzy ones entirely. A project number and a folder *title* containing that number frequently point at different folders.\n\n' +
        '`isProjectRoot: false` means the folder is a sub-folder or a non-project folder, not the project data room. If several candidates remain, ask the user which project is meant instead of picking one.',
      inputSchema: FindProjectFolderInputSchema,
      annotations: readOnly,
    },
    async (args) => {
      try {
        return asTextResult(await eloFindProjectFolder(eloClient, args, projectFolderOptions));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'elo_list_folder',
    {
      title: 'List ELO folder contents',
      description:
        'Lists what is inside a folder. This is the right tool for "which monthly reports / invoices / documents exist in project X" — get `folderId` from elo_find_project_folder first.\n\n' +
        '`depth: 1` (default) returns direct children only; raise it to descend into sub-folders. `nameFilter` matches substrings of the entry name. Sorting by `changed` or `created` puts the newest first.\n\n' +
        'When `truncated` is true, the sort applied only to the entries that were fetched, so the first entry is not necessarily the newest overall.',
      inputSchema: ListFolderInputSchema,
      annotations: readOnly,
    },
    async (args) => {
      try {
        return asTextResult(await eloListFolder(eloClient, args, listingOptions));
      } catch (err) {
        return asError(err);
      }
    },
  );

  if (cfg.ELO_DOCUMENT_CONTENT_ENABLED) {
    server.registerTool(
      'elo_get_document_content',
      {
        title: 'Read ELO document text',
        description:
          'Returns the extracted text of a document — this is how you read what is actually inside a PDF, Word file or text file in ELO. Use it whenever a question is about document *content* rather than about which documents exist.\n\n' +
          `Long documents are truncated at around ${cfg.ELO_MAX_TEXT_CHARS.toLocaleString('en-US')} characters; when \`truncated\` is true, call again with \`offset\` set to the returned \`nextOffset\` to read on.\n\n` +
          'Scanned PDFs have no text layer and return empty text with `textLayer: "none"` — say so rather than guessing at the content. Spreadsheets, presentations, e-mail containers (.ecf/.msg) and images are not readable; the response explains why and gives you the eloLink to pass to the user.\n\n' +
          'When a clickable link is all that is needed, use elo_get_document_link instead — it is far cheaper.',
        inputSchema: GetDocumentContentInputSchema,
        annotations: readOnly,
      },
      async (args) => {
        try {
          return asTextResult(
            await withContentSlot(() => eloGetDocumentContent(eloClient, args, contentOptions)),
          );
        } catch (err) {
          return asError(err);
        }
      },
    );
  }

  server.registerTool(
    'elo_get_metadata',
    {
      title: 'Get ELO object metadata',
      description:
        'Returns all index fields, mask, owner, dates and version info for an objId. Works for folders and documents.\n\n' +
        'Also returns `path` and `eloLink`, so this is a cheap way to verify which project an object belongs to before citing it. Returns metadata only — for the document text use elo_get_document_content.',
      inputSchema: GetMetadataInputSchema,
      annotations: readOnly,
    },
    async (args) => {
      try {
        return asTextResult(await eloGetMetadata(eloClient, args, linkOptions));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'elo_get_document_link',
    {
      title: 'Get ELO document link',
      description:
        'The authoritative source of a link to an ELO object. Returns `eloLink` (stable, hand this to users) plus the containing `path`.\n\n' +
        'Never build an ELO URL yourself — always take `eloLink` from here or from a search result.\n\n' +
        'The `downloadUrl` it may also return is server-session-bound and expires within minutes; external clients cannot open it. To read a document, call elo_get_document_content instead.',
      inputSchema: GetDocumentLinkInputSchema,
      annotations: readOnly,
    },
    async (args) => {
      try {
        return asTextResult(await eloGetDocumentLink(eloClient, args, linkOptions));
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
      // Surface misconfigured connectors (wrong/missing token) — a common cause
      // of "client won't connect" that is otherwise invisible.
      logger.warn(
        {
          httpMethod: req.method,
          hasAuthHeader: header.length > 0,
          providedLength: provided.length,
        },
        'MCP request rejected: bad or missing bearer token',
      );
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  let reqCounter = 0;

  app.all('/mcp', requireAuth, async (req, res) => {
    // Stateless: a fresh transport per request. Simpler model and fine for
    // automation clients (n8n/Make/Notion-agents/claude.ai) where each call
    // is an independent JSON-RPC exchange.
    const rpc = summarizeRpc(req.body);
    const reqLog = logger.child({
      reqId: ++reqCounter,
      httpMethod: req.method,
      // text/event-stream on a GET signals a long-lived SSE stream (e.g. Notion);
      // surfacing it makes overlap-with-POST issues visible at a glance.
      accept: req.header('accept'),
      ...rpc,
    });
    const start = process.hrtime.bigint();
    reqLog.info('MCP request received');

    let completionLogged = false;
    const logCompletion = (event: 'finish' | 'close') => {
      if (completionLogged) return;
      completionLogged = true;
      const durationMs = Math.round(
        Number(process.hrtime.bigint() - start) / 1e6,
      );
      const status = res.statusCode;
      // A close without a finished response means the client hung up (normal
      // for an SSE stream it chose to drop); don't cry 500 over that.
      const level =
        status >= 500 ? 'error' : status >= 400 || event === 'close' ? 'warn' : 'info';
      reqLog[level](
        { status, durationMs, closedByClient: event === 'close' },
        'MCP request completed',
      );
    };

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('finish', () => logCompletion('finish'));
    res.on('close', () => {
      logCompletion('close');
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Pass the Error object (not just .message) so pino's serializer records
      // the stack; reqLog already carries httpMethod + rpcMethod for context.
      reqLog.error({ err, status: 500 }, 'MCP request handling failed');
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

// Last-resort visibility: a rejected promise inside the SSE stream lifecycle or
// any async path we didn't await would otherwise vanish silently.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'Fatal startup error');
  process.exit(1);
});
