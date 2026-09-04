#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response, type NextFunction } from 'express';
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
import { setConfig } from './utils/runtimeConfig.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpTokenVerifier } from './oauth/verifier.js';
import { prmHandler, asMetadataHandler, mcpDescriptorHandler } from './oauth/metadata.js';
import { registerHandler } from './oauth/register.js';
import { authorizeGetHandler, authorizePostHandler } from './oauth/authorize.js';
import { tokenHandler } from './oauth/token.js';
import { startStoreSweep } from './oauth/store.js';
import {
  dropEloSession,
  getEloSession,
  isStaleCredentialError,
  startEloSessionSweep,
} from './authn/eloLogin.js';
import { corsMiddleware } from './utils/cors.js';
import { rateLimit } from './utils/rateLimit.js';
import { ensureStateWritable, flushState, loadState } from './utils/stateFile.js';
import { iconSrc, loadIcon } from './utils/icon.js';
import { eloWhoAmI } from './tools/elo_whoami.js';
import { respond } from './mcp/respond.js';
import {
  nextStepsForDocumentContent,
  nextStepsForListFolder,
  nextStepsForMetadata,
  nextStepsForProjectFolder,
  nextStepsForSearch,
  nextStepsForWhoAmI,
} from './mcp/nextSteps.js';
import { requireEloUser } from './write/guard.js';
import { parseList, type WritePolicy } from './write/policy.js';
import { startPreflightSweep } from './write/preflight.js';
import { startIdempotencySweep } from './write/idempotency.js';
import {
  CreateFolderInputSchema,
  CommitInputSchema,
  prepareCreateFolder,
  commitCreateFolder,
} from './tools/elo_write_folder.js';
import {
  UpdateMetadataInputSchema,
  prepareUpdateMetadata,
  commitUpdateMetadata,
} from './tools/elo_write_metadata.js';
import {
  UploadDocumentInputSchema,
  AddVersionInputSchema,
  prepareUploadDocument,
  commitUploadDocument,
  prepareAddVersion,
  commitAddVersion,
} from './tools/elo_write_document.js';

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (err) {
  process.stderr.write(
    `${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
// Publish it before anything else imports it — the OAuth and authn modules all
// read the config back from here rather than parsing the environment again.
setConfig(cfg);

// State persistence, if configured. Both calls have to happen after setConfig
// and after the imports above, which is where the slices register themselves.
if (cfg.STATE_FILE) {
  try {
    // Fail here rather than in a swallowed catch on the first write. A bind
    // mount owned by root gives the `node` user EACCES, and discovering that
    // at the next restart means discovering it after the state is already lost.
    ensureStateWritable();
  } catch (err) {
    process.stderr.write(
      `State file directory is not writable: ${err instanceof Error ? err.message : String(err)}\n` +
        `Check the volume mounted at ${cfg.STATE_FILE}. On a bind mount the host directory's ` +
        'owner wins, so it must be writable by uid 1000 (the container\'s `node` user).\n',
    );
    process.exit(1);
  }
  loadState();
  // Worth stating once at boot rather than only in the docs: every save writes
  // the complete state, so a second replica on the same volume would discard
  // whatever the first one registered.
  logger.info(
    { stateFile: cfg.STATE_FILE },
    'Encrypted state persistence is active — this requires a single instance',
  );
}

/**
 * The technical account. Used for stdio, for shared-secret callers, and as the
 * only identity that existed before OAuth — its behaviour is unchanged.
 */
const serviceClient = new EloClient({
  baseUrl: cfg.ELO_BASE_URL,
  username: cfg.ELO_USERNAME,
  password: cfg.ELO_PASSWORD,
  basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
  basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
  language: cfg.ELO_LANGUAGE,
  country: cfg.ELO_COUNTRY,
  timeZone: cfg.ELO_TIMEZONE,
});

/**
 * Run a tool against whichever ELO identity the caller authenticated as.
 *
 * An OAuth caller carries an `eloSid` handle into the session vault and gets
 * their own IX session, with their own permissions. Everyone else — stdio, and
 * anyone holding the shared secret — gets the technical account, exactly as
 * before. There is deliberately no third case: an OAuth token whose session
 * has gone is an error, never a quiet downgrade to the technical account.
 */
async function withEloClient<T>(
  authInfo: AuthInfo | undefined,
  run: (client: EloClient) => Promise<T>,
): Promise<T> {
  const sid = typeof authInfo?.extra?.eloSid === 'string' ? authInfo.extra.eloSid : undefined;
  if (!sid) return run(serviceClient);

  const session = getEloSession(sid);
  if (!session) {
    // The verifier normally catches this first; reaching here means the session
    // expired between the token check and the tool call.
    throw new Error(
      'Your ELO session has expired. Reconnect this server in your client to sign in again.',
    );
  }

  try {
    return await run(session.client);
  } catch (err) {
    // A password change makes the stored credentials useless: EloClient will
    // keep trying to re-login with them every eight minutes and keep failing.
    // Dropping the session turns that into one 401 and a fresh login instead.
    if (isStaleCredentialError(err)) dropEloSession(sid);
    throw err;
  }
}

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

// Allowlists for the write MVP. Empty lists permit nothing; loadConfig()
// refuses to start with writing enabled and no target root.
const writePolicy: WritePolicy = {
  rootIds: parseList(cfg.ELO_WRITE_ROOT_IDS),
  masks: parseList(cfg.ELO_WRITE_MASKS),
  fields: parseList(cfg.ELO_WRITE_FIELDS),
  mimeTypes: parseList(cfg.ELO_WRITE_MIME_TYPES).map((m) => m.toLowerCase()),
  maxBytes: cfg.ELO_WRITE_MAX_BYTES,
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
/**
 * Only added when writing is switched on.
 *
 * Instructions for tools that are not registered would be worse than useless:
 * the model would offer changes the server cannot make, and the tokens spent
 * saying so are tokens not spent on the archive itself.
 */
const WRITE_INSTRUCTIONS = `

Changing something in ELO:
- Only when the user asked for a change. Never as a side effect of answering a question.
- A change runs as the signed-in person, with their ELO permissions. There is no fallback account: if a write tool refuses for want of an identity, say so and stop.
- Every change takes two calls. The first (elo_create_folder, elo_upload_document, elo_add_document_version, elo_update_metadata) writes NOTHING — it checks the request and returns a preview with a \`confirmToken\`. The second, the one ending in \`_commit\`, performs it.
- Show the preview to the user and get their agreement before calling the commit tool. That preview is the only place they see what would change — above all for elo_update_metadata, which REPLACES existing field values rather than adding to them.
- Pass the \`confirmToken\` exactly as issued, plus an \`idempotencyKey\` you choose. Send the same key again when retrying after a timeout: it returns the first result instead of creating a second object.
- A token is valid once, for a few minutes, for that one payload. If it has expired, or the object changed in ELO meanwhile, prepare again — never retry the commit.
- Target folders, masks, index fields, file types and sizes are restricted server-side. A refusal names what was not permitted; relay that instead of trying variations.
- Nothing here deletes, moves, or re-permissions anything, and earlier document versions always remain.`;

const SERVER_INSTRUCTIONS = `This server reads the ELO document archive${
  cfg.ELO_WRITE_ENABLED ? ', and can add to it in four narrow ways under confirmation' : ' and never changes it'
}.

Link policy — this is not optional:
- Every ELO link you output must be copied VERBATIM from the \`eloLink\` field of a tool result.
- Never construct, guess, shorten or complete an ELO URL yourself, and never reuse a link seen earlier in the conversation or coming from another system for a different object.
- If you need a link you do not have, call elo_get_document_link. If that fails, say the link is unavailable.

Identifying the right object:
- Documents in different projects often have near-identical names. Always check the \`path\` field before attributing a hit to a project, and state the path when you cite a document.
- For any project-specific question, resolve the project first with elo_find_project_folder, then pass its objId as \`parentId\` to elo_search or as \`folderId\` to elo_list_folder. Do not answer a project question from an archive-wide search.
- When several projects match and none is an exact match, ask the user which one is meant rather than choosing.

Completeness:
- Results carry \`truncated\` and a \`note\`. When \`truncated\` is true the list is incomplete — never present it as exhaustive, and never call the first entry "the latest" or "the only" one.
- Every result is filtered by the ELO permissions of the account this connection signed in as. A document you cannot see may still exist. Say "I did not find it" — never "it does not exist in ELO".

Working through a question:
- Tool answers are JSON. When an answer carries a \`nextSteps\` field, those are the follow-up calls that make sense right here, with their arguments already filled in — prefer them over reconstructing a call yourself.
- The usual order for a project question is elo_find_project_folder → elo_list_folder → elo_get_document_content; \`nextSteps\` names the next one at each stage.${
  cfg.ELO_WRITE_ENABLED ? WRITE_INSTRUCTIONS : ''
}`;

function createServer(): McpServer {
  const icon = loadIcon();
  const src = iconSrc(cfg.PUBLIC_BASE_URL);
  const server = new McpServer(
    {
      name: 'elo-mcp-server',
      version: '0.4.0',
      // MCP 2025-11-25 (SEP-973). The transport-agnostic way to give clients a
      // mark — and the only one that reaches a stdio client, which has no HTTP
      // endpoint to fetch from.
      ...(icon && src
        ? { icons: [{ src, mimeType: icon.mimeType, sizes: icon.sizes }] }
        : {}),
      ...(cfg.PUBLIC_BASE_URL ? { websiteUrl: cfg.PUBLIC_BASE_URL } : {}),
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /**
   * Every tool carrying this annotation reads; none of them writes.
   *
   * All four are stated rather than left to default, because the spec defaults
   * are the opposite of what these tools are: an unannotated tool counts as
   * `readOnlyHint: false` AND `destructiveHint: true`, so a cautious client has
   * to gate it behind a prompt.
   *
   * `openWorldHint: false` because an ELO archive is a closed, known domain —
   * one configured instance — not the open web. It was `true` until now, which
   * was over-cautious rather than wrong.
   */
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
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
    async (args, extra) => {
      try {
        const result = await withEloClient(extra.authInfo, (c) =>
          eloSearch(c, args, listingOptions),
        );
        return respond(result, nextStepsForSearch(result));
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
    async (args, extra) => {
      try {
        const result = await withEloClient(extra.authInfo, (c) =>
          eloFindProjectFolder(c, args, projectFolderOptions),
        );
        return respond(result, nextStepsForProjectFolder(result));
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
    async (args, extra) => {
      try {
        const result = await withEloClient(extra.authInfo, (c) =>
          eloListFolder(c, args, listingOptions),
        );
        return respond(result, nextStepsForListFolder(result));
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
          'Returns the extracted text of a document — this is how you read what is actually inside a PDF, Word file, Excel workbook, e-mail (.eml/.msg) or text file in ELO. Use it whenever a question is about document *content* rather than about which documents exist.\n\n' +
          `Long documents are truncated at around ${cfg.ELO_MAX_TEXT_CHARS.toLocaleString('en-US')} characters; when \`truncated\` is true, call again with \`offset\` set to the returned \`nextOffset\` to read on.\n\n` +
          'For an e-mail (.eml or .msg) the result begins with a From/To/Subject/Date block, then the message body; attachments are listed by name only, and are usually filed as separate ELO documents you can read individually.\n\n' +
          'An Excel workbook (.xlsx/.xlsm) comes back one sheet at a time: a `Sheet: <name>` heading, then one line per row with cells separated by ` | `. The first row is usually the header. Dates are resolved to calendar dates, so read them as written rather than as numbers.\n\n' +
          'Scanned PDFs have no text layer and return empty text with `textLayer: "none"` — say so rather than guessing at the content. Presentations, images, legacy .xls/.doc and ELO-encrypted documents (`.ecf`) cannot be read; the response explains why and gives you the eloLink to pass to the user.\n\n' +
          'When a clickable link is all that is needed, use elo_get_document_link instead — it is far cheaper.',
        inputSchema: GetDocumentContentInputSchema,
        annotations: readOnly,
      },
      async (args, extra) => {
        try {
          const result = await withContentSlot(() =>
            withEloClient(extra.authInfo, (c) => eloGetDocumentContent(c, args, contentOptions)),
          );
          return respond(result, nextStepsForDocumentContent(result));
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
    async (args, extra) => {
      try {
        const result = await withEloClient(extra.authInfo, (c) =>
          eloGetMetadata(c, args, linkOptions),
        );
        return respond(result, nextStepsForMetadata(result));
      } catch (err) {
        return asError(err);
      }
    },
  );

  // Registered without an inputSchema on purpose. With one, the SDK zod-checks
  // the arguments even when the client omits them entirely — which the MCP spec
  // permits — and rejects the call with -32602. Without one, both a missing
  // `arguments` and `{}` are accepted.
  server.registerTool(
    'elo_whoami',
    {
      title: 'Show the ELO identity in use',
      description:
        'Reports which ELO account this connection acts as, and therefore whose permissions the other tools apply.\n\n' +
        'Worth calling when results look thinner than expected: a signed-in user only ever sees what their own ELO account may see, so an empty result can mean "not permitted" rather than "not there". Also the quickest way to confirm a connection is wired up as intended.',
      annotations: readOnly,
    },
    async (extra) => {
      try {
        const result = eloWhoAmI(extra.authInfo, {
          technicalUser: cfg.ELO_USERNAME,
          authMode: cfg.MCP_AUTH_MODE,
          sessionIdleTtlSeconds: cfg.ELO_USER_SESSION_TTL,
        });
        return respond(result, nextStepsForWhoAmI(result));
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
    async (args, extra) => {
      try {
        return respond(
          await withEloClient(extra.authInfo, (c) => eloGetDocumentLink(c, args, linkOptions)),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // --- Write tools ----------------------------------------------------------
  //
  // Not registered at all unless writing is switched on, so a client of a
  // read-only deployment never sees them — same as elo_get_document_content.
  if (cfg.ELO_WRITE_ENABLED) {
    /**
     * Adds something; nothing existing is replaced, and ELO keeps what was
     * there before. `destructiveHint: false` is the point of this literal —
     * without it the spec default (true, once readOnlyHint is false) would put
     * creating an empty folder in the same category as overwriting data.
     */
    const writeAdditive = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } as const;

    /** Replaces values that were already there. Honestly destructive. */
    const writeDestructive = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    } as const;

    const writeOptions = { policy: writePolicy, webclientBaseUrl: cfg.ELO_WEBCLIENT_URL };
    /** Writes never run as the technical account — the guard has no fallback. */
    const userClient = (authInfo: AuthInfo | undefined) => requireEloUser(authInfo).client;

    server.registerTool(
      'elo_create_folder',
      {
        title: 'Preview: create a folder',
        description:
          'Checks whether a folder could be created and shows exactly what would happen. Writes nothing. Returns a confirmToken; pass it to elo_create_folder_commit to actually create the folder.',
        inputSchema: CreateFolderInputSchema,
        annotations: readOnly,
      },
      async (args, extra) => {
        try {
          const result = await prepareCreateFolder(
            userClient(extra.authInfo), extra.authInfo, args, writeOptions,
          );
          return respond(result, [
            `elo_create_folder_commit with {"parentId":"${args.parentId}","name":"${args.name}","maskName":"${args.maskName}","confirmToken":"${result.confirmToken}","idempotencyKey":"<a unique id you choose>"} to create it`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_create_folder_commit',
      {
        title: 'Create the previewed folder',
        description:
          'Creates the folder previewed by elo_create_folder. Needs that call\'s confirmToken and your own idempotencyKey; repeating a key returns the first result instead of creating a second folder.',
        inputSchema: { ...CreateFolderInputSchema, ...CommitInputSchema },
        annotations: writeAdditive,
      },
      async (args, extra) => {
        try {
          const result = await commitCreateFolder(userClient(extra.authInfo), extra.authInfo, args);
          return respond(result, [
            `elo_list_folder with {"folderId":"${result.objId}"} to confirm what is in it`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_update_metadata',
      {
        title: 'Preview: change index fields',
        description:
          'Shows the current and the proposed value of every field that would change. Writes nothing. Returns a confirmToken for elo_update_metadata_commit.',
        inputSchema: UpdateMetadataInputSchema,
        annotations: readOnly,
      },
      async (args, extra) => {
        try {
          const result = await prepareUpdateMetadata(
            userClient(extra.authInfo), extra.authInfo, args, writeOptions,
          );
          const real = result.changes.filter((c) => !c.unchanged);
          return respond(
            result,
            real.length === 0
              ? ['every field already holds the proposed value — there is nothing to change']
              : [
                  `elo_update_metadata_commit with {"objId":"${args.objId}","indexFields":${JSON.stringify(args.indexFields)},"confirmToken":"${result.confirmToken}","idempotencyKey":"<a unique id you choose>"} to REPLACE ${real.length} value(s)`,
                ],
          );
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_update_metadata_commit',
      {
        title: 'Replace the previewed index fields',
        description:
          'Overwrites the index fields previewed by elo_update_metadata. The previous values are replaced. Needs that call\'s confirmToken and your own idempotencyKey.',
        inputSchema: { ...UpdateMetadataInputSchema, ...CommitInputSchema },
        annotations: writeDestructive,
      },
      async (args, extra) => {
        try {
          const result = await commitUpdateMetadata(userClient(extra.authInfo), extra.authInfo, args);
          return respond(result, [
            `elo_get_metadata with {"objId":"${result.objId}"} to read back what is stored now`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    const documentOptions = {
      ...writeOptions,
      transport: {
        maxBytes: cfg.ELO_WRITE_MAX_BYTES,
        timeoutMs: cfg.ELO_DOWNLOAD_TIMEOUT_MS,
      },
    };

    server.registerTool(
      'elo_upload_document',
      {
        title: 'Preview: file a new document',
        description:
          'Checks a file against the size, type and target rules and shows where it would be filed. Writes nothing. Returns a confirmToken for elo_upload_document_commit.',
        inputSchema: UploadDocumentInputSchema,
        annotations: readOnly,
      },
      async (args, extra) => {
        try {
          const result = await prepareUploadDocument(
            userClient(extra.authInfo), extra.authInfo, args, documentOptions,
          );
          return respond(result, [
            `elo_upload_document_commit with the same arguments plus {"confirmToken":"${result.confirmToken}","idempotencyKey":"<a unique id you choose>"} to file it`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_upload_document_commit',
      {
        title: 'File the previewed document',
        description:
          'Uploads and files the document previewed by elo_upload_document. Needs that call\'s confirmToken and your own idempotencyKey; repeating a key returns the first result instead of filing a second copy.',
        inputSchema: { ...UploadDocumentInputSchema, ...CommitInputSchema },
        annotations: writeAdditive,
      },
      async (args, extra) => {
        try {
          const result = await commitUploadDocument(
            userClient(extra.authInfo), extra.authInfo, args, documentOptions,
          );
          return respond(result, [
            `elo_get_metadata with {"objId":"${result.objId}"} to see how it was filed`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_add_document_version',
      {
        title: 'Preview: add a document version',
        description:
          'Checks a file against the rules and shows which document would get a new version. Writes nothing. Earlier versions are always kept. Returns a confirmToken.',
        inputSchema: AddVersionInputSchema,
        annotations: readOnly,
      },
      async (args, extra) => {
        try {
          const result = await prepareAddVersion(
            userClient(extra.authInfo), extra.authInfo, args, documentOptions,
          );
          return respond(result, [
            `elo_add_document_version_commit with the same arguments plus {"confirmToken":"${result.confirmToken}","idempotencyKey":"<a unique id you choose>"} to add it`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );

    server.registerTool(
      'elo_add_document_version_commit',
      {
        title: 'Add the previewed document version',
        description:
          'Adds the previewed file as a new version. ELO keeps every earlier version, so nothing is lost. Needs the confirmToken and your own idempotencyKey.',
        inputSchema: { ...AddVersionInputSchema, ...CommitInputSchema },
        annotations: writeAdditive,
      },
      async (args, extra) => {
        try {
          const result = await commitAddVersion(
            userClient(extra.authInfo), extra.authInfo, args, documentOptions,
          );
          return respond(result, [
            `elo_get_metadata with {"objId":"${result.objId}"} to confirm the new version`,
          ]);
        } catch (err) {
          return asError(err);
        }
      },
    );
  }

  return server;
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  logger.info('ELO MCP server connected on stdio');
}

async function startHttp() {
  const app = express();
  // Easypanel/Traefik terminates TLS, so the client address and scheme arrive
  // in X-Forwarded-*. Without this the rate limiter would see one IP for
  // everyone and cookies would not be marked Secure.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  // Form posts only reach /authorize and /token; everything else is JSON.
  const formParser = express.urlencoded({ extended: false, limit: '64kb' });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, transport: 'http', authMode: cfg.MCP_AUTH_MODE });
  });

  // Unauthenticated, and mounted in every auth mode: a client has to be able to
  // show the mark before it holds a token, and Open WebUI reaches it over the
  // shared-secret path where none of the OAuth routes exist. It is a 2 KB image
  // that reveals nothing.
  const icon = loadIcon();
  if (icon) {
    app.get('/icon.png', corsMiddleware, (_req, res) => {
      res
        .set('Content-Type', icon.mimeType)
        .set('Cache-Control', 'public, max-age=86400')
        .send(icon.bytes);
    });
  }

  if (cfg.oauthEnabled) {
    // Discovery. A client that gets a 401 from /mcp finds its way here through
    // the resource_metadata hint in the WWW-Authenticate header.
    app.get('/.well-known/oauth-protected-resource', corsMiddleware, prmHandler);
    // RFC 9728 §3.1 path-suffixed variant; some clients ask only for this one.
    app.get('/.well-known/oauth-protected-resource/mcp', corsMiddleware, prmHandler);
    app.get('/.well-known/oauth-authorization-server', corsMiddleware, asMetadataHandler);
    // Not an OIDC provider, but several clients probe this alias first.
    app.get('/.well-known/openid-configuration', corsMiddleware, asMetadataHandler);
    app.get('/.well-known/mcp.json', corsMiddleware, mcpDescriptorHandler);

    // Anonymous writes and password submissions — the two endpoints worth
    // making expensive to hammer.
    const registerLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'register' });
    const authorizeLimiter = rateLimit({ windowMs: 60_000, max: 30, name: 'authorize' });
    const tokenLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'token' });

    app.post('/register', corsMiddleware, registerLimiter, registerHandler);

    // No CORS on /authorize: it is a top-level browser navigation, not an
    // XHR target, and advertising cross-origin access to a login form invites
    // exactly the framing it should not allow.
    app.get('/authorize', authorizeLimiter, authorizeGetHandler);
    // Express 4 does not forward a rejected promise to the error handler — that
    // only arrived in Express 5, which is what the reference implementation
    // relies on. Without this wrapper a failed login would hang the response.
    app.post('/authorize', authorizeLimiter, formParser, (req, res, next) => {
      void authorizePostHandler(req, res).catch(next);
    });

    app.post('/token', corsMiddleware, tokenLimiter, formParser, (req, res, next) => {
      void tokenHandler(req, res).catch(next);
    });

    startStoreSweep();
    startEloSessionSweep();

    if (cfg.ELO_WRITE_ENABLED) {
      startPreflightSweep();
      startIdempotencySweep();
      logger.warn(
        { roots: parseList(cfg.ELO_WRITE_ROOT_IDS), masks: parseList(cfg.ELO_WRITE_MASKS) },
        'Write tools are ENABLED — signed-in users may create and change objects in these areas',
      );
    }
  }

  // One gate for both credentials. McpTokenVerifier accepts the shared secret
  // and OAuth access tokens alike (subject to MCP_AUTH_MODE) and reports which
  // one it was through req.auth, which the transport passes to the tools.
  //
  // Replacing the hand-rolled check with this also fixes something that was
  // missing before: the 401 now carries a WWW-Authenticate header, which is
  // what makes a client offer "Sign in" instead of just failing.
  const bearerAuth = requireBearerAuth({
    verifier: new McpTokenVerifier(),
    ...(cfg.oauthEnabled ? { resourceMetadataUrl: cfg.PRM_URL } : {}),
  });

  let reqCounter = 0;

  app.all('/mcp', corsMiddleware, bearerAuth, async (req, res) => {
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
      // Which identity the call runs as. `eloUser` present means a per-user
      // OAuth session; absent means the technical account.
      eloUser: req.auth?.extra?.userName,
      oauthClientId: req.auth?.clientId,
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

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // The OAuth handlers are async and forward their rejections here rather than
  // leaving the response hanging. Without this Express 4 would answer with its
  // default HTML error page, which an OAuth client cannot parse.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled error in HTTP handler');
    if (!res.headersSent) {
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.listen(cfg.MCP_HTTP_PORT, cfg.MCP_HTTP_HOST, () => {
    logger.info(
      {
        host: cfg.MCP_HTTP_HOST,
        port: cfg.MCP_HTTP_PORT,
        authMode: cfg.MCP_AUTH_MODE,
        ...(cfg.oauthEnabled ? { issuer: cfg.PUBLIC_BASE_URL } : {}),
        state: cfg.STATE_FILE ? `encrypted at ${cfg.STATE_FILE}` : 'in-memory (lost on restart)',
      },
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
  safeFlush();
  process.exit(1);
});

function safeFlush(): void {
  try {
    // Marked as a shutdown flush: during a rolling redeploy the replacement is
    // already up, and writing our full state over the newer one's would undo it.
    flushState({ shutdown: true });
  } catch (err) {
    logger.error({ err }, 'Final state flush failed');
  }
}

// Without this the pending save — up to a second of registrations, tokens and
// sessions — is discarded when the container stops, which is exactly the moment
// the state file exists for. A redeploy sends SIGTERM.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  safeFlush();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'Fatal startup error');
  process.exit(1);
});
