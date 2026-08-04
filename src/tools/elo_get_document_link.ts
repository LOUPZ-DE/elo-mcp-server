import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { LOCK_Z_NO, DOC_VERSION_Z_ALL, EDIT_INFO_Z_ALL, isFolder } from '../elo/constants.js';
import { buildEloLink, parentIdOf, refPathString } from '../elo/sord.js';
import { resolveStreamUrl } from '../elo/streamUrl.js';
import { logger } from '../utils/logger.js';
import type { CheckoutResponse } from '../elo/types.js';

export const GetDocumentLinkInputSchema = {
  objId: z.string().min(1).describe('ELO object ID of the document'),
};

const GetDocumentLinkArgs = z.object(GetDocumentLinkInputSchema);
export type GetDocumentLinkArgs = z.infer<typeof GetDocumentLinkArgs>;

export interface DocumentLink {
  objId: string;
  name: string;
  type: 'document' | 'folder';
  /** Archive path of the containing folder — confirm the project before citing. */
  path?: string;
  parentId?: string;
  eloLink: string;
  downloadUrl?: string;
  downloadUrlNote?: string;
  contentType?: string;
  ext?: string;
  sizeBytes?: number;
}

export interface BuildLinkOptions {
  webclientBaseUrl: string;
}

export async function eloGetDocumentLink(
  client: EloClient,
  args: GetDocumentLinkArgs,
  options: BuildLinkOptions,
): Promise<DocumentLink> {
  const body = {
    objId: args.objId,
    // `editInfoZ` is not optional here even though we mainly want the document
    // version: without it IX returns a stripped-down `sord`, so `sord.name` is
    // empty and the link comes back without its `?title=` — the same object then
    // gets two different links depending on which tool produced it. That
    // inconsistency is exactly what the pilot reported.
    editInfoZ: EDIT_INFO_Z_ALL,
    docVersionZ: DOC_VERSION_Z_ALL,
    lockZ: LOCK_Z_NO,
  };

  const response = await client.request<CheckoutResponse>(
    '/rest/IXServicePortIF/checkoutDoc',
    body,
  );

  const sord = response.result?.sord;
  const latestVersion = response.result?.document?.docs?.[0];
  const rawUrl = latestVersion?.fileData?.stream?.url ?? latestVersion?.url;

  let downloadUrl: string | undefined;
  if (rawUrl) {
    try {
      downloadUrl = resolveStreamUrl(client.baseUrl, rawUrl);
    } catch (err) {
      // A bad content URL must not sink the whole call — the eloLink is the
      // part callers actually need.
      logger.warn(
        { objId: args.objId, err: err instanceof Error ? err.message : err },
        'Could not resolve document content URL',
      );
    }
  }

  return {
    objId: args.objId,
    name: sord?.name ?? 'Unknown',
    type: sord && isFolder(sord.type) ? 'folder' : 'document',
    path: sord ? refPathString(sord) : undefined,
    parentId: sord ? parentIdOf(sord) : undefined,
    eloLink: buildEloLink(options.webclientBaseUrl, args.objId, sord?.name),
    downloadUrl,
    downloadUrlNote: downloadUrl
      ? 'Temporary URL, valid ~1–10 minutes, and it requires the server session — external clients (browsers, Notion) cannot open it. Use elo_get_document_content to read the document, or eloLink to point a human at it.'
      : undefined,
    contentType: latestVersion?.contentType,
    ext: latestVersion?.ext,
    sizeBytes: latestVersion?.size,
  };
}
