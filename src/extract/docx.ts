import { ExtractionFailedError } from './types.js';
import type { ExtractInput, ExtractResult } from './types.js';

export async function extractDocx(input: ExtractInput): Promise<ExtractResult> {
  const mammoth = (await import('mammoth')).default;

  try {
    // extractRawText over convertToMarkdown: one failure mode, no HTML/markdown
    // conversion surprises, and the downstream consumer wants prose rather than
    // formatting. Markdown output is a candidate for a later opt-in flag.
    const { value, messages } = await mammoth.extractRawText({ buffer: input.data });
    const warnings = messages.filter((m) => m.type === 'warning' || m.type === 'error');

    return {
      text: value,
      extractor: 'docx',
      format: 'text',
      textLayer: value.trim().length > 0 ? 'present' : 'none',
      notice:
        value.trim().length === 0
          ? 'The document contains no extractable text — it may consist only of images or embedded objects.'
          : warnings.length > 0
            ? `Converted with ${warnings.length} warning(s); parts of the layout (e.g. text boxes, embedded objects) may be missing.`
            : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionFailedError(`Word document could not be parsed: ${message.slice(0, 200)}`);
  }
}
