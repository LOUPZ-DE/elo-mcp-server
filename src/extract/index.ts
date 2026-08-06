import { extractPlain } from './plain.js';
import type { ExtractInput, ExtractResult } from './types.js';

export { EncryptedDocumentError, ExtractionFailedError } from './types.js';
export type { ExtractResult, ExtractInput } from './types.js';

type Kind = 'pdf' | 'docx' | 'eml' | 'plain' | 'unsupported';

const MIME_KINDS: Record<string, Kind> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'message/rfc822': 'eml',
  'text/plain': 'plain',
  'text/markdown': 'plain',
  'text/csv': 'plain',
  'text/html': 'plain',
  'application/json': 'plain',
  'application/xml': 'plain',
  'text/xml': 'plain',
};

const EXT_KINDS: Record<string, Kind> = {
  PDF: 'pdf',
  DOCX: 'docx',
  EML: 'eml',
  TXT: 'plain',
  MD: 'plain',
  CSV: 'plain',
  LOG: 'plain',
  JSON: 'plain',
  XML: 'plain',
  HTML: 'plain',
  HTM: 'plain',
};

/**
 * Formats we recognise but cannot read, with an explanation worth showing.
 * Being specific beats a generic "unsupported": the user can then decide
 * whether to open the document or ask someone to convert it.
 */
const KNOWN_UNREADABLE: Record<string, string> = {
  ECF: 'ELO container format (typically an e-mail with attachments). Open the eloLink to see the message and its attachments; the attachments are usually filed as separate ELO documents that can be read individually.',
  MSG: 'Outlook message file. Not supported — .eml is; open the eloLink to read this one.',
  DOC: 'Legacy Word format (pre-2007). Not supported — re-save as .docx or open the eloLink.',
  XLS: 'Legacy Excel format. Not supported — open the eloLink.',
  XLSX: 'Excel workbook. Spreadsheet extraction is not enabled; open the eloLink.',
  PPT: 'Legacy PowerPoint format. Not supported — open the eloLink.',
  PPTX: 'PowerPoint presentation. Not supported — open the eloLink.',
  ZIP: 'Archive file. Its contents cannot be read directly.',
  DWG: 'CAD drawing. Not text-extractable.',
  IFC: 'IFC building model. Not text-extractable in a useful form.',
};

/**
 * Pick an extractor.
 *
 * The MIME type alone is not enough: this IX hands out
 * `application/octet-stream` for documents whose real type is obvious from
 * `docs[0].ext` (observed on the live instance), so the extension gets the
 * final say whenever the MIME type is generic or missing.
 */
function classify(input: ExtractInput): { kind: Kind; reason?: string } {
  const mime = (input.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const extFromName = input.fileName?.split('.').pop();
  const ext = (input.ext ?? extFromName ?? '').replace(/^\./, '').toUpperCase();

  const byMime = MIME_KINDS[mime];
  const byExt = EXT_KINDS[ext];

  if (byExt) return { kind: byExt };
  if (byMime && mime !== 'application/octet-stream') return { kind: byMime };
  if (ext && KNOWN_UNREADABLE[ext]) return { kind: 'unsupported', reason: KNOWN_UNREADABLE[ext] };
  if (mime.startsWith('text/')) return { kind: 'plain' };
  if (mime.startsWith('image/')) {
    return { kind: 'unsupported', reason: 'Image file — there is no text to extract without OCR.' };
  }

  return {
    kind: 'unsupported',
    reason: `Unsupported file type${ext ? ` (.${ext.toLowerCase()})` : ''}${mime ? ` / ${mime}` : ''}.`,
  };
}

export async function extractText(input: ExtractInput): Promise<ExtractResult> {
  const { kind, reason } = classify(input);

  if (kind === 'unsupported') {
    return {
      text: '',
      extractor: 'none',
      format: 'text',
      textLayer: 'none',
      notice: `${reason} Open the eloLink to view the document.`,
    };
  }

  const result =
    kind === 'pdf'
      ? await (await import('./pdf.js')).extractPdf(input)
      : kind === 'docx'
        ? await (await import('./docx.js')).extractDocx(input)
        : kind === 'eml'
          ? (await import('./eml.js')).extractEml(input)
          : extractPlain(input);

  return { ...result, text: normaliseWhitespace(result.text) };
}

/**
 * PDF extraction in particular is whitespace-heavy; tidying up routinely
 * removes a fifth of the characters, and therefore a fifth of the tokens,
 * without losing anything a reader wants.
 */
export function normaliseWhitespace(text: string): string {
  return text
    // Drop C0 control characters, keeping tab and newline.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
