/**
 * E-mail files (RFC 822 / MIME).
 *
 * Parsing strategy: hand-rolled MIME walk instead of pulling in a full mail
 * library (mailparser, postal-mime). Both are ~200+ kB plus transitive deps
 * (encoding.js, iconv-lite, etc.) for what we need: find the best textual
 * body part, decode it, and list attachments. This file has one job.
 *
 * Extraction policy:
 *   - Plain-text part wins; HTML is the fallback (tags stripped).
 *   - Attachments are NOT decoded — only listed by name and MIME type.
 *   - Mail headers (From/To/Cc/Subject/Date) are rendered as a readable
 *     header block before the body, because an agent usually needs the
 *     context "who wrote this and when".
 */

import { ExtractionFailedError } from './types.js';
import type { ExtractResult, ExtractInput } from './types.js';

/**
 * Nesting cap for the MIME walk. Real mail rarely exceeds three levels
 * (mixed → alternative → related); a malformed or hostile file must not be
 * able to drive unbounded recursion on a 15 MB input.
 */
const MAX_DEPTH = 12;

interface MimePart {
  /** Content-Type without parameters, lower-cased. '' when absent. */
  type: string;
  /** Content-Disposition ('attachment', 'inline', …). '' when absent. */
  disposition: string;
  /** transfer encoding, lower-cased ('base64', 'quoted-printable', …). */
  transferEncoding: string;
  /** charset from the Content-Type parameters, if present. */
  charset: string;
  /** filename from Content-Disposition or Content-Type 'name='. */
  filename: string;
  /** decoded body bytes of this part (headers removed). */
  body: Uint8Array;
}

/** Parse headers of one part up to the blank line; returns offset of body. */
function parsePartHeaders(
  bytes: Uint8Array,
  start: number,
  end: number,
): { headers: Map<string, string>; bodyStart: number } {
  const headers = new Map<string, string>();
  let pos = start;
  let currentKey = '';
  let currentValue = '';
  const flush = (): void => {
    if (currentKey) {
      headers.set(currentKey.toLowerCase(), currentValue.trim());
      currentKey = '';
      currentValue = '';
    }
  };
  while (pos < end) {
    let lineEnd = pos;
    while (lineEnd < end && bytes[lineEnd] !== 0x0a) lineEnd++;
    const lineBytes = bytes.subarray(pos, lineEnd);
    const line = new TextDecoder('latin1').decode(lineBytes).replace(/\r$/, '');
    if (line === '') {
      flush();
      return { headers, bodyStart: lineEnd + 1 };
    }
    // Unfolding: a line starting with SP/HTAB continues the previous header.
    if ((line.startsWith(' ') || line.startsWith('\t')) && currentKey) {
      currentValue += ' ' + line.trim();
    } else {
      flush();
      const colon = line.indexOf(':');
      if (colon > 0) {
        currentKey = line.slice(0, colon);
        currentValue = line.slice(colon + 1);
      }
      // A line without ':' is malformed; keep it harmless by ignoring.
    }
    pos = lineEnd + 1;
  }
  flush();
  return { headers, bodyStart: pos };
}

/** Get a parameter from a header value like `multipart/mixed; boundary="x"`. */
function headerParam(headerValue: string, name: string): string {
  // Matches  name="..."  or  name=...;  or  name=... at end
  const re = new RegExp(
    `(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`,
    'i',
  );
  const m = headerValue.match(re);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1').trim();
}

/** The bit before the first ';' of a header, lower-cased. */
function headerType(headerValue: string): string {
  return (headerValue.split(';')[0] ?? '').trim().toLowerCase();
}

/** Split a multipart body on its boundary. Boundary lives in bytes, not text. */
function splitMultipart(
  bytes: Uint8Array,
  boundary: string,
): Array<{ start: number; end: number }> {
  const marker = `--${boundary}`;
  const markerBytes = new TextEncoder().encode(marker);
  const parts: Array<{ start: number; end: number }> = [];

  /** Trim the CRLF that belongs to the delimiter, not to the part. */
  const pushPart = (from: number, to: number): void => {
    let partEnd = to;
    while (partEnd > from && (bytes[partEnd - 1] === 0x0a || bytes[partEnd - 1] === 0x0d)) {
      partEnd--;
    }
    if (partEnd > from) parts.push({ start: from, end: partEnd });
  };

  let pos = 0;
  let partStart = -1;
  let sawClosing = false;
  while (pos + markerBytes.length <= bytes.length) {
    let match = true;
    for (let i = 0; i < markerBytes.length; i++) {
      if (bytes[pos + i] !== markerBytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const after = pos + markerBytes.length;
      const isClosing =
        after + 1 < bytes.length && bytes[after] === 0x2d && bytes[after + 1] === 0x2d;
      if (partStart >= 0) pushPart(partStart, pos);
      partStart = -1;
      if (isClosing) {
        sawClosing = true;
        break;
      }
      // Skip past boundary line (parameters may follow; go to next CR/LF).
      let nl = after;
      while (nl < bytes.length && bytes[nl] !== 0x0a) nl++;
      partStart = nl + 1;
      pos = nl;
    } else {
      pos++;
    }
  }

  // Truncated mail: no closing delimiter, so the final part is still open.
  // Keeping it is better than silently dropping the last (often the only) body.
  if (!sawClosing && partStart >= 0 && partStart < bytes.length) {
    pushPart(partStart, bytes.length);
  }
  return parts;
}

/** Decode base64 with whitespace tolerance; returns bytes. */
function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** Decode quoted-printable. Soft line breaks = '=' followed by CRLF. */
function decodeQuotedPrintable(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === '=') {
      const two = text.slice(i + 1, i + 3);
      if (two.length === 2 && /^[0-9A-Fa-f]{2}$/.test(two)) {
        out.push(parseInt(two, 16));
        i += 2;
        continue;
      }
      // Soft break: '=' then CRLF or LF. Also matched at end of input, where
      // the length guard on the hex form above would otherwise fall through.
      if (text[i + 1] === '\r' && text[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (text[i + 1] === '\n') {
        i += 1;
        continue;
      }
    }
    out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
}

/** Map a charset label to a TextDecoder. Unknown labels fall back to UTF-8. */
function decodeText(bytes: Uint8Array, charset: string): string {
  const label = (charset || 'utf-8').toLowerCase().replace(/^utf8$/, 'utf-8');
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // Unknown charset label – try UTF-8, then a Windows-friendly fallback.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        return new TextDecoder('windows-1252').decode(bytes);
      } catch {
        return Buffer.from(bytes).toString('latin1');
      }
    }
  }
}

/** Recursively walk a MIME tree and collect leaf parts (non-multipart). */
function collectLeaves(
  bytes: Uint8Array,
  start: number,
  end: number,
  out: MimePart[],
  depth = 0,
): void {
  const { headers, bodyStart } = parsePartHeaders(bytes, start, end);
  const cte = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  const ct = headers.get('content-type') ?? '';
  const type = headerType(ct);
  const cd = headers.get('content-disposition') ?? '';
  const disposition = headerType(cd);
  const charset = headerParam(ct, 'charset').toLowerCase();
  const filename = headerParam(cd, 'filename') || headerParam(ct, 'name');

  if (type.startsWith('multipart/') && depth < MAX_DEPTH) {
    const boundary = headerParam(ct, 'boundary');
    if (!boundary) {
      // Multipart without boundary is broken; treat as text/plain-ish.
      out.push({
        type: 'text/plain',
        disposition: '',
        transferEncoding: cte,
        charset: '',
        filename: '',
        body: bytes.subarray(bodyStart, end),
      });
      return;
    }
    const ranges = splitMultipart(bytes.subarray(bodyStart, end), boundary);
    for (const r of ranges) {
      collectLeaves(bytes, bodyStart + r.start, bodyStart + r.end, out, depth + 1);
    }
    return;
  }

  let body: Uint8Array = bytes.subarray(bodyStart, end);
  if (cte === 'base64') {
    body = decodeBase64(new TextDecoder('latin1').decode(body));
  } else if (cte === 'quoted-printable') {
    body = decodeQuotedPrintable(new TextDecoder('latin1').decode(body));
  }

  out.push({ type, disposition, transferEncoding: cte, charset, filename, body });
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', euro: '€', sect: '§', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
};

/** Naive but effective HTML → plain: drop scripts/styles, then tags, then entities. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<th[\s\S]*?>/gi, '\t')
    .replace(/<td[\s\S]*?>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');

  return stripped.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (name && name in HTML_ENTITIES) return HTML_ENTITIES[name] as string;
      return whole;
    },
  );
}

/** Pretty-print one address-ish header (From / To / Cc) without raw syntax. */
function formatAddressHeader(raw: string): string {
  if (!raw) return '';
  // Multiple recipients separated by commas not inside <> or quotes.
  return raw
    .split(/,(?=(?:[^"<>]*"[^"]*")*[^"<>]*$)/)
    .map((addr) => addr.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Extract text from an EML / RFC 822 message.
 *
 * Body preference order:
 *   1. text/plain part without attachment disposition
 *   2. text/html part (stripped) without attachment disposition
 *   3. All remaining readable text parts concatenated
 *
 * Attachments are listed at the end as a readable manifest. The caller
 * (ELO) typically stores each attachment as its own document, which the
 * existing per-document extraction already covers.
 */
export function extractEml(input: ExtractInput): ExtractResult {
  const bytes = input.data;
  if (bytes.length === 0) {
    throw new ExtractionFailedError('E-mail file is empty.');
  }

  const leaves: MimePart[] = [];
  try {
    collectLeaves(bytes, 0, bytes.length, leaves);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionFailedError(`E-mail could not be parsed: ${message.slice(0, 200)}`);
  }

  // Top-level headers for the readable block.
  const { headers } = parsePartHeaders(bytes, 0, bytes.length);
  const headerLines: string[] = [];
  const subject = headers.get('subject') ?? '';
  const from = headers.get('from') ?? '';
  const to = headers.get('to') ?? '';
  const cc = headers.get('cc') ?? '';
  const date = headers.get('date') ?? '';
  if (from) headerLines.push(`From: ${formatAddressHeader(from)}`);
  if (to) headerLines.push(`To: ${formatAddressHeader(to)}`);
  if (cc) headerLines.push(`Cc: ${formatAddressHeader(cc)}`);
  if (subject) headerLines.push(`Subject: ${subject}`);
  if (date) headerLines.push(`Date: ${date}`);

  // Pick the primary body.
  const bodyParts = leaves.filter((p) => p.disposition !== 'attachment' && !p.filename);
  const plain = bodyParts.find((p) => p.type === 'text/plain');
  const html = bodyParts.find((p) => p.type === 'text/html');

  let bodyText = '';
  let bodySource: 'plain' | 'html' | 'none' = 'none';
  if (plain) {
    bodyText = decodeText(plain.body, plain.charset);
    bodySource = 'plain';
  } else if (html) {
    bodyText = htmlToText(decodeText(html.body, html.charset));
    bodySource = 'html';
  } else {
    // No dedicated body part; concatenate any readable text parts.
    const readable = leaves.filter((p) => p.type.startsWith('text/'));
    bodyText = readable.map((p) => decodeText(p.body, p.charset)).join('\n\n');
    bodySource = readable.length > 0 ? 'plain' : 'none';
  }

  // Attachments manifest.
  const attachments = leaves.filter((p) => p.disposition === 'attachment' || p.filename);
  const attachmentLines =
    attachments.length > 0
      ? ['', '--- Attachments ---'].concat(
          attachments.map(
            (a, i) => `  ${i + 1}. ${a.filename || '(unnamed)'}${a.type ? ` [${a.type}]` : ''}`,
          ),
        )
      : [];

  const text = [...headerLines, '', bodyText, ...attachmentLines].join('\n').trim();

  const notice =
    attachments.length > 0
      ? `${attachments.length} attachment(s) listed by name; each is typically a separate ELO document and can be read individually.`
      : bodySource === 'html'
        ? 'Plain text derived from the HTML part; formatting was removed.'
        : undefined;

  return {
    text,
    extractor: 'eml',
    format: 'text',
    // Measured on the *body*, not on `text` — the latter always contains the
    // header block, so judging by it would mark a body-less mail as readable
    // and hand the model a From/To listing as though it were the message.
    textLayer: bodyText.trim().length > 0 ? 'present' : 'none',
    notice,
  };
}
