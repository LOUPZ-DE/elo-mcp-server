// Mapping of raw IX `Sord` objects into the compact, self-sufficient shape we
// hand to LLMs.
//
// The guiding rule comes from pilot feedback: a search hit that carries only an
// objId forces the model to work out the folder and the link on its own, and it
// gets both wrong intermittently. Every view produced here therefore carries
// *where* the object lives (`path`, `parentId`) and a ready-made `eloLink` the
// model can copy verbatim.

import { isFolder } from './constants.js';
import type { EloSord } from './types.js';

export interface SordView {
  objId: string;
  name: string;
  type: 'document' | 'folder';
  /** Raw IX type number — folders are < 254, documents >= 254. */
  sordType: number;
  /** Archive path of the *containing* folder, e.g. "/Projekte/Beratung". */
  path?: string;
  /** objId of the containing folder. */
  parentId?: string;
  /** Always present. Copy verbatim — never rebuild a link from parts. */
  eloLink: string;
  maskName?: string;
  desc?: string;
  indexFields?: Record<string, string>;
  createdIso?: string;
  changedIso?: string;
  ownerName?: string;
  /** Direct children; only meaningful on folders. */
  childCount?: number;
  /**
   * Number of *additional* folders this object is filed in beyond `path`.
   * ELO allows one object to hang in several places; when this is > 0 the
   * reported `path` is one of several and the model should say so.
   */
  otherPathCount?: number;
}

export interface SordViewOptions {
  webclientBaseUrl: string;
  /** Index fields to include. Omit for none; pass '*' for all. */
  indexFields?: string[] | '*';
}

/**
 * The single source of truth for ELO links.
 *
 * `?title=` is cosmetic (browser tab caption) but ELO emits it, so we match.
 * Verified against the live instance: the short-link service resolves both
 * document and folder ids the same way (probe P9).
 */
export function buildEloLink(webclientBaseUrl: string, objId: string, name?: string): string {
  const base = webclientBaseUrl.replace(/\/$/, '');
  const title = name ? `?title=${encodeURIComponent(name)}` : '';
  return `${base}/${objId}${title}`;
}

/**
 * Archive path of the folder containing `sord`, e.g. "/Projekte/Beratung".
 *
 * IX returns `refPaths` as objects with a `.path` array (BUGFIXES #11) that
 * *excludes* the object itself (verified, probe P2), so this is the parent
 * chain, not the object's own path. `pathAsString` is deliberately unused: it
 * is pilcrow-separated and we would only have to split it again.
 */
export function refPathString(sord: EloSord): string | undefined {
  const path = sord.refPaths?.[0]?.path;
  if (!path || path.length === 0) return undefined;
  return `/${path.map((p) => p.name).join('/')}`;
}

/** objId of the containing folder, or undefined at the archive root. */
export function parentIdOf(sord: EloSord): string | undefined {
  // IX serialises parentId as a number; normalise. `0` and `-1` are sentinels
  // for "no parent" and must not become the string "0".
  if (sord.parentId !== undefined && sord.parentId !== null) {
    const raw = String(sord.parentId);
    if (raw !== '' && raw !== '0' && raw !== '-1') return raw;
  }
  const path = sord.refPaths?.[0]?.path;
  const last = path?.[path.length - 1];
  return last?.id !== undefined ? String(last.id) : undefined;
}

/** Every non-empty index field as a flat map. */
export function allIndexFields(sord: EloSord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of sord.objKeys ?? []) {
    const value = key.data?.[0];
    if (key.name && value) out[key.name] = value;
  }
  return out;
}

/**
 * Only the named index fields. Search results use this — dumping all 30 mask
 * fields per hit buries the few that identify the project.
 */
export function pickIndexFields(sord: EloSord, names: string[]): Record<string, string> {
  const all = allIndexFields(sord);
  const out: Record<string, string> = {};
  for (const name of names) {
    if (all[name]) out[name] = all[name];
  }
  return out;
}

/** Read a single index field. */
export function indexField(sord: EloSord, name: string): string | undefined {
  return sord.objKeys?.find((k) => k.name === name)?.data?.[0] || undefined;
}

/** The one mapper used by every tool that returns objects. */
export function toSordView(sord: EloSord, opts: SordViewOptions): SordView {
  const indexFields =
    opts.indexFields === '*'
      ? allIndexFields(sord)
      : opts.indexFields && opts.indexFields.length > 0
        ? pickIndexFields(sord, opts.indexFields)
        : undefined;

  const view: SordView = {
    objId: sord.id,
    name: sord.name,
    type: isFolder(sord.type) ? 'folder' : 'document',
    sordType: sord.type,
    path: refPathString(sord),
    parentId: parentIdOf(sord),
    eloLink: buildEloLink(opts.webclientBaseUrl, sord.id, sord.name),
    maskName: sord.maskName,
    desc: sord.desc || undefined,
    indexFields: indexFields && Object.keys(indexFields).length > 0 ? indexFields : undefined,
    createdIso: sord.IDateIso,
    // IX spells this with a capital X; the lowercase read in earlier versions
    // silently produced `undefined` on every result.
    changedIso: sord.XDateIso ?? sord.xDateIso,
    ownerName: sord.ownerName,
    childCount: isFolder(sord.type) ? sord.childCount : undefined,
    otherPathCount: sord.refPaths && sord.refPaths.length > 1 ? sord.refPaths.length - 1 : undefined,
  };

  // JSON.stringify drops undefined values, so absent fields cost no tokens.
  return view;
}

/** True when `sord` sits anywhere inside the folder `ancestorId`. */
export function isInsideFolder(sord: EloSord, ancestorId: string): boolean {
  const wanted = String(ancestorId);
  if (String(sord.id) === wanted) return true;
  if (parentIdOf(sord) === wanted) return true;
  return (sord.refPaths ?? []).some((rp) =>
    (rp.path ?? []).some((p) => p.id !== undefined && String(p.id) === wanted),
  );
}
