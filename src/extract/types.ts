export interface ExtractResult {
  text: string;
  /** Which extractor produced the text — 'none' when the type is unsupported. */
  extractor: 'pdf' | 'docx' | 'eml' | 'plain' | 'none';
  format: 'text' | 'markdown';
  pageCount?: number;
  /**
   * Whether the file carried machine-readable text at all.
   * 'none' on a scanned PDF: the pages are images, so there is nothing to read
   * without OCR. Saying so is far more useful than returning an empty string.
   */
  textLayer: 'present' | 'sparse' | 'none';
  /** Human-facing explanation when something about the result is unusual. */
  notice?: string;
}

export interface ExtractInput {
  data: Buffer;
  contentType?: string;
  /** Uppercase extension from IX (`docs[0].ext`), e.g. "PDF". */
  ext?: string;
  fileName?: string;
}

/** A password-protected file cannot be read; say that rather than "parse error". */
export class EncryptedDocumentError extends Error {
  readonly code = 'DOCUMENT_ENCRYPTED';
}

export class ExtractionFailedError extends Error {
  readonly code = 'EXTRACTION_FAILED';
}
