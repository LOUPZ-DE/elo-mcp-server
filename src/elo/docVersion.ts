import type { EloDocVersion } from './types.js';

/**
 * One shape for a document version, used by every tool that reports one.
 *
 * The identity question is the whole point. `EloDocVersion.version` — the field
 * whose name promises to be the version — comes back **empty** from this
 * instance for every version of every document. `id` is what is populated, and
 * `id` is what `checkoutDoc`'s `docId` parameter selects on, so `versionId` is
 * the value a caller passes back to fetch this exact version.
 */
export interface DocVersionView {
  /** Pass this to elo_get_document_content as `version`. */
  versionId?: string;
  /** ELO's own label. Empty on this instance; reported when it is not. */
  version?: string;
  comment?: string;
  contentType?: string;
  ext?: string;
  sizeBytes?: number;
  md5?: string;
  guid?: string;
  createDateIso?: string;
  updateDateIso?: string;
  ownerName?: string;
  /** True for the version ELO serves when no version is named. */
  isWorkingVersion?: boolean;
  isMilestone?: boolean;
}

/** The version identifier, as a string, whatever JSON type IX chose. */
export function versionIdOf(v: EloDocVersion | undefined): string | undefined {
  const id = v?.id;
  if (id === undefined || id === null || id === '') return undefined;
  return String(id);
}

/** `size` arrives as "57" as often as 57; callers want a number or nothing. */
export function versionSizeBytes(v: EloDocVersion | undefined): number | undefined {
  const raw = v?.size;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function toDocVersionView(v: EloDocVersion | undefined): DocVersionView | undefined {
  if (!v) return undefined;
  return {
    versionId: versionIdOf(v),
    // Reported only when populated: an empty string beside a filled versionId
    // reads as "the version is unknown", which is the opposite of the truth.
    ...(v.version ? { version: v.version } : {}),
    comment: v.comment || undefined,
    contentType: v.contentType || undefined,
    ext: v.ext || undefined,
    sizeBytes: versionSizeBytes(v),
    md5: v.md5 || undefined,
    guid: v.guid || undefined,
    createDateIso: v.createDateIso || undefined,
    updateDateIso: v.updateDateIso || undefined,
    ownerName: v.ownerName || undefined,
    ...(v.workVersion === undefined ? {} : { isWorkingVersion: v.workVersion }),
    ...(v.milestone ? { isMilestone: true } : {}),
  };
}
