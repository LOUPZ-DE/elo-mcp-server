import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { LOCK_Z_NO, DOC_VERSION_Z_ALL } from '../elo/constants.js';
import type { CheckoutResponse } from '../elo/types.js';

export const GetDocumentLinkInputSchema = {
  objId: z.string().min(1).describe('ELO object ID of the document'),
};

const GetDocumentLinkArgs = z.object(GetDocumentLinkInputSchema);
export type GetDocumentLinkArgs = z.infer<typeof GetDocumentLinkArgs>;

export interface DocumentLink {
  objId: string;
  name: string;
  eloLink: string;
  downloadUrl?: string;
  downloadUrlNote?: string;
  contentType?: string;
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
    docVersionZ: DOC_VERSION_Z_ALL,
    lockZ: LOCK_Z_NO,
  };

  const response = await client.request<CheckoutResponse>(
    '/rest/IXServicePortIF/checkoutDoc',
    body,
  );

  const sord = response.result?.sord;
  const latestVersion = response.result?.document?.docs?.[0];
  const streamUrl = latestVersion?.fileData?.stream?.url;

  // Loupz uses a short-link service at elo-link.loupz.de that redirects
  // `/<objId>` to the actual web-client document view. The `?title=…` query
  // parameter is cosmetic only (display in the browser tab) but ELO uses it.
  const titleParam = sord?.name
    ? `?title=${encodeURIComponent(sord.name)}`
    : '';
  const eloLink = `${options.webclientBaseUrl.replace(/\/$/, '')}/${args.objId}${titleParam}`;

  const downloadUrl = streamUrl
    ? streamUrl.startsWith('http')
      ? streamUrl
      : `${client.baseUrl.replace(/\/$/, '')}${streamUrl.startsWith('/') ? '' : '/'}${streamUrl}`
    : undefined;

  return {
    objId: args.objId,
    name: sord?.name ?? 'Unknown',
    eloLink,
    downloadUrl,
    downloadUrlNote: downloadUrl
      ? 'Temporary URL — valid for ~1–10 minutes only. Do not persist.'
      : undefined,
    contentType: latestVersion?.contentType,
  };
}
