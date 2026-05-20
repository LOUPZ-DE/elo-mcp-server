import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { isFolder, SORD_Z_ALL } from '../elo/constants.js';
import type { FindResponse } from '../elo/types.js';

export const SearchInputSchema = {
  query: z.string().min(1).describe('Search term (document name, project number, keyword)'),
  searchIn: z
    .enum(['TITLE', 'FULLTEXT', 'INDEX_FIELDS', 'TITLE,FULLTEXT,INDEX_FIELDS'])
    .optional()
    .describe('Search scope; defaults to all'),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Max results to return (default 100, max 500)'),
};

const SearchArgs = z.object(SearchInputSchema);
export type SearchArgs = z.infer<typeof SearchArgs>;

export interface SearchResult {
  objId: string;
  name: string;
  type: 'document' | 'folder';
  maskName?: string;
  xDateIso?: string;
  ownerName?: string;
}

export async function eloSearch(
  client: EloClient,
  args: SearchArgs,
): Promise<SearchResult[]> {
  const body = {
    findInfo: {
      findByESearch: {
        searchOptions: {},
        searchParams: {
          query: args.query,
          searchIn: args.searchIn ?? 'TITLE,FULLTEXT,INDEX_FIELDS',
        },
      },
    },
    max: args.maxResults ?? 100,
    sordZ: SORD_Z_ALL,
  };

  const response = await client.request<FindResponse>(
    '/rest/IXServicePortIF/findFirstSords',
    body,
  );

  const sords = response.result?.sords ?? [];
  return sords.map((s) => ({
    objId: s.id,
    name: s.name,
    type: isFolder(s.type) ? 'folder' : 'document',
    maskName: s.maskName,
    xDateIso: s.xDateIso,
    ownerName: s.ownerName,
  }));
}
