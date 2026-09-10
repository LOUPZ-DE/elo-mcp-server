import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { LOCK_Z_NO, EDIT_INFO_Z_ALL, isFolder } from '../elo/constants.js';
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
   * How many history entries ELO counts for this object. Present only when it
   * suggests more than the one version above, so that a caller is not left
   * believing the document has only ever had one.
   */
  historyEntryCount?: number;
  note?: string;
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

  const latestVersion = response.result?.document?.docs?.[0];
  // Sord.histCount is ELO's own counter. It is the only signal this server has
  // that a document ever had more than the version it can hand back, so it is
  // reported rather than quietly dropped.
  const histCount = typeof sord.histCount === 'number' ? sord.histCount : undefined;
  const olderVersionsExist = !isFolder(sord.type) && histCount !== undefined && histCount > 1;

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
    docVersion: toDocVersionView(latestVersion),
    ...(olderVersionsExist ? { historyEntryCount: histCount } : {}),
    ...(olderVersionsExist
      ? {
          note:
            `ELO counts ${histCount} history entries for this object, so earlier versions exist. ` +
            'This ELO installation offers no way to list them — checkoutSordHistory returns nothing ' +
            'and no other call exposes the version history. Only the version above can be retrieved.',
        }
      : {}),
  };
}
