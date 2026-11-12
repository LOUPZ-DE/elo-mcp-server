import { z } from 'zod';
import { EloClient, EloContentTooLargeError, EloStaleStreamError } from '../elo/client.js';
import { LOCK_Z_NO, EDIT_INFO_Z_ALL, DOC_ID_ALL_VERSIONS, isFolder } from '../elo/constants.js';
import { buildEloLink, parentIdOf, refPathString } from '../elo/sord.js';
import { extractTextIsolated } from '../extract/isolated.js';
import type { ExtractResult } from '../extract/index.js';
import { logger } from '../utils/logger.js';
import type { ReadCache, CacheSource } from '../utils/readCache.js';
import type { Semaphore } from '../utils/semaphore.js';
import type { Logger } from 'pino';
import type { CheckoutResponse, EloDocVersion, EloSord } from '../elo/types.js';
import { versionIdOf, versionSizeBytes } from '../elo/docVersion.js';

export const GetDocumentContentInputSchema = {
  objId: z.string().min(1).describe('ELO object ID of the document'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .optional()
    .describe('Maximum characters of text to return. Defaults to the server limit.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset — use the nextOffset from a truncated response to continue.'),
  version: z
    .string()
    .optional()
    .describe(
      'The versionId of a specific version, from the `versions` list of ' +
        'elo_get_metadata. Defaults to the current version.',
    ),
};

const GetDocumentContentArgs = z.object(GetDocumentContentInputSchema);
export type GetDocumentContentArgs = z.infer<typeof GetDocumentContentArgs>;

export interface DocumentContent {
  objId: string;
  name: string;
  /** Always present, on success and on failure — the citation anchor. */
  eloLink: string;
  path?: string;
  parentId?: string;
  contentType?: string;
  fileExtension?: string;
  sizeBytes?: number;
  /** Pass this back as `version` to read exactly this version again. */
  versionId?: string;
  version?: string;
  isWorkingVersion?: boolean;
  versionComment?: string;
  versionCreatedIso?: string;
  /** Which acquisition path worked — instrumentation for the pilot. */
  contentSource: 'inline' | 'stream';
  extractor: string;
  format: string;
  textLayer: 'present' | 'sparse' | 'none';
  pageCount?: number;
  text: string;
  offset: number;
  charCount: number;
  totalCharCount: number;
  truncated: boolean;
  nextOffset?: number;
  notice?: string;
}

export interface GetDocumentContentOptions {
  webclientBaseUrl: string;
  maxBytes: number;
  maxChars: number;
  timeoutMs: number;
  /** How long the parser may run in its worker. Defaults to 60 s. */
  extractTimeoutMs?: number;
  /**
   * Where the one line per read goes. The HTTP transport passes its request
   * logger, so the line carries the reqId it belongs to; defaults to the
   * module logger.
   */
  log?: Logger;
  /**
   * Limits how many downloads and parses run at once. Only that part takes a
   * slot: a checkout or a cache hit never queues behind a 60 MB PDF.
   * Absent means no limit.
   */
  slot?: Semaphore;
  /**
   * Extracted text kept for the next page of the same version, and shared
   * between parallel calls for it. Absent means every call reads and parses.
   */
  cache?: ReadCache<DocumentText>;
  /**
   * Aborted when the client gives up. Stops the wait for a slot, the download
   * and the parse — before this, an abandoned read ran to the end and
   * everyone queued behind it waited for a result nobody would receive.
   */
  signal?: AbortSignal;
}

/** A version's text before paging: the expensive part, and what the cache keeps. */
export interface DocumentText {
  extracted: ExtractResult;
  byteLength: number;
  contentSource: 'inline' | 'stream';
}

/**
 * Where a read spent its time. Filled in phase by phase, so a read that fails
 * still says how far it got — a download timeout and a parser that runs out of
 * memory look identical from the outside, and need opposite fixes.
 */
interface ReadTrace {
  /**
   * The phase in progress; after a failure, the one that failed. `shared`
   * means waiting for another call's read of the same version.
   */
  phase: 'checkout' | 'shared' | 'queue' | 'download' | 'extract' | 'done';
  checkoutMs?: number;
  slotWaitMs?: number;
  downloadMs?: number;
  extractMs?: number;
  bytes?: number;
  /** `hit` and `joined` did no download or parse of their own. */
  cache?: CacheSource;
}

const since = (start: number): number => Math.round(performance.now() - start);

/** Raised for conditions the model should act on rather than retry. */
export class DocumentContentError extends Error {
  constructor(
    message: string,
    readonly eloLink?: string,
  ) {
    super(eloLink ? `${message} Link: ${eloLink}` : message);
  }
}

/**
 * Read a document's text, and log one line saying where the time went.
 *
 * The line exists because a large document was a guess without it: the HTTP
 * log gave one duration per request, and the container graphs average over an
 * interval too coarse to tell a slow download from a slow parser. It carries
 * sizes, durations and page counts — never the name or a word of the content.
 */
export async function eloGetDocumentContent(
  client: EloClient,
  args: GetDocumentContentArgs,
  options: GetDocumentContentOptions,
): Promise<DocumentContent> {
  const log = options.log ?? logger;
  const started = performance.now();
  const trace: ReadTrace = { phase: 'checkout' };

  try {
    const result = await readDocumentContent(client, args, options, trace);
    const { phase: _done, ...timings } = trace;
    log.info(
      {
        objId: result.objId,
        ...timings,
        totalMs: Math.round(performance.now() - started),
        contentSource: result.contentSource,
        extractor: result.extractor,
        pageCount: result.pageCount,
        textLayer: result.textLayer,
        totalChars: result.totalCharCount,
        offset: result.offset,
      },
      'Document content read',
    );
    return result;
  } catch (err) {
    const { phase, ...timings } = trace;
    // The reason itself is logged by the tool's error handler; this line adds
    // what that one cannot know — the phase and how long it ran.
    log.warn(
      {
        objId: args.objId,
        failedIn: phase,
        ...timings,
        totalMs: Math.round(performance.now() - started),
        // The client went away; not a fault, and nothing was sent to anyone.
        ...(options.signal?.aborted ? { abandoned: true } : {}),
      },
      'Document content not read',
    );
    throw err;
  }
}

async function readDocumentContent(
  client: EloClient,
  args: GetDocumentContentArgs,
  options: GetDocumentContentOptions,
  trace: ReadTrace,
): Promise<DocumentContent> {
  // Every call checks out, cached or not: it is the caller's own session
  // proving it may read this document, and it names the version to serve.
  const checkoutStart = performance.now();
  const checkout = await checkoutDoc(client, args.objId);
  trace.checkoutMs = since(checkoutStart);
  options.signal?.throwIfAborted();
  const sord = checkout.result?.sord;
  if (!sord) {
    throw new DocumentContentError(`No object with objId=${args.objId} found.`);
  }

  const eloLink = buildEloLink(options.webclientBaseUrl, sord.id, sord.name);

  if (isFolder(sord.type)) {
    throw new DocumentContentError(
      `objId ${args.objId} is a folder ("${sord.name}"), not a document. Use elo_list_folder to see what is inside it.`,
      eloLink,
    );
  }

  const docs = checkout.result?.document?.docs ?? [];
  if (docs.length === 0) {
    throw new DocumentContentError(
      `"${sord.name}" has no document version — there is no file attached to this entry.`,
      eloLink,
    );
  }

  const doc = resolveVersion(args.version, docs, sord.name, eloLink);

  // --- text: cached, being read by another call, or read now ---------------
  const load = (signal?: AbortSignal): Promise<DocumentText> =>
    readText(client, args.objId, doc, options, sord.name, eloLink, trace, signal);
  const versionId = versionIdOf(doc);

  let text: DocumentText;
  if (options.cache && versionId) {
    // Keyed by version, so a new checkin is a new key and nothing stale is
    // served. Reached only after the checkout above succeeded for this caller.
    trace.phase = 'shared';
    const fetched = await options.cache.fetch(`${sord.id}:${versionId}`, load, options.signal);
    trace.cache = fetched.source;
    text = fetched.value;
  } else {
    text = await load(options.signal);
  }
  trace.phase = 'done';
  const { extracted, byteLength, contentSource } = text;

  // --- page ----------------------------------------------------------------
  const limit = Math.min(args.maxChars ?? options.maxChars, options.maxChars);
  const offset = Math.min(args.offset ?? 0, extracted.text.length);
  const slice = sliceOnBoundary(extracted.text, offset, limit);
  const end = offset + slice.length;
  const truncated = end < extracted.text.length;

  return {
    objId: sord.id,
    name: sord.name,
    eloLink,
    path: refPathString(sord),
    parentId: parentIdOf(sord),
    contentType: doc.contentType,
    fileExtension: doc.ext,
    sizeBytes: versionSizeBytes(doc) ?? byteLength,
    versionId: versionIdOf(doc),
    ...(doc.version ? { version: doc.version } : {}),
    isWorkingVersion: doc.workVersion,
    versionComment: doc.comment || undefined,
    versionCreatedIso: doc.createDateIso || undefined,
    contentSource,
    extractor: extracted.extractor,
    format: extracted.format,
    textLayer: extracted.textLayer,
    pageCount: extracted.pageCount,
    text: slice,
    offset,
    charCount: slice.length,
    totalCharCount: extracted.text.length,
    truncated,
    nextOffset: truncated ? end : undefined,
    notice: buildNotice(extracted.notice, {
      truncated,
      objId: sord.id,
      offset,
      end,
      total: extracted.text.length,
    }),
  };
}

/**
 * Download and extract one version — the expensive part, and the only part
 * that takes a content slot. Writes its timings into `trace`, which for a
 * shared read is the trace of the call that started it.
 */
async function readText(
  client: EloClient,
  objId: string,
  doc: EloDocVersion,
  options: GetDocumentContentOptions,
  name: string,
  eloLink: string,
  trace: ReadTrace,
  signal?: AbortSignal,
): Promise<DocumentText> {
  const inSlot: Semaphore = options.slot ?? ((fn) => fn());
  trace.phase = 'queue';
  const queuedAt = performance.now();

  return inSlot(async () => {
    trace.slotWaitMs = since(queuedAt);
    signal?.throwIfAborted();

    // --- acquire bytes -----------------------------------------------------
    trace.phase = 'download';
    const downloadStart = performance.now();
    let bytes: Buffer;
    let contentSource: DocumentText['contentSource'];
    let fileName: string | undefined;

    const inline = doc.fileData?.data;
    if (inline) {
      // Check the encoded length before decoding — never allocate first.
      if ((inline.length * 3) / 4 > options.maxBytes) {
        throw new DocumentContentError(
          `"${name}" is larger than the ${formatMb(options.maxBytes)} limit.`,
          eloLink,
        );
      }
      bytes = Buffer.from(inline, 'base64');
      contentSource = 'inline';
    } else {
      const download = await downloadWithRetry(client, objId, doc, options, name, eloLink, signal);
      bytes = download.data;
      fileName = download.fileName;
      contentSource = 'stream';
    }
    trace.downloadMs = since(downloadStart);
    // Read before extracting: the worker takes the bytes over, and `bytes` is
    // empty afterwards.
    const byteLength = bytes.length;
    trace.bytes = byteLength;

    // --- extract -----------------------------------------------------------
    // In a worker thread, so a large PDF does not stop every other request.
    trace.phase = 'extract';
    const extractStart = performance.now();
    const extracted = await extractTextIsolated(
      { data: bytes, contentType: doc.contentType, ext: doc.ext, fileName },
      options.extractTimeoutMs,
      signal,
    );
    trace.extractMs = since(extractStart);
    return { extracted, byteLength, contentSource };
  }, signal);
}

async function checkoutDoc(client: EloClient, objId: string): Promise<CheckoutResponse> {
  return client.request<CheckoutResponse>('/rest/IXServicePortIF/checkoutDoc', {
    objId,
    // The whole history, so an older version can be picked without a second
    // call — and without ever addressing a docId from another document.
    docId: DOC_ID_ALL_VERSIONS,
    editInfoZ: EDIT_INFO_Z_ALL,
    lockZ: LOCK_Z_NO,
  });
}

/**
 * Find the version the caller asked for, among this document's own versions.
 *
 * The checkout asks for `docId: -1`, so `docs` is the whole history rather than
 * the working version alone. Picking from that list is what makes a version id
 * from another document harmless: ids are archive-wide, and `checkoutDoc` will
 * happily answer for a `docId` that belongs to a different object — measured,
 * no error raised. Selecting from the list we already hold cannot stray.
 */
export function resolveVersion(
  wanted: string | undefined,
  docs: EloDocVersion[],
  name: string,
  eloLink: string,
): EloDocVersion {
  const working = docs[0]!;
  if (!wanted) return working;

  const match = docs.find(
    (d) => versionIdOf(d) === wanted || (d.version && d.version === wanted),
  );
  if (match) return match;

  const available = docs.map((d) => versionIdOf(d)).filter(Boolean).join(', ');
  throw new DocumentContentError(
    `"${name}" has no version "${wanted}". Available: ${available || '(none)'}. ` +
      'Take a versionId from elo_get_metadata for this document.',
    eloLink,
  );
}

/**
 * Content URLs are minted per session and expire within minutes. When ELO
 * rejects one, the fix is a fresh `checkoutDoc` — not a re-login, and not a
 * blind retry of the same URL.
 */
async function downloadWithRetry(
  client: EloClient,
  objId: string,
  doc: EloDocVersion,
  options: GetDocumentContentOptions,
  name: string,
  eloLink: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; fileName?: string }> {
  const url = doc.fileData?.stream?.url ?? doc.url;
  if (!url) {
    throw new DocumentContentError(
      `"${name}" has a document version but ELO returned no content URL for it.`,
      eloLink,
    );
  }

  try {
    return await client.download(url, {
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      signal,
    });
  } catch (err) {
    if (err instanceof EloContentTooLargeError) {
      throw new DocumentContentError(
        `"${name}" exceeds the ${formatMb(options.maxBytes)} size limit and was not downloaded.`,
        eloLink,
      );
    }
    if (!(err instanceof EloStaleStreamError)) throw err;

    logger.debug({ objId }, 'Content URL expired — re-checking out for a fresh one');
    const fresh = await checkoutDoc(client, objId);
    // By id: `version` is empty for every version here (BUGFIXES #29), so
    // matching on it found the working version whatever had been asked for —
    // and with the cache keyed by version id, that wrong text would have been
    // kept under the old version's key. No fallback to docs[0] for the same
    // reason: better no text than another version's.
    const wanted = versionIdOf(doc);
    const freshDoc = fresh.result?.document?.docs?.find((d) => versionIdOf(d) === wanted);
    const freshUrl = freshDoc?.fileData?.stream?.url ?? freshDoc?.url;
    if (!freshUrl) {
      throw new DocumentContentError(
        `The content URL for "${name}" expired and ELO did not issue a new one.`,
        eloLink,
      );
    }
    return client.download(freshUrl, {
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      signal,
    });
  }
}

/** Cut at the nearest whitespace below the limit so words stay intact. */
function sliceOnBoundary(text: string, offset: number, limit: number): string {
  const raw = text.slice(offset, offset + limit);
  if (offset + raw.length >= text.length) return raw;

  const lastBreak = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf(' '));
  // Only honour the boundary if it is not absurdly early in the slice.
  return lastBreak > limit * 0.8 ? raw.slice(0, lastBreak) : raw;
}

function buildNotice(
  extractionNotice: string | undefined,
  page: { truncated: boolean; objId: string; offset: number; end: number; total: number },
): string | undefined {
  const parts: string[] = [];
  if (extractionNotice) parts.push(extractionNotice);
  if (page.truncated) {
    // A boolean flag alone gets ignored; an instruction does not.
    parts.push(
      `Truncated: characters ${page.offset}–${page.end} of ${page.total} returned. To continue, call elo_get_document_content again with objId="${page.objId}" and offset=${page.end}.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
