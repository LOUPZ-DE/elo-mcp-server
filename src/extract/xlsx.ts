import { EncryptedDocumentError, ExtractionFailedError } from './types.js';
import type { ExtractInput, ExtractResult } from './types.js';

// Spreadsheet extraction, flattened to text a model can read.
//
// `read-excel-file` rather than SheetJS: the npm build of `xlsx` is frozen at
// 0.18.5 with known advisories and the maintained build lives outside npm,
// which is a poor fit for a public repository. `exceljs` — the route the README
// used to suggest — has not shipped since October 2023 and drags in `archiver`,
// `unzipper` and `tmp`, i.e. write-side and filesystem machinery for a job that
// only reads.
//
// The decisive feature is number formats: a date in a sheet is stored as a
// serial number, and `45658` reported where "2025-01-01" was meant is not a
// gap, it is a wrong answer. This library resolves them from `xl/styles.xml`.

/** OLE2/CFB container magic — see the note in `extractXlsx`. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Ceiling on rendered rows across the whole workbook.
 *
 * The download is already capped (`ELO_MAX_DOCUMENT_BYTES`, 15 MB by default),
 * but xlsx is a compressed format: a file well under that cap can hold millions
 * of cells and flatten into a string large enough to exhaust a small container,
 * twice over at `ELO_CONTENT_CONCURRENCY=2`. Stopping and saying so beats
 * running out of memory.
 */
const MAX_ROWS = 20_000;

type Cell = string | number | boolean | Date | null | undefined;

interface Sheet {
  sheet: string;
  data: Cell[][];
}

/**
 * Normalise what the library hands back.
 *
 * v9 always returns `[{sheet, data}]` for every sheet and ignores the `sheet`
 * and `getSheets` options entirely — verified against 9.3.10. Earlier majors
 * returned the first sheet's rows directly. Both shapes are accepted so a
 * future bump cannot silently turn a workbook into one row of nothing.
 */
function toSheets(result: unknown): Sheet[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  if (Array.isArray(result[0])) {
    return [{ sheet: '', data: result as Cell[][] }];
  }
  return (result as Sheet[]).filter((s) => s && Array.isArray(s.data));
}

function renderCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    // A date-only cell arrives as UTC midnight. Printing "00:00:00" would
    // imply a precision the sheet does not carry.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // A line break inside a cell would split one record across two rows.
  return String(value).replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * One row as ` | `-separated cells.
 *
 * Not tabs: `normaliseWhitespace` in the dispatcher collapses runs of spaces
 * and tabs, so a tab-separated grid would arrive at the model as a single
 * space and lose its column boundaries. Not a markdown table either — the
 * padding and separator row cost tokens on every row of a wide sheet without
 * telling a reader anything.
 */
function renderRow(row: Cell[]): string {
  const cells = (row ?? []).map(renderCell);
  // Sheets routinely carry formatting far to the right of the data, which
  // arrives as a long tail of empty cells.
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells.join(' | ');
}

export async function extractXlsx(input: ExtractInput): Promise<ExtractResult> {
  // A password-protected .xlsx is not a ZIP at all: Excel wraps the encrypted
  // package in an OLE2 container, which is also what a legacy .xls looks like.
  // Neither the magic bytes nor the library can tell those two apart, so the
  // message names both rather than guessing.
  if (input.data.length >= 8 && input.data.subarray(0, 8).equals(CFB_MAGIC)) {
    throw new EncryptedDocumentError(
      'This workbook is an OLE2 container, not an .xlsx package — it is either password-protected or a legacy .xls file saved under an .xlsx name. Open the eloLink to view it.',
    );
  }

  const readXlsxFile = (await import('read-excel-file/node')).default;

  let sheets: Sheet[];
  try {
    sheets = toSheets(await readXlsxFile(input.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionFailedError(
      `Excel workbook could not be parsed: ${message.slice(0, 200)}`,
    );
  }

  const blocks: string[] = [];
  const emptySheets: string[] = [];
  let renderedRows = 0;
  let capped = false;

  for (const { sheet, data } of sheets) {
    const lines: string[] = [];
    for (const row of data) {
      if (renderedRows >= MAX_ROWS) {
        capped = true;
        break;
      }
      const line = renderRow(row);
      if (line === '') continue;
      lines.push(line);
      renderedRows++;
    }

    if (lines.length === 0) {
      emptySheets.push(sheet || '(unnamed)');
    } else {
      const heading = sheet ? `Sheet: ${sheet}\n` : '';
      blocks.push(heading + lines.join('\n'));
    }
    if (capped) break;
  }

  const text = blocks.join('\n\n');
  const notes: string[] = [];
  if (capped) {
    notes.push(
      `Stopped after ${MAX_ROWS.toLocaleString('en-US')} rows — the workbook is larger than this tool will flatten. Open the eloLink for the rest.`,
    );
  }
  if (emptySheets.length > 0 && blocks.length > 0) {
    notes.push(`Empty sheet(s) skipped: ${emptySheets.join(', ')}.`);
  }
  if (blocks.length === 0) {
    notes.push(
      sheets.length === 0
        ? 'The workbook contains no sheets.'
        : `All ${sheets.length} sheet(s) are empty — the file may hold only charts, images or pivot caches.`,
    );
  }

  return {
    text,
    extractor: 'xlsx',
    format: 'text',
    // Sheets are this format's pages; the count is worth stating because a
    // reader otherwise cannot tell a one-sheet workbook from a truncated one.
    pageCount: sheets.length,
    textLayer: text.length > 0 ? 'present' : 'none',
    notice: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
