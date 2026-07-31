import { z } from 'zod';
import { EloClient, EloContentTooLargeError, EloStaleStreamError } from '../elo/client.js';
import { LOCK_Z_NO, DOC_VERSION_Z_ALL, EDIT_INFO_Z_ALL, isFolder } from '../elo/constants.js';
import { buildEloLink, parentIdOf, refPathString } from '../elo/sord.js';
import { extractText } from '../extract/index.js';
import { logger } from '../utils/logger.js';
import type { CheckoutResponse, EloDocVersion, EloSord } from '../elo/types.js';

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
    .describe('Specific document version. Defaults to the current one.'),
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
  version?: string;
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
}

/** Raised for conditions the model should act on rather than retry. */
export class DocumentContentError extends Error {
  constructor(
    message: string,
    readonly eloLink?: string,
  ) {
    super(eloLink ? `${message} Link: ${eloLink}` : message);
  }
}

export async function eloGetDocumentContent(
  client: EloClient,
  args: GetDocumentContentArgs,
  options: GetDocumentContentOptions,
): Promise<DocumentContent> {
  const checkout = await checkoutDoc(client, args.objId);
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

  const doc = selectVersion(docs, args.version, sord.name, eloLink);

  // --- acquire bytes -------------------------------------------------------
  let bytes: Buffer;
  let contentSource: DocumentContent['contentSource'];
  let fileName: string | undefined;

  const inline = doc.fileData?.data;
  if (inline) {
    // Check the encoded length before decoding — never allocate first.
    if ((inline.length * 3) / 4 > options.maxBytes) {
      throw new DocumentContentError(
        `"${sord.name}" is larger than the ${formatMb(options.maxBytes)} limit.`,
        eloLink,
      );
    }
    bytes = Buffer.from(inline, 'base64');
    contentSource = 'inline';
  } else {
    const download = await downloadWithRetry(client, args.objId, doc, options, sord.name, eloLink);
    bytes = download.data;
    fileName = download.fileName;
    contentSource = 'stream';
  }

  // --- extract -------------------------------------------------------------
  const extracted = await extractText({
    data: bytes,
    contentType: doc.contentType,
    ext: doc.ext,
    fileName,
  });

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
    sizeBytes: doc.size ?? bytes.length,
    version: doc.version,
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

async function checkoutDoc(client: EloClient, objId: string): Promise<CheckoutResponse> {
  return client.request<CheckoutResponse>('/rest/IXServicePortIF/checkoutDoc', {
    objId,
    editInfoZ: EDIT_INFO_Z_ALL,
    docVersionZ: DOC_VERSION_Z_ALL,
    lockZ: LOCK_Z_NO,
  });
}

function selectVersion(
  docs: EloDocVersion[],
  wanted: string | undefined,
  name: string,
  eloLink: string,
): EloDocVersion {
  if (!wanted) return docs[0]!;
  const match = docs.find((d) => d.version === wanted);
  if (match) return match;
  const available = docs.map((d) => d.version).filter(Boolean).join(', ');
  throw new DocumentContentError(
    `"${name}" has no version "${wanted}". Available: ${available || '(none)'}.`,
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
    const freshDoc = fresh.result?.document?.docs?.find((d) => d.version === doc.version)
      ?? fresh.result?.document?.docs?.[0];
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
