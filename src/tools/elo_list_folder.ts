import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { isFolder } from '../elo/constants.js';
import { runFind, findInFolder } from '../elo/find.js';
import { toSordView, isInsideFolder, type SordView } from '../elo/sord.js';
import type { EloSord } from '../elo/types.js';

export const ListFolderInputSchema = {
  folderId: z
    .string()
    .min(1)
    .describe('objId of the folder to list. Get it from elo_find_project_folder or elo_search.'),
  nameFilter: z
    .string()
    .optional()
    .describe('Only entries whose name contains this text, e.g. "Monatsbericht".'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Folder levels to descend. 1 = direct children only (default).'),
  type: z
    .enum(['document', 'folder', 'any'])
    .optional()
    .describe('Restrict to documents or sub-folders. Default any.'),
  sortBy: z
    .enum(['name', 'changed', 'created'])
    .optional()
    .describe('Sort order. Default name.'),
  maxResults: z.number().int().positive().max(200).optional().describe('Default 50, max 200'),
  offset: z.number().int().min(0).optional().describe('Skip this many entries (paging)'),
};

const ListFolderArgs = z.object(ListFolderInputSchema);
export type ListFolderArgs = z.infer<typeof ListFolderArgs>;

export interface ListFolderResult {
  folderId: string;
  depth: number;
  nameFilter?: string;
  returned: number;
  offset: number;
  truncated: boolean;
  note: string;
  results: SordView[];
}

export interface ListFolderOptions {
  webclientBaseUrl: string;
  projectIndexFields: string[];
}

const DEFAULT_MAX = 50;
const MAX_WINDOW = 1000;

export async function eloListFolder(
  client: EloClient,
  args: ListFolderArgs,
  options: ListFolderOptions,
): Promise<ListFolderResult> {
  const limit = args.maxResults ?? DEFAULT_MAX;
  const offset = args.offset ?? 0;
  const depth = args.depth ?? 1;
  const wantType = args.type ?? 'any';

  // Sorting and type filtering are client-side, so the fetch window must cover
  // everything we might sort over — otherwise "the newest report" would only be
  // the newest within an arbitrary slice.
  const window = Math.min(Math.max((offset + limit) * 3, 200), MAX_WINDOW);

  const outcome = await runFind(
    client,
    findInFolder(args.folderId, {
      depth,
      namePattern: args.nameFilter ? `*${args.nameFilter}*` : undefined,
    }),
    { max: window },
  );

  let sords: EloSord[] = outcome.sords.filter(
    (s) => String(s.id) !== String(args.folderId) && isInsideFolder(s, args.folderId),
  );

  if (wantType !== 'any') {
    sords = sords.filter((s) => (wantType === 'folder' ? isFolder(s.type) : !isFolder(s.type)));
  }

  sords = sortSords(sords, args.sortBy ?? 'name');

  const total = sords.length;
  const page = sords.slice(offset, offset + limit);
  const windowFull = outcome.sords.length >= window;
  const truncated = outcome.moreResults || windowFull || total > offset + limit;

  return {
    folderId: args.folderId,
    depth,
    nameFilter: args.nameFilter,
    returned: page.length,
    offset,
    truncated,
    note: buildNote({
      returned: page.length,
      truncated,
      windowFull,
      depth,
      sortBy: args.sortBy ?? 'name',
      hasFilter: Boolean(args.nameFilter),
    }),
    results: page.map((s) =>
      toSordView(s, {
        webclientBaseUrl: options.webclientBaseUrl,
        indexFields: options.projectIndexFields,
      }),
    ),
  };
}

function sortSords(sords: EloSord[], sortBy: 'name' | 'changed' | 'created'): EloSord[] {
  const key = (s: EloSord): string =>
    sortBy === 'changed' ? (s.XDateIso ?? s.xDateIso ?? '') : sortBy === 'created' ? (s.IDateIso ?? '') : '';

  if (sortBy === 'name') {
    return [...sords].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  }
  // Dates are ISO-ish strings ("20260715090000"), so lexical compare is
  // chronological. Newest first — that is what "the latest report" means.
  return [...sords].sort((a, b) => key(b).localeCompare(key(a)));
}

function buildNote(ctx: {
  returned: number;
  truncated: boolean;
  windowFull: boolean;
  depth: number;
  sortBy: string;
  hasFilter: boolean;
}): string {
  const parts: string[] = [];

  if (ctx.returned === 0) {
    parts.push(
      ctx.hasFilter
        ? 'Nothing matched that name filter in this folder. Try listing without a filter first to see what is there.'
        : 'This folder is empty at the requested depth. Increase `depth` to look further down.',
    );
  }

  if (ctx.depth === 1) {
    parts.push('Direct children only — sub-folder contents are not included. Raise `depth` to descend.');
  }

  if (ctx.truncated) {
    // Being explicit matters: a truncated page that was then sorted looks
    // authoritative but is not. "The newest" may sit outside the window.
    parts.push(
      `Not all entries were retrieved, and sorting by ${ctx.sortBy} applied only to the entries that were. Do not present the first result as "the latest" or "the only one" — narrow with nameFilter or page with offset.`,
    );
  }

  parts.push('Use each entry\'s `eloLink` verbatim when referring to it.');

  return parts.join(' ');
}
