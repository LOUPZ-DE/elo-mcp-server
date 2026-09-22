import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { LOCK_Z_NO, EDIT_INFO_Z_ALL, DOC_ID_ALL_VERSIONS, isFolder } from '../elo/constants.js';
import { allIndexFields, buildEloLink, parentIdOf, refPathString } from '../elo/sord.js';
import type { CheckoutResponse } from '../elo/types.js';
import { toDocVersionView, type DocVersionView } from '../elo/docVersion.js';

export const GetMetadataInputSchema = {
  objId: z.string().min(1).describe('ELO object ID'),
};

const GetMetadataArgs = z.object(GetMetadataInputSchema);
export type GetMetadataArgs = z.infer<typeof GetMetadataArgs>;

export interface DocumentMetadata {
  objId: string;
  name: string;
  type: 'document' | 'folder';
  /** Archive path of the containing folder — verify the project with this. */
  path?: string;
  parentId?: string;
  eloLink: string;
  maskName?: string;
  ownerName?: string;
  desc?: string;
  createDateIso?: string;
  xDateIso?: string;
  indexFields: Record<string, string>;
  /**
   * The version ELO serves by default — the only one this instance hands out.
   * Its `versionId` is what elo_get_document_content takes as `version`.
   */
  docVersion?: DocVersionView;
  /**
   * Every version, newest first — the same object `docVersion` repeats as its
   * first entry. Absent on folders, which have none.
   *
   * Each entry's `versionId` goes straight back into elo_get_document_content
   * as `version` to read that version's text.
   */
  versions?: DocVersionView[];
}

export interface GetMetadataOptions {
  webclientBaseUrl: string;
}

export async function eloGetMetadata(
  client: EloClient,
  args: GetMetadataArgs,
  options: GetMetadataOptions,
): Promise<DocumentMetadata> {
  const body = {
    objId: args.objId,
    // Every version, not just the working one. A folder answers with none.
    docId: DOC_ID_ALL_VERSIONS,
    editInfoZ: EDIT_INFO_Z_ALL,
    lockZ: LOCK_Z_NO,
  };

  // NOTE: We use `checkoutDoc`, not `checkoutSord`. In this IX version,
  // checkoutSord returns an EditInfo with the lookup tables (keywords,
  // markerNames, mask, …) but leaves the `sord` field empty regardless of
  // editInfoZ settings. checkoutDoc with editInfoZ:{bset:'-1'} returns both
  // sord and document — and `eloGetDocumentLink` already uses it successfully.
  const response = await client.request<CheckoutResponse>(
    '/rest/IXServicePortIF/checkoutDoc',
    body,
  );

  const sord = response.result?.sord;
  if (!sord) {
    throw new Error(`No object with objId=${args.objId} found.`);
  }

  // Newest first, as IX orders them.
  const docs = response.result?.document?.docs ?? [];

  return {
    objId: sord.id,
    name: sord.name,
    type: isFolder(sord.type) ? 'folder' : 'document',
    path: refPathString(sord),
    parentId: parentIdOf(sord),
    eloLink: buildEloLink(options.webclientBaseUrl, sord.id, sord.name),
    maskName: sord.maskName,
    ownerName: sord.ownerName,
    desc: sord.desc || undefined,
    createDateIso: sord.IDateIso,
    // IX spells this with a capital X; reading the lowercase variant returned
    // undefined on every single call before this was fixed.
    xDateIso: sord.XDateIso ?? sord.xDateIso,
    indexFields: allIndexFields(sord),
    docVersion: toDocVersionView(docs[0]),
    ...(docs.length > 0
      ? { versions: docs.map((v) => toDocVersionView(v)!) }
      : {}),
  };
}
