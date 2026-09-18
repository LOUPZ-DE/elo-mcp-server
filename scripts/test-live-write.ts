// Live write test. Touches a REAL ELO instance — and only ever the one folder
// named by ELO_TEST_FOLDER_ID.
//
//   ELO_TEST_FOLDER_ID=567085 npm run test:live:write
//
// Every operation verifies, against ELO itself, that its target sits inside the
// sandbox before acting. The check uses the same isInsideFolder() the write
// policy uses, on a sord fetched from ELO rather than on an id the script was
// handed — a caller-supplied path could claim anything.
//
// This is also the only place the assumptions the OpenAPI could not settle get
// tested for real: that createSord persists nothing on its own, that the upload
// URL takes a POST and answers with the id checkinDocEnd needs, and that the
// mask name is accepted where maskId is asked for.

import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { EloClient } from '../src/elo/client.js';
import { isInsideFolder, refPathString, allIndexFields } from '../src/elo/sord.js';
import { findInFolder, runFind } from '../src/elo/find.js';
import { eloGetMetadata } from '../src/tools/elo_get_metadata.js';
import { eloGetDocumentContent } from '../src/tools/elo_get_document_content.js';
import {
  createFolder,
  readSnapshot,
  readTarget,
  updateMetadata,
  uploadDocument,
  addDocumentVersion,
  fingerprint,
} from '../src/write/operations.js';

const SANDBOX = process.env.ELO_TEST_FOLDER_ID;
if (!SANDBOX) {
  console.error(
    'ELO_TEST_FOLDER_ID is not set.\n\n' +
      'This test writes to a real ELO instance, so it refuses to guess where. Set it to the\n' +
      'objId of a folder that exists solely for testing, and re-run.',
  );
  process.exit(1);
}

// Two masks, because ELO enforces the distinction and says so plainly:
// "[ELOIX:2000] Die Maske Ordner kann nicht für Dokumente verwendet werden."
// Notably it only complains on the *second* checkin — the first one stores a
// document carrying a folder mask without objecting, and the mismatch surfaces
// when a version is added. So the folder mask is not a workable default here.
const FOLDER_MASK = process.env.ELO_TEST_MASK ?? 'Ordner';
const DOCUMENT_MASK = process.env.ELO_TEST_DOCUMENT_MASK ?? 'Freie Eingabe';
const run = randomBytes(3).toString('hex');
const transport = { maxBytes: 10 * 1024 * 1024, timeoutMs: 60_000 };

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean | string): void {
  checks++;
  if (ok === true) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}`);
  console.log(`       ${typeof ok === 'string' ? ok : 'assertion failed'}`);
}

const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex').toUpperCase();

/**
 * A real Word document — the smallest one Word will open.
 *
 * The first version of this test uploaded a few bytes of text under a .docx
 * name. ELO accepted them, which was the point, but anyone who then opened the
 * file got Word's "unreadable content" dialog and an OCR timeout in the ELO
 * preview. A fixture that only proves ELO takes bytes cannot show that a file
 * arrives intact and usable; this one can be opened, and read back by mammoth.
 */
async function minimalDocx(paragraph: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const client = new EloClient({
  baseUrl: process.env.ELO_BASE_URL!,
  username: process.env.ELO_USERNAME!,
  password: process.env.ELO_PASSWORD!,
  basicAuthUser: process.env.ELO_BASIC_AUTH_USER,
  basicAuthPass: process.env.ELO_BASIC_AUTH_PASS,
  language: process.env.ELO_LANGUAGE ?? 'de',
  country: process.env.ELO_COUNTRY ?? 'DE',
  timeZone: process.env.ELO_TIMEZONE ?? 'UTC',
});

/**
 * The guard rail. Nothing is written until ELO itself confirms the target is
 * the sandbox or lives under it.
 */
async function assertInSandbox(objId: string, what: string): Promise<void> {
  const sord = await readTarget(client, objId);
  if (!isInsideFolder(sord, SANDBOX!)) {
    throw new Error(
      `REFUSING TO WRITE: ${what} (objId ${objId}, "${sord.name}", ${refPathString(sord) ?? 'no path'}) ` +
        `is not inside the sandbox ${SANDBOX}.`,
    );
  }
}

async function main(): Promise<void> {
  const sandbox = await readTarget(client, SANDBOX!);
  console.log(`Sandbox: ${SANDBOX} "${sandbox.name}" (${refPathString(sandbox) ?? 'no path'})`);
  console.log(`Run tag: ${run}\n`);
  console.log('Running checks:');

  await assertInSandbox(SANDBOX!, 'the sandbox itself');

  // 1. Folder
  const folder = await createFolder(client, {
    parentId: SANDBOX!,
    name: `MCP-Test ${run}`,
    maskName: FOLDER_MASK,
  });
  check('a folder is created and gets an objId', /^\d+$/.test(folder.objId) || `objId ${folder.objId}`);
  await assertInSandbox(folder.objId, 'the new folder');
  const readBack = await readTarget(client, folder.objId);
  check(
    'the folder reads back with the name it was given',
    readBack.name === `MCP-Test ${run}` || `name is "${readBack.name}"`,
  );
  check(
    'it is filed inside the sandbox, not somewhere else',
    isInsideFolder(readBack, SANDBOX!) || `path ${refPathString(readBack) ?? 'unknown'}`,
  );

  // 2. Document
  const pdfBytes = Buffer.from(`%PDF-1.4\n% MCP live write test ${run}\n`);
  const doc = await uploadDocument(
    client,
    {
      parentId: folder.objId,
      name: `Testbericht ${run}`,
      maskName: DOCUMENT_MASK,
      bytes: pdfBytes,
      fileName: `bericht-${run}.pdf`,
      contentType: 'application/pdf',
      ext: 'pdf',
      versionComment: 'MCP live write test',
    },
    transport,
  );
  check('a document is filed and gets an objId', /^\d+$/.test(doc.objId) || `objId ${doc.objId}`);
  await assertInSandbox(doc.objId, 'the new document');

  // 3. Second version
  const before = await readSnapshot(client, doc.objId);
  const beforeVersion = fingerprint(before);
  const v2 = await addDocumentVersion(
    client,
    before.sord,
    {
      bytes: Buffer.from(`%PDF-1.4\n% MCP live write test ${run} — second version\n`),
      fileName: `bericht-${run}-v2.pdf`,
      contentType: 'application/pdf',
      ext: 'pdf',
      versionComment: 'second version',
    },
    transport,
  );
  check('a second version lands on the same object', v2.objId === doc.objId || `objId ${v2.objId}`);
  const afterVersion = await readSnapshot(client, doc.objId);
  check(
    'the change is visible — the fingerprint moved, so conflict detection works',
    fingerprint(afterVersion) !== beforeVersion || 'the fingerprint did not change',
  );

  // 3b. A type other than PDF. ELO enforces things about documents that only
  // surface on a real checkin — the mask/document split did — so the second
  // format the allowlist now permits gets proved rather than assumed.
  const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const docxParagraph = `MCP live write test ${run} — ein echtes Word-Dokument`;
  const docxBytes = await minimalDocx(docxParagraph);
  const docx = await uploadDocument(
    client,
    {
      parentId: folder.objId,
      name: `Protokoll ${run}`,
      maskName: DOCUMENT_MASK,
      bytes: docxBytes,
      fileName: `protokoll-${run}.docx`,
      contentType: DOCX_MIME,
      ext: 'docx',
      versionComment: 'MCP live write test — docx',
    },
    transport,
  );
  check('a non-PDF type is filed too', /^\d+$/.test(docx.objId) || `objId ${docx.objId}`);
  await assertInSandbox(docx.objId, 'the new Word document');
  const docxBack = await readSnapshot(client, docx.objId);
  check(
    'ELO stores the extension it was given, which is what the read tools key on',
    String(docxBack.version?.ext ?? '').toUpperCase() === 'DOCX' ||
      `ext is "${String(docxBack.version?.ext)}"`,
  );
  // Byte integrity, by the hash ELO computed on ITS side. Accepting an upload
  // says nothing about what was stored; this does.
  check(
    'the stored bytes are the bytes that were sent — ELO’s md5 matches ours',
    String(docxBack.version?.md5 ?? '').toUpperCase() === md5(docxBytes) ||
      `ELO md5 ${String(docxBack.version?.md5)}, ours ${md5(docxBytes)}`,
  );
  // And it is a document, not merely a file: our own extractor opens it. What
  // mammoth cannot parse, Word will not open either.
  const docxText = await eloGetDocumentContent(
    client,
    { objId: docx.objId },
    {
      webclientBaseUrl: process.env.ELO_WEBCLIENT_URL ?? 'https://elo-link.loupz.de',
      maxBytes: 10 * 1024 * 1024,
      maxChars: 50_000,
      timeoutMs: 60_000,
    },
  );
  check(
    'the Word document reads back as a Word document, paragraph intact',
    (docxText.extractor === 'docx' && docxText.text.includes(docxParagraph)) ||
      `extractor=${docxText.extractor} text="${docxText.text.slice(0, 60)}" ${docxText.notice ?? ''}`,
  );

  // 3c. Issue #15: read an OLDER version back, by the identifier the read
  // tools hand out. Plain text rather than the fake PDF above, so the
  // assertion is about versioning and not about a parser.
  const readOpts = {
    webclientBaseUrl: process.env.ELO_WEBCLIENT_URL ?? 'https://elo-link.loupz.de',
    maxBytes: 10 * 1024 * 1024,
    maxChars: 50_000,
    timeoutMs: 60_000,
  };
  const metaOpts = { webclientBaseUrl: readOpts.webclientBaseUrl };

  const note = await uploadDocument(
    client,
    {
      parentId: folder.objId,
      name: `Notiz ${run}`,
      maskName: DOCUMENT_MASK,
      bytes: Buffer.from(`version one ${run}`, 'utf8'),
      fileName: `notiz-${run}.txt`,
      contentType: 'text/plain',
      ext: 'txt',
      versionComment: 'erste Fassung',
    },
    transport,
  );
  await assertInSandbox(note.objId, 'the note');
  const metaV1 = await eloGetMetadata(client, { objId: note.objId }, metaOpts);
  const noteV1 = metaV1.docVersion?.versionId;
  check(
    'elo_get_metadata reports a usable versionId, not an empty version field',
    (noteV1 !== undefined && /^\d+$/.test(noteV1)) || `versionId was ${JSON.stringify(noteV1)}`,
  );

  const noteSnapshot = await readSnapshot(client, note.objId);
  await addDocumentVersion(
    client,
    noteSnapshot.sord,
    {
      bytes: Buffer.from(`version two ${run}`, 'utf8'),
      fileName: `notiz-${run}.txt`,
      contentType: 'text/plain',
      ext: 'txt',
      versionComment: 'zweite Fassung',
    },
    transport,
  );
  const metaV2 = await eloGetMetadata(client, { objId: note.objId }, metaOpts);
  const noteV2 = metaV2.docVersion?.versionId;
  check(
    'the versionId moves when a version is checked in',
    (noteV2 !== undefined && noteV2 !== noteV1) || `noteV1=${String(noteV1)} noteV2=${String(noteV2)}`,
  );
  check(
    'metadata says earlier versions exist, since it cannot list them',
    (metaV2.historyEntryCount ?? 0) > 1 || `historyEntryCount=${String(metaV2.historyEntryCount)}`,
  );

  const current = await eloGetDocumentContent(client, { objId: note.objId }, readOpts);
  check(
    'without a version the current one is served',
    current.text.includes(`version two ${run}`) || `text was "${current.text.slice(0, 60)}"`,
  );

  const original = await eloGetDocumentContent(
    client, { objId: note.objId, version: noteV1! }, readOpts,
  );
  check(
    'the ORIGINAL version is readable by its versionId — the point of issue #15',
    (original.text.includes(`version one ${run}`) &&
      !original.text.includes(`version two ${run}`)) ||
      `text was "${original.text.slice(0, 60)}"`,
  );

  // IX does not scope docId to objId, so the tool has to.
  const foreign = await eloGetMetadata(client, { objId: docx.objId }, metaOpts);
  const foreignId = foreign.docVersion?.versionId;
  let refused = 'no error was raised';
  try {
    await eloGetDocumentContent(client, { objId: note.objId, version: foreignId! }, readOpts);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check(
    'a version id from another document is refused, not silently served',
    /does not belong to/i.test(refused) || refused,
  );

  // 4. Metadata
  const fieldName = process.env.ELO_TEST_FIELD;
  if (!fieldName) {
    console.log('  SKIP index field update — set ELO_TEST_FIELD to a writable field to test it');
  } else {
    const target = await readTarget(client, doc.objId);
    await updateMetadata(client, target, { [fieldName]: `mcp-${run}` });
    const updated = await readTarget(client, doc.objId);
    check(
      'an index field reads back with the value that was written',
      allIndexFields(updated)[fieldName] === `mcp-${run}` ||
        `field is "${String(allIndexFields(updated)[fieldName])}"`,
    );
  }

  // 5. Everything landed where it was meant to
  const listed = await runFind(client, findInFolder(folder.objId, { depth: 1 }), { max: 20 });
  check(
    'the document appears in a listing of the new folder',
    listed.sords.some((s) => String(s.id) === doc.objId) ||
      `folder holds ${listed.sords.length} object(s)`,
  );

  console.log(
    `\nLeft behind in the sandbox for inspection: folder ${folder.objId}, document ${doc.objId}.`,
  );
  console.log('Nothing outside the sandbox was touched.');
  console.log(
    failures === 0 ? `\nAll ${checks} checks passed.` : `\n${failures} of ${checks} checks FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
