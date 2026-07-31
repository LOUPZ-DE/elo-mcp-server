import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { isFolder } from '../elo/constants.js';
import { runFind, eSearchInfo, indexInfo } from '../elo/find.js';
import { indexField, toSordView, type SordView } from '../elo/sord.js';
import type { EloSord } from '../elo/types.js';

export const FindProjectFolderInputSchema = {
  projectNumber: z
    .string()
    .optional()
    .describe('Project number, e.g. "10042". Preferred — this is matched exactly.'),
  projectName: z
    .string()
    .optional()
    .describe('Project name, e.g. "Musterstadt Schulungen". Fuzzy — may match several projects.'),
  includeNonProjectFolders: z
    .boolean()
    .optional()
    .describe(
      'Include folders that are not marked as project data rooms. Default false; set true only when a search returned nothing.',
    ),
};

const FindProjectFolderArgs = z
  .object(FindProjectFolderInputSchema)
  .refine((d) => Boolean(d.projectNumber || d.projectName), {
    message: 'Either projectNumber or projectName is required.',
  });
export type FindProjectFolderArgs = z.infer<typeof FindProjectFolderArgs>;

/** How a candidate was found — 'exact' is authoritative, 'fuzzy' is a guess. */
export type MatchType = 'exact' | 'fuzzy';

export interface ProjectCandidate {
  sord: EloSord;
  matchType: MatchType;
  isProjectRoot: boolean;
}

export interface ProjectFolder extends SordView {
  matchType: MatchType;
  isProjectRoot: boolean;
  projectNumber?: string;
  projectName?: string;
}

export interface FindProjectFolderResult {
  query: string;
  matchMode: 'exact' | 'fuzzy' | 'none';
  exactCount: number;
  returned: number;
  note: string;
  results: ProjectFolder[];
}

export interface FindProjectFolderOptions {
  webclientBaseUrl: string;
  projectNumberField: string;
  projectNameField: string;
  projectMarkerField: string;
  projectMarkerValue: string;
}

/**
 * The fuzzy search runs before the folder filter, so it has to over-fetch:
 * IX applies `max` first and we drop documents afterwards. At `max: 50` a
 * project folder could be pushed out of the window by 50 document hits and
 * vanish silently — which is what used to happen.
 */
const FUZZY_MAX = 200;

/**
 * Order: exact+root > exact > root > fuzzy, then by name.
 *
 * This is the fix for the "wrong data room" reports. Folder titles and project
 * index fields drift apart over a project's life, and it is common for a title
 * search on a project number to surface a *different* folder than the one
 * actually carrying that number — typically an acquisition folder rather than
 * the project data room. Confirmed on a live archive. Both used to be returned
 * unlabelled and unordered, so whichever landed first won.
 */
export function rankProjectFolders(candidates: ProjectCandidate[]): ProjectCandidate[] {
  const score = (c: ProjectCandidate): number =>
    (c.matchType === 'exact' ? 2 : 0) + (c.isProjectRoot ? 1 : 0);
  return [...candidates].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.sord.name.localeCompare(b.sord.name, 'de');
  });
}

export async function eloFindProjectFolder(
  client: EloClient,
  args: FindProjectFolderArgs,
  options: FindProjectFolderOptions,
): Promise<FindProjectFolderResult> {
  const query = args.projectNumber ?? args.projectName ?? '';
  if (!query) {
    throw new Error('Either projectNumber or projectName is required.');
  }

  const isRoot = (s: EloSord): boolean =>
    indexField(s, options.projectMarkerField) === options.projectMarkerValue;

  const seen = new Set<string>();
  const candidates: ProjectCandidate[] = [];
  const add = (sord: EloSord, matchType: MatchType): void => {
    if (!isFolder(sord.type) || seen.has(sord.id)) return;
    seen.add(sord.id);
    candidates.push({ sord, matchType, isProjectRoot: isRoot(sord) });
  };

  // Stage 1 — exact index lookup. Only meaningful for a project number.
  if (args.projectNumber) {
    const exact = await runFind(
      client,
      indexInfo([{ name: options.projectNumberField, data: [args.projectNumber] }]),
      { max: 50 },
    );
    for (const sord of exact.sords) add(sord, 'exact');
  }

  const exactCount = candidates.length;

  // Stage 2 — fuzzy fallback. Always run when nothing exact was found, and for
  // name lookups where no exact path exists.
  if (exactCount === 0) {
    const fuzzy = await runFind(
      client,
      eSearchInfo(query, 'TITLE,INDEX_FIELDS'),
      { max: FUZZY_MAX },
    );
    for (const sord of fuzzy.sords) add(sord, 'fuzzy');
  }

  // Stage 3 — rank, then drop non-project folders once a real data room exists.
  const ranked = rankProjectFolders(candidates);
  const hasRoot = ranked.some((c) => c.isProjectRoot);
  const filtered =
    hasRoot && !args.includeNonProjectFolders ? ranked.filter((c) => c.isProjectRoot) : ranked;

  const results: ProjectFolder[] = filtered.map((c) => ({
    ...toSordView(c.sord, {
      webclientBaseUrl: options.webclientBaseUrl,
      indexFields: [options.projectNumberField, options.projectNameField, options.projectMarkerField],
    }),
    matchType: c.matchType,
    isProjectRoot: c.isProjectRoot,
    projectNumber: indexField(c.sord, options.projectNumberField),
    projectName: indexField(c.sord, options.projectNameField),
  }));

  const matchMode: FindProjectFolderResult['matchMode'] =
    results.length === 0 ? 'none' : exactCount > 0 ? 'exact' : 'fuzzy';

  return {
    query,
    matchMode,
    exactCount,
    returned: results.length,
    note: buildNote(matchMode, results, hasRoot, args),
    results,
  };
}

function buildNote(
  matchMode: FindProjectFolderResult['matchMode'],
  results: ProjectFolder[],
  hasRoot: boolean,
  args: FindProjectFolderArgs,
): string {
  if (matchMode === 'none') {
    return args.projectNumber
      ? `No project folder found for "${args.projectNumber}". The number may belong to a different index field, or the project may not exist. Do not substitute a similarly named folder.`
      : `No project folder found for "${args.projectName}". Try the project number instead.`;
  }
  if (matchMode === 'exact') {
    return results.length === 1
      ? 'Exact index-field match — authoritative. Use this folder and its objId for follow-up calls.'
      : `${results.length} folders carry this exact project number. Ask the user which one is meant.`;
  }
  const base = hasRoot
    ? 'No exact match on the project number; these are fuzzy title/index hits, filtered to folders marked as project data rooms.'
    : 'No exact match, and none of these folders is marked as a project data room — they may be sub-folders rather than the project itself.';
  return results.length > 1
    ? `${base} ${results.length} candidates — ask the user which project is meant instead of picking one.`
    : base;
}
