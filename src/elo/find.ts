// One wrapper around `findFirstSords`, so every search path shares the same
// result handling and — importantly — releases the server-side search handle.
//
// IX keeps search state per session and hands back a `searchId`. `EloClient` is
// a module-level singleton with an 8-minute session, and nothing used to call
// `findClose`, so every search leaked a slot for the life of the session.

import { EloClient } from './client.js';
import { SORD_Z_ALL } from './constants.js';
import { logger } from '../utils/logger.js';
import type { EloSord, FindResponse } from './types.js';

export interface FindOutcome {
  sords: EloSord[];
  /** IX says more hits exist beyond `max` (verified populated, probe P7). */
  moreResults: boolean;
  /** IX's estimate of the total hit count; undefined when it reports -1. */
  estimatedCount?: number;
}

export interface FindOptions {
  max: number;
  sordZ?: unknown;
}

export async function runFind(
  client: EloClient,
  findInfo: unknown,
  opts: FindOptions,
): Promise<FindOutcome> {
  const response = await client.request<FindResponse>('/rest/IXServicePortIF/findFirstSords', {
    findInfo,
    max: opts.max,
    sordZ: opts.sordZ ?? SORD_Z_ALL,
  });

  const result = response.result;
  const searchId = result?.searchId;
  if (searchId) {
    // Best effort: a leaked handle is a slow leak, a thrown error here would
    // discard a perfectly good result set.
    try {
      await client.request('/rest/IXServicePortIF/findClose', { searchId });
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, 'findClose failed');
    }
  }

  const estimated = result?.estimatedCount;
  return {
    sords: result?.sords ?? [],
    moreResults: result?.moreResults === true,
    estimatedCount: typeof estimated === 'number' && estimated >= 0 ? estimated : undefined,
  };
}

/**
 * Full-text / index search across the whole archive.
 *
 * Cannot be restricted to a subtree: `findByESearch` runs on the separate
 * iSearch engine and ignores `findChildren`, `searchParams.parentId`,
 * `searchOptions.parentId` and `searchParams.pathId` alike — all four were
 * probed against the live instance and every one returned hits from outside
 * the requested folder (probe P5). Use `findInFolder` when scoping matters.
 */
export function eSearchInfo(query: string, searchIn: string): unknown {
  return {
    findByESearch: {
      searchOptions: {},
      searchParams: { query, searchIn },
    },
  };
}

/**
 * Children of a folder, optionally filtered by name.
 *
 * `findChildren` + `findByIndex` combine with AND and the scope holds
 * (probe P4). `endLevel` is a depth: 1 = direct children, 2 = two levels down,
 * and so on; 0 behaves like 1 (probe P11). There is no `findByParent` — it
 * exists in the JavaDoc but IX rejects it as "no search criteria given".
 */
export function findInFolder(
  parentId: string,
  opts: { depth?: number; namePattern?: string } = {},
): unknown {
  const findInfo: Record<string, unknown> = {
    findChildren: { parentId, endLevel: opts.depth ?? 1 },
  };
  if (opts.namePattern) {
    findInfo.findByIndex = { name: opts.namePattern };
  }
  return findInfo;
}

/** Exact match on index fields — deterministic, unlike the fuzzy title search. */
export function indexInfo(objKeys: Array<{ name: string; data: string[] }>): unknown {
  return { findByIndex: { objKeys } };
}
