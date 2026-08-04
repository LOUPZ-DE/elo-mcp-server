import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { isFolder } from '../elo/constants.js';
import { runFind, eSearchInfo, findInFolder } from '../elo/find.js';
import { toSordView, isInsideFolder, type SordView } from '../elo/sord.js';
import type { EloSord } from '../elo/types.js';

export const SearchInputSchema = {
  query: z.string().min(1).describe('Search term (document name, project number, keyword)'),
  searchIn: z
    .enum(['TITLE', 'FULLTEXT', 'INDEX_FIELDS', 'TITLE,FULLTEXT,INDEX_FIELDS'])
    .optional()
    .describe('Search scope; defaults to all. Ignored when parentId is set (see engine).'),
  parentId: z
    .string()
    .optional()
    .describe(
      'Restrict the search to this folder and everything below it. Get the id from elo_find_project_folder. Strongly recommended for project-specific questions.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('How many folder levels below parentId to search. Default 5. Only used with parentId.'),
  type: z
    .enum(['document', 'folder', 'any'])
    .optional()
    .describe('Restrict results to documents or folders. Default any.'),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Max results to return (default 20, max 100)'),
  offset: z.number().int().min(0).optional().describe('Skip this many results (paging)'),
};

const SearchArgs = z.object(SearchInputSchema);
export type SearchArgs = z.infer<typeof SearchArgs>;

export interface SearchResult {
  query: string;
  /**
   * 'esearch' = iSearch full-text engine, archive-wide.
   * 'index'   = database find engine, scoped to a folder subtree but title/index
   *             only. The two cannot be combined (see below).
   */
  engine: 'esearch' | 'index';
  searchIn?: string;
  scope?: { parentId: string; depth: number };
  returned: number;
  offset: number;
  truncated: boolean;
  estimatedTotal?: number;
  note: string;
  results: SordView[];
}

export interface SearchOptions {
  webclientBaseUrl: string;
  /** Index fields surfaced on every hit so the model can tell projects apart. */
  projectIndexFields: string[];
}

const DEFAULT_MAX = 20;
const DEFAULT_DEPTH = 5;

/**
 * Client-side type filtering and paging happen after the fetch, so the window
 * has to be wider than what we return. Capped to keep the IX round-trip sane.
 */
const OVER_FETCH = 3;
const MAX_WINDOW = 500;

export async function eloSearch(
  client: EloClient,
  args: SearchArgs,
  options: SearchOptions,
): Promise<SearchResult> {
  const limit = args.maxResults ?? DEFAULT_MAX;
  const offset = args.offset ?? 0;
  const wantType = args.type ?? 'any';
  const depth = args.depth ?? DEFAULT_DEPTH;

  const needsClientFilter = wantType !== 'any' || offset > 0;
  const window = Math.min(needsClientFilter ? (offset + limit) * OVER_FETCH : limit, MAX_WINDOW);

  // Scoped search must use the database find engine. `findByESearch` runs on a
  // separate iSearch engine that silently ignores every scoping mechanism IX
  // offers — findChildren, searchParams.parentId, searchOptions.parentId and
  // searchParams.pathId were each probed against the live instance and all four
  // returned hits from unrelated folders (probe P5). Rather than pretend the
  // scope applied, we switch engines and say so in `note`.
  const scoped = Boolean(args.parentId);
  const searchIn = args.searchIn ?? 'TITLE,FULLTEXT,INDEX_FIELDS';

  const findInfo = scoped
    ? findInFolder(args.parentId!, { depth, namePattern: toNamePattern(args.query) })
    : eSearchInfo(args.query, searchIn);

  const outcome = await runFind(client, findInfo, { max: window });

  let sords: EloSord[] = outcome.sords;

  // Belt and braces: even on the scoped engine, verify every hit really sits
  // inside the requested folder before telling the user it does.
  if (scoped) {
    sords = sords.filter((s) => isInsideFolder(s, args.parentId!));
  }
  if (wantType !== 'any') {
    sords = sords.filter((s) => (wantType === 'folder' ? isFolder(s.type) : !isFolder(s.type)));
  }

  const total = sords.length;
  const page = sords.slice(offset, offset + limit);
  const truncated = outcome.moreResults || total > offset + limit;

  return {
    query: args.query,
    engine: scoped ? 'index' : 'esearch',
    searchIn: scoped ? undefined : searchIn,
    scope: scoped ? { parentId: args.parentId!, depth } : undefined,
    returned: page.length,
    offset,
    truncated,
    estimatedTotal: outcome.estimatedCount,
    note: buildNote({ scoped, truncated, returned: page.length, depth }),
    results: page.map((s) =>
      toSordView(s, {
        webclientBaseUrl: options.webclientBaseUrl,
        indexFields: options.projectIndexFields,
      }),
    ),
  };
}

/**
 * The scoped engine matches index/title patterns, not free text, so the query
 * becomes a contains-pattern. Callers who already wrote wildcards keep them.
 */
function toNamePattern(query: string): string {
  return /[*?]/.test(query) ? query : `*${query}*`;
}

function buildNote(ctx: {
  scoped: boolean;
  truncated: boolean;
  returned: number;
  depth: number;
}): string {
  const parts: string[] = [];

  if (ctx.returned === 0) {
    parts.push(
      ctx.scoped
        ? 'No matches inside that folder. Widen `depth`, try elo_list_folder to see what is actually there, or drop parentId to search the whole archive.'
        : 'No matches. Try fewer or different terms.',
    );
  }

  if (ctx.scoped) {
    parts.push(
      `Scoped to the folder subtree (${ctx.depth} levels). ELO cannot combine full-text search with a folder restriction, so this searched titles and index fields only — document *content* was not searched.`,
    );
  }

  if (ctx.truncated) {
    parts.push(
      'More matches exist than are shown. This list is NOT complete — narrow the query, set parentId, or page with offset before drawing conclusions.',
    );
  }

  parts.push(
    'Each result carries its `path` and a ready-made `eloLink`. Use them verbatim; hits from different projects are otherwise indistinguishable.',
  );

  return parts.join(' ');
}
