import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { LOCK_Z_NO, EDIT_INFO_Z_ALL } from '../elo/constants.js';
import type { CheckoutResponse } from '../elo/types.js';

export const GetMetadataInputSchema = {
  objId: z.string().min(1).describe('ELO object ID'),
};

const GetMetadataArgs = z.object(GetMetadataInputSchema);
export type GetMetadataArgs = z.infer<typeof GetMetadataArgs>;

export interface DocumentMetadata {
  objId: string;
  name: string;
  maskName?: string;
  ownerName?: string;
  createDateIso?: string;
  xDateIso?: string;
  indexFields: Record<string, string>;
  docVersion?: {
    version?: string;
    comment?: string;
    contentType?: string;
  };
}

export async function eloGetMetadata(
  client: EloClient,
  args: GetMetadataArgs,
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

  const indexFields: Record<string, string> = {};
  for (const key of sord.objKeys ?? []) {
    if (key.name && key.data && key.data.length > 0 && key.data[0]) {
      indexFields[key.name] = key.data[0];
    }
  }

  const latestVersion = response.result?.document?.docs?.[0];

  return {
    objId: sord.id,
    name: sord.name,
    maskName: sord.maskName,
    ownerName: sord.ownerName,
    createDateIso: sord.IDateIso,
    xDateIso: sord.xDateIso,
    indexFields,
    docVersion: latestVersion
      ? {
          version: latestVersion.version,
          comment: latestVersion.comment,
          contentType: latestVersion.contentType,
        }
      : undefined,
  };
}
