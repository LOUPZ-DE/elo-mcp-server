/**
 * The file types this server understands — one registry, read by both sides.
 *
 * The extractor dispatches on it, and the write allowlist expands `readable`
 * from it. Keeping them apart meant two lists that agree only as long as
 * somebody remembers to edit both, and the failure is quiet: a type would be
 * uploadable that no read tool can then open.
 *
 * A format is one entry, not one `kind`. The plain-text extractor handles CSV,
 * Markdown and HTML alike, but `text/csv` still belongs to `.csv` and not to
 * `.html` — and that pairing is exactly what the upload check needs.
 */

export type ReadableKind = 'pdf' | 'docx' | 'xlsx' | 'eml' | 'msg' | 'plain';

export interface ReadableFormat {
  /** Which extractor reads it. */
  kind: ReadableKind;
  /** MIME types that mean this format. The first is the canonical one. */
  mimeTypes: string[];
  /** Extensions, uppercase and without the dot — how IX stores `docs[0].ext`. */
  extensions: string[];
}

export const READABLE_FORMATS: readonly ReadableFormat[] = [
  { kind: 'pdf', mimeTypes: ['application/pdf', 'application/x-pdf'], extensions: ['PDF'] },
  {
    kind: 'docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    extensions: ['DOCX'],
  },
  {
    kind: 'xlsx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    extensions: ['XLSX'],
  },
  {
    kind: 'xlsx',
    mimeTypes: ['application/vnd.ms-excel.sheet.macroenabled.12'],
    extensions: ['XLSM'],
  },
  { kind: 'eml', mimeTypes: ['message/rfc822'], extensions: ['EML'] },
  { kind: 'msg', mimeTypes: ['application/vnd.ms-outlook', 'application/x-msg'], extensions: ['MSG'] },
  // LOG sits with TXT because that is what a .log file is: text/plain under
  // another name. Nothing else claims the extension.
  { kind: 'plain', mimeTypes: ['text/plain'], extensions: ['TXT', 'LOG'] },
  { kind: 'plain', mimeTypes: ['text/markdown'], extensions: ['MD'] },
  { kind: 'plain', mimeTypes: ['text/csv'], extensions: ['CSV'] },
  { kind: 'plain', mimeTypes: ['text/html'], extensions: ['HTML', 'HTM'] },
  { kind: 'plain', mimeTypes: ['application/json'], extensions: ['JSON'] },
  { kind: 'plain', mimeTypes: ['application/xml', 'text/xml'], extensions: ['XML'] },
];

/** Every MIME type the extractor can read, canonical spelling and aliases alike. */
export const READABLE_MIME_TYPES: readonly string[] = READABLE_FORMATS.flatMap(
  (f) => f.mimeTypes,
);

/** Strip parameters and case from a Content-Type: `Text/CSV; charset=utf-8` → `text/csv`. */
export function normaliseMimeType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Extension without the dot, uppercase — the form IX and this registry use. */
export function extensionOf(fileName: string | undefined): string {
  const dot = (fileName ?? '').lastIndexOf('.');
  return dot > 0 ? fileName!.slice(dot + 1).toUpperCase() : '';
}

export function formatForMimeType(contentType: string | undefined): ReadableFormat | undefined {
  const mime = normaliseMimeType(contentType);
  return READABLE_FORMATS.find((f) => f.mimeTypes.includes(mime));
}

export function formatForExtension(ext: string | undefined): ReadableFormat | undefined {
  const upper = (ext ?? '').replace(/^\./, '').toUpperCase();
  return READABLE_FORMATS.find((f) => f.extensions.includes(upper));
}
