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
import { randomBytes } from 'node:crypto';
import { EloClient } from '../src/elo/client.js';
import { isInsideFolder, refPathString, allIndexFields } from '../src/elo/sord.js';
import { findInFolder, runFind } from '../src/elo/find.js';
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
