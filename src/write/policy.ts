import { isInsideFolder } from '../elo/sord.js';
import {
  READABLE_MIME_TYPES,
  extensionOf,
  formatForExtension,
  formatForMimeType,
  normaliseMimeType,
} from '../extract/formats.js';
import type { EloSord } from '../elo/types.js';
import { WritePolicyError } from './errors.js';

/**
 * Server-side allowlists. Everything a write may touch is named here; nothing
 * is inferred from the request.
 *
 * All of them default to empty, and empty means "nothing is permitted" rather
 * than "no restriction". A write MVP whose allowlist can be left blank is not
 * one, so `loadConfig` refuses to start with writes enabled and no target root.
 */
export interface WritePolicy {
  /** objIds of folders below which writing is allowed. Never their parents. */
  rootIds: string[];
  /** Mask names that may be assigned to a new object. */
  masks: string[];
  /** Index fields that may be written. Everything else is read-only. */
  fields: string[];
  /** Permitted MIME types for uploads, lower-cased. */
  mimeTypes: string[];
  maxBytes: number;
}

/** Splits a comma-separated env value; blanks are dropped, not kept as "". */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The upload allowlist, with one shorthand: `readable` stands for every type
 * the read tools can open.
 *
 * Spelling out fifteen MIME strings in an environment variable invites two
 * kinds of mistake — a typo that silently permits nothing, and a list that
 * stops matching what the extractor supports. Both are quiet. The token stays
 * opt-in, and an empty value still permits nothing.
 */
export function parseMimeTypes(raw: string | undefined): string[] {
  const entries = parseList(raw).map((e) => e.toLowerCase());
  const expanded = entries.flatMap((e) =>
    e === 'readable' ? [...READABLE_MIME_TYPES] : [normaliseMimeType(e)],
  );
  return [...new Set(expanded.filter((m) => m.length > 0))];
}

/**
 * The target must sit inside a configured root — or be the root itself.
 *
 * Checked against a `sord` fetched from ELO rather than against the id the
 * caller supplied, because `isInsideFolder` needs the object's real parent and
 * reference paths. A caller-supplied path could claim anything.
 *
 * Note that ELO lets one object hang in several folders. `isInsideFolder`
 * returns true if *any* of its reference paths passes, which is the permissive
 * reading — an object filed both inside and outside the sandbox counts as
 * inside. That is acceptable for the target of a write, since the write lands
 * in the folder we were given, not in the other ones.
 */
export function assertTargetAllowed(target: EloSord, policy: WritePolicy): void {
  if (policy.rootIds.length === 0) {
    throw new WritePolicyError('No write target roots are configured, so nothing may be written.');
  }
  const permitted = policy.rootIds.some((root) => isInsideFolder(target, root));
  if (!permitted) {
    throw new WritePolicyError(
      `"${target.name}" (objId ${String(target.id)}) is outside every configured write area. ` +
        `Writing is limited to: ${policy.rootIds.join(', ')}.`,
    );
  }
}

export function assertMaskAllowed(maskName: string | undefined, policy: WritePolicy): void {
  if (!maskName) {
    throw new WritePolicyError('No mask was given, and a new object needs one.');
  }
  if (!policy.masks.includes(maskName)) {
    throw new WritePolicyError(
      `Mask "${maskName}" is not permitted. Allowed: ${policy.masks.join(', ') || '(none)'}.`,
    );
  }
}

/**
 * Every field named in an update must be on the list.
 *
 * Reported together rather than one at a time: a caller fixing them one per
 * round trip is a caller we have made three more requests for no reason.
 */
export function assertFieldsAllowed(
  fields: Record<string, string>,
  policy: WritePolicy,
): void {
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new WritePolicyError('No index fields were given, so there is nothing to update.');
  }
  const rejected = names.filter((n) => !policy.fields.includes(n));
  if (rejected.length > 0) {
    throw new WritePolicyError(
      `These index fields may not be written: ${rejected.join(', ')}. ` +
        `Allowed: ${policy.fields.join(', ') || '(none)'}.`,
    );
  }
}

/**
 * May this file be uploaded?
 *
 * Three questions, not one. The MIME type must be allowlisted; the file must
 * have an extension, because ELO stores it separately from the MIME type and
 * the read tools give it the final say (IX hands out
 * `application/octet-stream` often enough that they have to); and the two must
 * agree.
 *
 * That last check is what keeps the allowlist meaningful. Both fields come from
 * the caller, so without it a file named `.exe` uploads cleanly by declaring
 * `application/pdf` — and lands as a document our own read tools then refuse to
 * open. A MIME type the registry does not know is left alone: an admin who
 * allowlisted `image/png` meant it, and there is nothing to cross-check against.
 */
export function assertFileAllowed(
  contentType: string | undefined,
  fileName: string | undefined,
  byteLength: number,
  policy: WritePolicy,
): void {
  const mime = normaliseMimeType(contentType);
  if (!mime) {
    throw new WritePolicyError('No content type was given, so the file type cannot be checked.');
  }
  if (!policy.mimeTypes.includes(mime)) {
    throw new WritePolicyError(
      `Files of type "${mime}" may not be uploaded. Allowed: ${policy.mimeTypes.join(', ') || '(none)'}.`,
    );
  }

  const ext = extensionOf(fileName);
  if (!ext) {
    throw new WritePolicyError(
      `"${fileName ?? ''}" has no file extension. ELO stores the extension separately, and ` +
        'the document would be filed as a type nothing can open.',
    );
  }
  const declared = formatForMimeType(mime);
  if (declared && !declared.extensions.includes(ext)) {
    const actual = formatForExtension(ext);
    throw new WritePolicyError(
      `The content type "${mime}" and the file name ".${ext.toLowerCase()}" disagree. ` +
        `Files of type "${mime}" are named ${declared.extensions.map((e) => `.${e.toLowerCase()}`).join(' or ')}` +
        (actual ? `, and .${ext.toLowerCase()} means ${actual.mimeTypes[0]}.` : '.'),
    );
  }

  if (byteLength <= 0) {
    throw new WritePolicyError('The file is empty.');
  }
  if (byteLength > policy.maxBytes) {
    throw new WritePolicyError(
      `The file is ${byteLength.toLocaleString('en-US')} bytes; the limit is ${policy.maxBytes.toLocaleString('en-US')}.`,
    );
  }
}
