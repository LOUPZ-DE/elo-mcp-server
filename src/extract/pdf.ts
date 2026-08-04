import { EncryptedDocumentError, ExtractionFailedError } from './types.js';
import type { ExtractInput, ExtractResult } from './types.js';

/**
 * Below this many characters per page we treat the document as having no
 * usable text layer. A born-digital business page runs to hundreds of
 * characters; a scan yields a handful of stray marks at most.
 */
const CHARS_PER_PAGE_THRESHOLD = 20;
const SPARSE_THRESHOLD = 80;

export async function extractPdf(input: ExtractInput): Promise<ExtractResult> {
  // Loaded on demand so stdio startup stays fast and a broken optional parser
  // cannot take the whole server down at import time.
  const { getDocumentProxy, extractText } = await import('unpdf');

  let pageCount = 0;
  let text = '';
  try {
    const pdf = await getDocumentProxy(new Uint8Array(input.data));
    pageCount = pdf.numPages;
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(message)) {
      throw new EncryptedDocumentError(
        'This PDF is password-protected, so its text cannot be read.',
      );
    }
    throw new ExtractionFailedError(`PDF could not be parsed: ${message.slice(0, 200)}`);
  }

  const perPage = pageCount > 0 ? text.replace(/\s/g, '').length / pageCount : 0;
  const textLayer: ExtractResult['textLayer'] =
    perPage < CHARS_PER_PAGE_THRESHOLD ? 'none' : perPage < SPARSE_THRESHOLD ? 'sparse' : 'present';

  return {
    text,
    extractor: 'pdf',
    format: 'text',
    pageCount,
    textLayer,
    notice:
      textLayer === 'none'
        ? 'This PDF has no text layer — it is almost certainly a scan. Nothing can be read from it automatically; open the eloLink to view it.'
        : textLayer === 'sparse'
          ? 'Very little text was recoverable — the document may be a scan with a partial text layer, or mostly drawings/tables.'
          : undefined,
  };
}
