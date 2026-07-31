import type { ExtractInput, ExtractResult } from './types.js';

/**
 * Plain-text formats.
 *
 * German archives are full of files written by Windows tooling, so a
 * UTF-8-only decode would turn every umlaut into a replacement character.
 * Decode strictly first; only fall back when that proves the bytes are not
 * UTF-8.
 */
export function extractPlain(input: ExtractInput): ExtractResult {
  let bytes = input.data;

  // Strip a UTF-8 BOM — TextDecoder keeps it as U+FEFF otherwise.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('windows-1252').decode(bytes);
    } catch {
      // Node without full ICU: latin1 is the closest built-in approximation.
      text = bytes.toString('latin1');
    }
  }

  return {
    text,
    extractor: 'plain',
    format: 'text',
    textLayer: text.trim().length > 0 ? 'present' : 'none',
  };
}
