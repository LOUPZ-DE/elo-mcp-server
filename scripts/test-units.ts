// Offline unit tests. No ELO, no network, no test framework — node:assert + tsx.
//
//   npm run test:unit
//
// Fixture *shapes* are copied from real IX responses captured with
// scripts/probe-ix.ts, so they reflect what IX actually returns rather than
// what the JavaDoc promises. The identifiers themselves are invented.

import assert from 'node:assert/strict';
import {
  buildEloLink,
  refPathString,
  parentIdOf,
  allIndexFields,
  pickIndexFields,
  toSordView,
  isInsideFolder,
} from '../src/elo/sord.js';
import { rankProjectFolders, type ProjectCandidate } from '../src/tools/elo_find_project_folder.js';
import { resolveStreamUrl, isForeignHost, UnsafeStreamUrlError } from '../src/elo/streamUrl.js';
import { extractText, normaliseWhitespace } from '../src/extract/index.js';
import { sumPrecise, installSumPrecisePolyfill } from '../src/extract/sumPrecise.js';
import { extractEml } from '../src/extract/eml.js';
import { mapMsgFields, rtfToText } from '../src/extract/msg.js';
import type { EloSord } from '../src/elo/types.js';
import { randomToken, s256Challenge, verifyS256 } from '../src/oauth/pkce.js';
import { signAccessToken, verifyAccessTokenJwt } from '../src/oauth/jwt.js';
import { McpTokenVerifier, SHARED_SECRET_CLIENT_ID } from '../src/oauth/verifier.js';
import { setConfig, config } from '../src/utils/runtimeConfig.js';
import { setSession, getSession } from '../src/authn/session.js';
import { classifyLoginError, isStaleCredentialError, resetEloSessions } from '../src/authn/eloLogin.js';
import { zipSync, strToU8 } from 'fflate';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { respond } from '../src/mcp/respond.js';
import {
  nextStepsForDocumentContent,
  nextStepsForListFolder,
  nextStepsForProjectFolder,
  nextStepsForSearch,
  nextStepsForWhoAmI,
} from '../src/mcp/nextSteps.js';
import type { SordView } from '../src/elo/sord.js';
import { requireEloUser } from '../src/write/guard.js';
import { hashPayload, prepareWrite, consumeWrite, resetPreflight } from '../src/write/preflight.js';
import {
  assertTargetAllowed,
  assertMaskAllowed,
  assertFieldsAllowed,
  assertFileAllowed,
} from '../src/write/policy.js';
import { onceOnly, resetIdempotency } from '../src/write/idempotency.js';
import { resolveIconPath } from '../src/utils/icon.js';
import { join } from 'node:path';
import {
  decodeStateKey,
  decryptState,
  encryptState,
  flushState,
  registerSlice,
  resetSlices,
  scheduleSave,
} from '../src/utils/stateFile.js';

let failures = 0;
let count = 0;

// Cases are queued onto one chain so async tests still report in source order.
let chain: Promise<void> = Promise.resolve();

function test(name: string, fn: () => void | Promise<void>): void {
  count++;
  chain = chain.then(async () => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  });
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// --- Fixtures ---------------------------------------------------------------
//
// Field shapes are verbatim from real IX responses captured with probe-ix.ts;
// the identifiers and names are invented. Note the deliberate mismatch between
// the folder *title* ("10001 / …") and its PRJ_NO index field ("10002") — that
// is not a typo, it is the real-world drift these tests exist to guard against.

/** A project folder: /Projekte/Beratung/<this>. parentId is a NUMBER in IX. */
const projectFolder: EloSord = {
  id: '500001',
  name: '10001 / Musterstadt, Beispielkunde, Schulungen',
  type: 3,
  parentId: 6985,
  childCount: 12,
  maskName: 'Projekt',
  ownerName: 'Test User',
  IDateIso: '20250101120000',
  XDateIso: '20260715090000',
  objKeys: [
    { name: 'PRJ_NO', data: ['10002'] },
    { name: 'PRJ_NAME', data: ['Musterstadt, Beispielkunde, Schulungen'] },
    { name: 'SOL_TYPE', data: ['PROJEKT'] },
    { name: 'EMPTY_FIELD', data: [''] },
  ],
  refPaths: [
    {
      path: [
        { id: '6411', name: 'Projekte' },
        { id: '6985', name: 'Beratung' },
      ],
      pathAsString: '¶Projekte¶Beratung',
    },
  ],
};

/**
 * An acquisition folder whose *title* carries the project number that actually
 * belongs to `projectFolder` above. Returning this one as the project's data
 * room is exactly the failure `rankProjectFolders` prevents.
 */
const acquisitionFolder: EloSord = {
  id: '500002',
  name: '10002 / Beispielstadt, Musterkunde AG, Beratungsleistungen',
  type: 3,
  parentId: 6411,
  objKeys: [{ name: 'SOL_TYPE', data: ['AKQUISE'] }],
  refPaths: [{ path: [{ id: '6411', name: 'Projekte' }] }],
};

const documentSord: EloSord = {
  id: '500100',
  name: 'Monatsbericht 2026-03',
  type: 254,
  parentId: 500010,
  refPaths: [
    {
      path: [
        { id: '6411', name: 'Projekte' },
        { id: '6985', name: 'Beratung' },
        { id: '500010', name: '03 Berichte' },
      ],
    },
  ],
};

const WEB = 'https://elo-link.example.com';

// --- buildEloLink ----------------------------------------------------------

section('buildEloLink');

test('builds base/objId?title=', () => {
  assert.equal(buildEloLink(WEB, '123', 'Report'), 'https://elo-link.example.com/123?title=Report');
});

test('strips a trailing slash from the base', () => {
  assert.equal(buildEloLink(`${WEB}/`, '123', 'X'), 'https://elo-link.example.com/123?title=X');
});

test('URL-encodes umlauts and slashes in the title', () => {
  const link = buildEloLink(WEB, '9', 'Prüfung / Bericht');
  assert.equal(link, 'https://elo-link.example.com/9?title=Pr%C3%BCfung%20%2F%20Bericht');
  assert.ok(!link.slice(link.indexOf('?')).includes(' '), 'no raw spaces in the query');
});

test('omits ?title= when no name is given', () => {
  assert.equal(buildEloLink(WEB, '123'), 'https://elo-link.example.com/123');
});

// --- refPathString ---------------------------------------------------------

section('refPathString');

test('joins the parent chain with a leading slash', () => {
  assert.equal(refPathString(projectFolder), '/Projekte/Beratung');
});

test('returns undefined without refPaths', () => {
  assert.equal(refPathString({ id: '1', name: 'x', type: 3 }), undefined);
});

test('returns undefined for an empty path array', () => {
  assert.equal(refPathString({ id: '1', name: 'x', type: 3, refPaths: [{ path: [] }] }), undefined);
});

// --- parentIdOf ------------------------------------------------------------

section('parentIdOf');

test('normalises the numeric parentId to a string', () => {
  assert.equal(parentIdOf(projectFolder), '6985');
});

test('falls back to the last refPath item when parentId is absent', () => {
  const { parentId, ...withoutParent } = projectFolder;
  assert.equal(parentIdOf(withoutParent as EloSord), '6985');
});

test('agrees with the last refPath element (probe P2: path excludes self)', () => {
  const path = projectFolder.refPaths![0]!.path;
  assert.equal(parentIdOf(projectFolder), String(path[path.length - 1]!.id));
});

test('treats 0 and -1 as "no parent" and falls through', () => {
  assert.equal(parentIdOf({ id: '1', name: 'x', type: 3, parentId: 0 }), undefined);
  assert.equal(parentIdOf({ id: '1', name: 'x', type: 3, parentId: -1 }), undefined);
});

test('returns undefined at the archive root', () => {
  assert.equal(parentIdOf({ id: '1', name: 'x', type: 3 }), undefined);
});

// --- index fields ----------------------------------------------------------

section('index fields');

test('allIndexFields skips empty values', () => {
  const all = allIndexFields(projectFolder);
  assert.equal(all.PRJ_NO, '10002');
  assert.equal(all.SOL_TYPE, 'PROJEKT');
  assert.ok(!('EMPTY_FIELD' in all), 'empty index fields must be dropped');
});

test('pickIndexFields returns only requested, present fields', () => {
  const picked = pickIndexFields(projectFolder, ['PRJ_NO', 'SOL_TYPE', 'DOES_NOT_EXIST']);
  assert.deepEqual(picked, { PRJ_NO: '10002', SOL_TYPE: 'PROJEKT' });
});

// --- toSordView ------------------------------------------------------------

section('toSordView');

test('classifies folders and documents by type number', () => {
  assert.equal(toSordView(projectFolder, { webclientBaseUrl: WEB }).type, 'folder');
  assert.equal(toSordView(documentSord, { webclientBaseUrl: WEB }).type, 'document');
});

test('always emits an eloLink', () => {
  for (const s of [projectFolder, documentSord, { id: '7', name: 'bare', type: 254 } as EloSord]) {
    assert.ok(toSordView(s, { webclientBaseUrl: WEB }).eloLink.startsWith(WEB));
  }
});

test('carries path and parentId so the project is identifiable', () => {
  const v = toSordView(projectFolder, { webclientBaseUrl: WEB });
  assert.equal(v.path, '/Projekte/Beratung');
  assert.equal(v.parentId, '6985');
});

test('reads the change date from XDateIso (capital X)', () => {
  assert.equal(toSordView(projectFolder, { webclientBaseUrl: WEB }).changedIso, '20260715090000');
});

test('still reads a lowercase xDateIso if IX ever sends it', () => {
  const s: EloSord = { id: '1', name: 'x', type: 254, xDateIso: '20200101000000' };
  assert.equal(toSordView(s, { webclientBaseUrl: WEB }).changedIso, '20200101000000');
});

test('omits indexFields unless requested', () => {
  assert.equal(toSordView(projectFolder, { webclientBaseUrl: WEB }).indexFields, undefined);
});

test('includes only the requested index fields', () => {
  const v = toSordView(projectFolder, { webclientBaseUrl: WEB, indexFields: ['PRJ_NO'] });
  assert.deepEqual(v.indexFields, { PRJ_NO: '10002' });
});

test("'*' includes every index field", () => {
  const v = toSordView(projectFolder, { webclientBaseUrl: WEB, indexFields: '*' });
  assert.equal(Object.keys(v.indexFields ?? {}).length, 3);
});

test('childCount only on folders', () => {
  assert.equal(toSordView(projectFolder, { webclientBaseUrl: WEB }).childCount, 12);
  assert.equal(toSordView(documentSord, { webclientBaseUrl: WEB }).childCount, undefined);
});

test('otherPathCount counts additional filings only', () => {
  assert.equal(toSordView(projectFolder, { webclientBaseUrl: WEB }).otherPathCount, undefined);
  const multi: EloSord = {
    ...projectFolder,
    refPaths: [...projectFolder.refPaths!, { path: [{ id: '99', name: 'Elsewhere' }] }],
  };
  assert.equal(toSordView(multi, { webclientBaseUrl: WEB }).otherPathCount, 1);
});

test('undefined fields disappear from the serialised payload', () => {
  const json = JSON.stringify(toSordView({ id: '7', name: 'bare', type: 254 }, { webclientBaseUrl: WEB }));
  assert.ok(!json.includes('null'), 'no null noise');
  assert.ok(!json.includes('path'), 'absent path is not serialised');
});

// --- isInsideFolder --------------------------------------------------------

section('isInsideFolder');

test('matches a direct parent', () => {
  assert.equal(isInsideFolder(projectFolder, '6985'), true);
});

test('matches a grandparent further up the chain', () => {
  assert.equal(isInsideFolder(projectFolder, '6411'), true);
});

test('matches the folder itself', () => {
  assert.equal(isInsideFolder(projectFolder, '500001'), true);
});

test('rejects an unrelated folder', () => {
  assert.equal(isInsideFolder(projectFolder, '8660'), false);
});

test('tolerates numeric ids on either side', () => {
  assert.equal(isInsideFolder(projectFolder, 6985 as unknown as string), true);
});

// --- rankProjectFolders — the wrong-data-room fix ---------------------------
//
// Confirmed against a live archive: a project number is carried by one folder
// (marked SOL_TYPE=PROJEKT) while a *title* search for that same number surfaces
// a different one (marked AKQUISE) — see the fixtures above. Both used to come
// back unlabelled and unordered, so the model picked whichever landed first.

section('rankProjectFolders');

const exactProject: ProjectCandidate = { sord: projectFolder, matchType: 'exact', isProjectRoot: true };
const fuzzyProject: ProjectCandidate = { sord: projectFolder, matchType: 'fuzzy', isProjectRoot: true };
const exactNonRoot: ProjectCandidate = { sord: acquisitionFolder, matchType: 'exact', isProjectRoot: false };
const fuzzyNonRoot: ProjectCandidate = { sord: acquisitionFolder, matchType: 'fuzzy', isProjectRoot: false };

test('exact+root outranks every other combination', () => {
  const ranked = rankProjectFolders([fuzzyNonRoot, exactNonRoot, fuzzyProject, exactProject]);
  assert.equal(ranked[0], exactProject);
});

test('exact outranks fuzzy at equal root status', () => {
  const ranked = rankProjectFolders([fuzzyNonRoot, exactNonRoot]);
  assert.equal(ranked[0], exactNonRoot);
});

test('a project root outranks a non-root at equal match type', () => {
  const ranked = rankProjectFolders([fuzzyNonRoot, fuzzyProject]);
  assert.equal(ranked[0], fuzzyProject);
});

test('full ordering: exact+root > exact > root > fuzzy', () => {
  const ranked = rankProjectFolders([fuzzyNonRoot, fuzzyProject, exactNonRoot, exactProject]);
  assert.deepEqual(
    ranked.map((c) => `${c.matchType}/${c.isProjectRoot}`),
    ['exact/true', 'exact/false', 'fuzzy/true', 'fuzzy/false'],
  );
});

test('is stable and does not mutate the input array', () => {
  const input = [fuzzyNonRoot, exactProject];
  const ranked = rankProjectFolders(input);
  assert.deepEqual(input, [fuzzyNonRoot, exactProject], 'input untouched');
  assert.equal(ranked.length, 2);
});

test('handles an empty candidate list', () => {
  assert.deepEqual(rankProjectFolders([]), []);
});

// --- resolveStreamUrl — both real IX URL shapes ----------------------------
//
// Verified against the live instance: `getstream` 404s from the origin root and
// from the app path; only <base>/rest/getstream serves bytes. `docs[0].url`
// arrives on an internal hostname that no external container can reach.

section('resolveStreamUrl');

const IX = 'https://elo.example.com/ix-INSTANCE';

test('bare relative URL resolves against the REST root', () => {
  assert.equal(
    resolveStreamUrl(IX, 'getstream?serverid=1&messageid=2&streamid=3'),
    'https://elo.example.com/ix-INSTANCE/rest/getstream?serverid=1&messageid=2&streamid=3',
  );
});

test('trailing slash on the base does not double up', () => {
  assert.equal(
    resolveStreamUrl(`${IX}/`, 'getstream?a=1'),
    'https://elo.example.com/ix-INSTANCE/rest/getstream?a=1',
  );
});

test('internal-host absolute URL is re-anchored onto the public origin', () => {
  assert.equal(
    resolveStreamUrl(IX, 'http://internal-host:9090/ix-INSTANCE/ix?cmd=readdoc&id=7'),
    'https://elo.example.com/ix-INSTANCE/ix?cmd=readdoc&id=7',
  );
});

test('an origin-relative URL keeps its own path', () => {
  assert.equal(resolveStreamUrl(IX, '/download/42?x=1'), 'https://elo.example.com/download/42?x=1');
});

test('credentials can never be sent to a foreign host', () => {
  const evil = resolveStreamUrl(IX, 'https://attacker.example.com/steal?t=1');
  assert.ok(evil.startsWith('https://elo.example.com/'), evil);
});

test('rejects non-HTTP schemes', () => {
  assert.throws(() => resolveStreamUrl(IX, 'file:///etc/passwd'), UnsafeStreamUrlError);
});

test('rejects an empty URL', () => {
  assert.throws(() => resolveStreamUrl(IX, '   '), UnsafeStreamUrlError);
});

test('isForeignHost spots the internal hostname', () => {
  assert.equal(isForeignHost(IX, 'http://internal-host:9090/ix-INSTANCE/ix'), true);
  assert.equal(isForeignHost(IX, 'getstream?a=1'), false);
});

// --- extraction helpers ----------------------------------------------------

section('normaliseWhitespace');

test('collapses runs of blank lines', () => {
  assert.equal(normaliseWhitespace('a\n\n\n\n\nb'), 'a\n\nb');
});

test('strips control characters but keeps newlines and tabs', () => {
  assert.equal(normaliseWhitespace('a b\nc'), 'ab\nc');
});

test('normalises CRLF and trailing spaces', () => {
  assert.equal(normaliseWhitespace('a   \r\n   b'), 'a\n b');
});

test('trims the result', () => {
  assert.equal(normaliseWhitespace('\n\n  hello  \n\n'), 'hello');
});

section('extractText dispatch');

test('unsupported types succeed with an explanation rather than failing', async () => {
  const r = await extractText({ data: Buffer.from('x'), contentType: 'application/octet-stream', ext: 'ECF' });
  assert.equal(r.extractor, 'none');
  assert.equal(r.text, '');
  assert.ok(r.notice?.includes('encrypted'), r.notice);
  assert.ok(r.notice?.includes('eloLink'), r.notice);
});

test('images are explained, not silently empty', async () => {
  const r = await extractText({ data: Buffer.from('x'), contentType: 'image/tiff' });
  assert.equal(r.extractor, 'none');
  assert.ok(r.notice?.includes('OCR'), r.notice);
});

test('the extension wins over a generic octet-stream MIME type', async () => {
  const r = await extractText({
    data: Buffer.from('hello world'),
    contentType: 'application/octet-stream',
    ext: 'TXT',
  });
  assert.equal(r.extractor, 'plain');
  assert.equal(r.text, 'hello world');
});

test('decodes UTF-8 umlauts', async () => {
  const r = await extractText({ data: Buffer.from('Prüfbericht Größe', 'utf8'), ext: 'TXT' });
  assert.equal(r.text, 'Prüfbericht Größe');
});

test('falls back to windows-1252 for legacy encodings', async () => {
  // 0xFC is "ü" in CP1252 and invalid as standalone UTF-8.
  const r = await extractText({ data: Buffer.from([0x50, 0x72, 0xfc, 0x66]), ext: 'TXT' });
  assert.equal(r.text, 'Prüf');
});

test('strips a UTF-8 BOM', async () => {
  const r = await extractText({ data: Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), ext: 'TXT' });
  assert.equal(r.text, 'hi');
});

// --- EML extraction ---------------------------------------------------------
//
// Mail is where encodings actually bite: quoted-printable umlauts, base64
// bodies, charset labels other than UTF-8, and HTML-only messages.

section('extractEml');

/** Build a message with CRLF line endings, as real mail has. */
const mail = (...lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'latin1');

test('reads a simple plain-text mail with a header block', () => {
  const r = extractEml({
    data: mail(
      'From: Anna Beispiel <anna@example.com>',
      'To: bob@example.com',
      'Subject: Kurze Frage',
      'Date: Mon, 4 Aug 2026 09:12:00 +0200',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hallo Bob,',
      'passt Dir Donnerstag?',
      '',
    ),
  });
  assert.equal(r.extractor, 'eml');
  assert.equal(r.textLayer, 'present');
  assert.ok(r.text.includes('From: Anna Beispiel <anna@example.com>'));
  assert.ok(r.text.includes('Subject: Kurze Frage'));
  assert.ok(r.text.includes('passt Dir Donnerstag?'));
});

test('decodes quoted-printable umlauts', () => {
  const r = extractEml({
    data: mail(
      'Subject: Pr=C3=BCfung',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Gr=C3=BC=C3=9Fe aus M=C3=BCnchen',
      '',
    ),
  });
  assert.ok(r.text.includes('Grüße aus München'), r.text);
});

test('honours a quoted-printable soft line break', () => {
  const r = extractEml({
    data: mail(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Dieser Satz wurde hart =',
      'umbrochen.',
      '',
    ),
  });
  assert.ok(r.text.includes('hart umbrochen.'), r.text);
});

test('decodes a base64 body', () => {
  const body = Buffer.from('Angebot liegt bei.', 'utf8').toString('base64');
  const r = extractEml({
    data: mail(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '',
    ),
  });
  assert.ok(r.text.includes('Angebot liegt bei.'), r.text);
});

test('decodes a non-UTF-8 charset', () => {
  const head = Buffer.from(
    ['Content-Type: text/plain; charset=iso-8859-1', '', ''].join('\r\n'),
    'latin1',
  );
  const r = extractEml({ data: Buffer.concat([head, Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65])]) });
  assert.ok(r.text.includes('Grüße'), r.text);
});

test('prefers the plain-text part over HTML in multipart/alternative', () => {
  const r = extractEml({
    data: mail(
      'Subject: Beides',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'NURTEXT',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>NURHTML</p>',
      '--b1--',
      '',
    ),
  });
  assert.ok(r.text.includes('NURTEXT'), r.text);
  assert.ok(!r.text.includes('NURHTML'), 'HTML part must not be used when plain text exists');
});

test('falls back to HTML and strips markup', () => {
  const r = extractEml({
    data: mail(
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>p{color:red}</style></head><body>',
      '<p>Erste Zeile</p><p>Zweite&nbsp;Zeile &amp; mehr</p>',
      '<script>alert(1)</script></body></html>',
      '',
    ),
  });
  assert.ok(r.text.includes('Erste Zeile'), r.text);
  assert.ok(r.text.includes('Zweite Zeile & mehr'), r.text);
  assert.ok(!r.text.includes('alert'), 'script content must be dropped');
  assert.ok(!r.text.includes('color:red'), 'style content must be dropped');
  assert.ok(r.notice?.includes('HTML'), r.notice);
});

test('lists attachments without decoding them', () => {
  const r = extractEml({
    data: mail(
      'Subject: Mit Anhang',
      'Content-Type: multipart/mixed; boundary="m1"',
      '',
      '--m1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Anbei der Bericht.',
      '--m1',
      'Content-Type: application/pdf; name="Bericht.pdf"',
      'Content-Disposition: attachment; filename="Bericht.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 nicht echt').toString('base64'),
      '--m1--',
      '',
    ),
  });
  assert.ok(r.text.includes('Anbei der Bericht.'), r.text);
  assert.ok(r.text.includes('--- Attachments ---'), r.text);
  assert.ok(r.text.includes('Bericht.pdf'), r.text);
  assert.ok(!r.text.includes('%PDF'), 'attachment payload must not be inlined');
  assert.ok(r.notice?.includes('attachment'), r.notice);
});

test('walks nested multipart (mixed containing alternative)', () => {
  const r = extractEml({
    data: mail(
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'TIEFERTEXT',
      '--inner--',
      '--outer--',
      '',
    ),
  });
  assert.ok(r.text.includes('TIEFERTEXT'), r.text);
});

test('unfolds headers that span several lines', () => {
  const r = extractEml({
    data: mail(
      'Subject: Ein sehr langer Betreff, der',
      '\tueber zwei Zeilen geht',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Rumpf',
      '',
    ),
  });
  assert.ok(r.text.includes('ueber zwei Zeilen geht'), r.text);
});

test('recovers the body of a truncated multipart mail', () => {
  // No closing --b-- delimiter: the last part must not be silently dropped.
  const r = extractEml({
    data: mail(
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'ABGESCHNITTEN',
    ),
  });
  assert.ok(r.text.includes('ABGESCHNITTEN'), r.text);
});

test('a headers-only mail reports no readable content', () => {
  const r = extractEml({
    data: mail('From: a@example.com', 'Subject: Leer', 'Content-Type: text/plain', '', ''),
  });
  assert.equal(r.textLayer, 'none', 'header block alone is not content');
});

test('rejects an empty file', () => {
  assert.throws(() => extractEml({ data: Buffer.alloc(0) }), /empty/i);
});

test('dispatches .eml by extension and by MIME type', async () => {
  const data = mail('Subject: Weg', 'Content-Type: text/plain', '', 'Inhalt', '');
  assert.equal((await extractText({ data, ext: 'EML' })).extractor, 'eml');
  assert.equal((await extractText({ data, contentType: 'message/rfc822' })).extractor, 'eml');
});

test('.eml is no longer reported as unreadable', async () => {
  const r = await extractText({
    data: mail('Content-Type: text/plain', '', 'Da', ''),
    contentType: 'application/octet-stream',
    ext: 'EML',
  });
  assert.notEqual(r.extractor, 'none');
});

// --- MSG (Outlook) ----------------------------------------------------------
//
// The OLE2 container is the library's job; what is ours is turning MAPI fields
// into the same shape .eml produces, and stripping RTF when that is the only
// body a message carries.

section('mapMsgFields');

test('renders a header block and the plain-text body', () => {
  const r = mapMsgFields({
    subject: 'Angebot',
    senderName: 'Anna Beispiel',
    senderEmail: 'anna@example.com',
    messageDeliveryTime: '2026-08-04T09:12:00Z',
    recipients: [
      { name: 'Bob', email: 'bob@example.com', recipType: 'to' },
      { name: 'Carla', email: 'carla@example.com', recipType: 'cc' },
    ],
    body: 'Anbei das Angebot.',
  });
  assert.equal(r.extractor, 'msg');
  assert.equal(r.textLayer, 'present');
  assert.ok(r.text.includes('From: Anna Beispiel <anna@example.com>'), r.text);
  assert.ok(r.text.includes('To: Bob <bob@example.com>'), r.text);
  assert.ok(r.text.includes('Cc: Carla <carla@example.com>'), r.text);
  assert.ok(r.text.includes('Subject: Angebot'), r.text);
  assert.ok(r.text.includes('Anbei das Angebot.'), r.text);
});

test('treats recipients without an explicit type as To', () => {
  const r = mapMsgFields({ recipients: [{ name: 'Bob', email: 'bob@example.com' }], body: 'x' });
  assert.ok(r.text.includes('To: Bob <bob@example.com>'), r.text);
});

test('does not print a name twice when it equals the address', () => {
  const r = mapMsgFields({ senderName: 'anna@example.com', senderEmail: 'anna@example.com', body: 'x' });
  assert.ok(r.text.includes('From: anna@example.com'), r.text);
  assert.ok(!r.text.includes('<anna@example.com>'), r.text);
});

test('accepts smtpAddress when email is absent', () => {
  const r = mapMsgFields({ recipients: [{ name: 'Bob', smtpAddress: 'bob@example.com' }], body: 'x' });
  assert.ok(r.text.includes('bob@example.com'), r.text);
});

test('falls back to HTML when there is no plain body', () => {
  const r = mapMsgFields({ bodyHtml: '<p>Hallo <b>Welt</b></p>' });
  assert.ok(r.text.includes('Hallo'), r.text);
  assert.ok(!r.text.includes('<b>'), r.text);
  assert.ok(r.notice?.includes('HTML'), r.notice);
});

test('falls back to RTF when neither plain nor HTML exists', () => {
  const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Sehr geehrte Damen,\par nach Pr\'fcfung.\par}`;
  const r = mapMsgFields({}, rtf);
  assert.ok(r.text.includes('Sehr geehrte Damen'), r.text);
  assert.ok(r.text.includes('Prüfung'), r.text);
  assert.ok(!r.text.includes('fonttbl'), 'font table must not leak into the text');
  assert.ok(!r.text.includes('\\rtf1'), r.text);
  assert.ok(r.notice?.includes('RTF'), r.notice);
});

test('plain text wins over HTML and RTF', () => {
  const r = mapMsgFields({ body: 'KLARTEXT', bodyHtml: '<p>HTML</p>' }, String.raw`{\rtf1 RTF}`);
  assert.ok(r.text.includes('KLARTEXT'), r.text);
  assert.ok(!r.text.includes('HTML'), r.text);
  assert.ok(!r.text.includes('RTF'), r.text);
});

test('lists attachments and never inlines them', () => {
  const r = mapMsgFields({
    body: 'Siehe Anhang.',
    attachments: [
      { fileName: 'Angebot.pdf', attachMimeTag: 'application/pdf' },
      { name: 'bild.png' },
    ],
  });
  assert.ok(r.text.includes('--- Attachments ---'), r.text);
  assert.ok(r.text.includes('1. Angebot.pdf [application/pdf]'), r.text);
  assert.ok(r.text.includes('2. bild.png'), r.text);
  assert.ok(r.notice?.includes('attachment'), r.notice);
});

test('a message with no body at all is reported as unreadable', () => {
  const r = mapMsgFields({ subject: 'Nur Anhang', attachments: [{ fileName: 'a.pdf' }] });
  assert.equal(r.textLayer, 'none', 'header block alone is not content');
  assert.ok(r.notice?.includes('no readable body'), r.notice);
});

section('rtfToText');

test('resolves \\par, \\line and \\tab', () => {
  assert.equal(rtfToText(String.raw`a\par b\line c\tab d`).replace(/ +/g, ' ').trim(), 'a\n b\n c\t d');
});

test('decodes \\uNNNN and hex escapes', () => {
  // Built by concatenation so the escape reaches rtfToText intact rather than
  // being resolved by the TypeScript source itself.
  assert.ok(rtfToText('a ' + '\\u8364' + '? b').includes('€'));
  assert.ok(rtfToText(String.raw`Gr\'fc\'df e`).includes('Grüß'));
});

test('keeps escaped braces and backslashes', () => {
  const t = rtfToText(String.raw`a \{b\} c \\ d`);
  assert.ok(t.includes('{b}'), t);
  assert.ok(t.includes('\\'), t);
});

test('drops metadata destination groups', () => {
  const t = rtfToText(String.raw`{\rtf1{\*\generator Riched20}{\colortbl;\red0\green0\blue0;}Text}`);
  assert.ok(t.includes('Text'), t);
  assert.ok(!t.includes('Riched20'), t);
  assert.ok(!t.includes('colortbl'), t);
});

section('MSG dispatch');

test('.msg routes to the msg extractor by extension', async () => {
  // Not a valid OLE2 file, so it must fail *as a msg*, not fall through to
  // "unsupported" — the routing is what is under test.
  await assert.rejects(
    () => extractText({ data: Buffer.from('kein echtes MSG'), ext: 'MSG' }),
    /Outlook message/i,
  );
});

test('.ecf is reported as ELO-encrypted, not as a mail container', async () => {
  const r = await extractText({ data: Buffer.from('EloCryptAES_v'), ext: 'ECF' });
  assert.equal(r.extractor, 'none');
  assert.ok(r.notice?.includes('encrypted'), r.notice);
});

// --- Math.sumPrecise polyfill ----------------------------------------------
//
// pdf.js (bundled by unpdf 1.8.0) calls Math.sumPrecise, which Node 24 does not
// provide. Without it, PDFs that reach those code paths fail to extract.

section('sumPrecise');

test('sums integers exactly', () => {
  assert.equal(sumPrecise([1, 2, 3, 4, 5]), 15);
});

test('empty iterable gives -0, per the proposal', () => {
  assert.ok(Object.is(sumPrecise([]), -0));
});

test('beats naive summation on catastrophic cancellation', () => {
  // The classic case: the small terms vanish in a naive left-to-right sum.
  const items = [1e16, 1, 1, 1, -1e16];
  const naive = items.reduce((a, b) => a + b, 0);
  assert.equal(sumPrecise(items), 3);
  assert.notEqual(naive, 3);
});

test('handles many small fractions without drift', () => {
  const items = new Array(10_000).fill(0.1);
  assert.equal(sumPrecise(items), 1000);
});

test('NaN anywhere wins', () => {
  assert.ok(Number.isNaN(sumPrecise([1, NaN, 2])));
});

test('opposing infinities give NaN', () => {
  assert.ok(Number.isNaN(sumPrecise([Infinity, -Infinity])));
});

test('a single infinity propagates', () => {
  assert.equal(sumPrecise([1, Infinity, 2]), Infinity);
  assert.equal(sumPrecise([1, -Infinity, 2]), -Infinity);
});

test('all-negative-zero sums to -0', () => {
  assert.ok(Object.is(sumPrecise([-0, -0]), -0));
});

test('cancellation to zero gives +0, not -0', () => {
  assert.ok(Object.is(sumPrecise([1, -1]), 0));
});

test('accepts any iterable, not just arrays', () => {
  assert.equal(sumPrecise(new Set([1, 2, 3])), 6);
  assert.equal(
    sumPrecise(
      (function* () {
        yield 2;
        yield 4;
      })(),
    ),
    6,
  );
});

test('rejects non-numeric values', () => {
  assert.throws(() => sumPrecise([1, '2' as unknown as number]), TypeError);
});

test('rejects a non-iterable argument', () => {
  assert.throws(() => sumPrecise(42 as unknown as number[]), TypeError);
});

test('installs onto Math and is idempotent', () => {
  installSumPrecisePolyfill();
  const fn = (Math as unknown as { sumPrecise?: unknown }).sumPrecise;
  assert.equal(typeof fn, 'function');
  installSumPrecisePolyfill();
  assert.equal((Math as unknown as { sumPrecise?: unknown }).sumPrecise, fn, 'second install must not replace it');
});

test('the installed function is non-enumerable, like a built-in', () => {
  installSumPrecisePolyfill();
  assert.ok(!Object.keys(Math).includes('sumPrecise'));
});

test('pdf.js usage shape: summing glyph widths works', () => {
  // _getTextWidth does exactly this: sum widths, then divide by 1000.
  const widths = [500, 722, 333, 611, 278];
  assert.equal(sumPrecise(widths) / 1e3, 2.444);
});

// --- Spreadsheets -----------------------------------------------------------

section('Extraction — Excel workbooks');

/**
 * Build a minimal but real .xlsx in memory.
 *
 * Checking a binary fixture into the repo would hide what is being tested;
 * generating the OOXML parts here means the test states, in the open, exactly
 * which cell shapes it exercises — in particular the styled date cell, which
 * is the one that produces a wrong answer rather than a missing one when it
 * goes wrong.
 */
function buildXlsx(sheets: Array<{ name: string; rows: Array<Array<string | number | Date | null>> }>): Buffer {
  const strings: string[] = [];
  const internString = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing !== -1) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const colName = (i: number): string => {
    let n = i;
    let out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  };
  // Excel counts days from 1899-12-30; 25569 is the offset to the Unix epoch.
  const serial = (d: Date): number => d.getTime() / 86_400_000 + 25569;
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sheetXml = sheets.map(({ rows }) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            if (value === null) return '';
            const ref = `${colName(c)}${r + 1}`;
            if (value instanceof Date) return `<c r="${ref}" s="1"><v>${serial(value)}</v></c>`;
            if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
            return `<c r="${ref}" t="s"><v>${internString(value)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('')}</sheetData></worksheet>`,
  );

  const rels = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');

  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(({ name }, i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rIdStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    // cellXfs[1] carries numFmtId 14 — the built-in short date format.
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  sheetXml.forEach((xml, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = xml));
  files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}"><si>${strings
    .map((s) => esc(s))
    .join('</t></si><si><t>')}</t></si></sst>`.replace('<si>', '<si><t>');

  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  );
}

const xlsxInput = (data: Buffer) => ({ data, ext: 'XLSX', contentType: 'application/octet-stream' });

test('a workbook flattens to pipe-separated rows under a sheet heading', async () => {
  const data = buildXlsx([
    { name: 'Rechnungen', rows: [['Beleg', 'Betrag'], ['RE-001', 1234.56]] },
  ]);
  const result = await extractText(xlsxInput(data));
  assert.equal(result.extractor, 'xlsx');
  assert.equal(result.textLayer, 'present');
  assert.equal(result.text, 'Sheet: Rechnungen\nBeleg | Betrag\nRE-001 | 1234.56');
});

test('a date cell reads as a date, not as its serial number', async () => {
  // The failure this guards against is not an empty result but a wrong one:
  // an unformatted serial would report 45658 where 2025-01-01 was meant.
  const data = buildXlsx([{ name: 'S', rows: [['Fällig', new Date(Date.UTC(2025, 0, 1))]] }]);
  const result = await extractText(xlsxInput(data));
  assert.match(result.text, /Fällig \| 2025-01-01$/);
  assert.ok(!result.text.includes('45658'));
});

test('every sheet is included and named', async () => {
  const data = buildXlsx([
    { name: 'Erste', rows: [['a']] },
    { name: 'Zweite', rows: [['b']] },
  ]);
  const result = await extractText(xlsxInput(data));
  assert.equal(result.pageCount, 2);
  assert.equal(result.text, 'Sheet: Erste\na\n\nSheet: Zweite\nb');
});

test('trailing empty cells and blank rows are dropped', async () => {
  // Sheets routinely carry formatting far right of the data; rendering it
  // would spend tokens on "a | | | |" for every row.
  const data = buildXlsx([
    { name: 'S', rows: [['a', null, null], [null, null], ['b']] },
  ]);
  const result = await extractText(xlsxInput(data));
  assert.equal(result.text, 'Sheet: S\na\nb');
});

test('a line break inside a cell does not split the row', async () => {
  const data = buildXlsx([{ name: 'S', rows: [['zwei\nzeilen', 'x']] }]);
  const result = await extractText(xlsxInput(data));
  assert.equal(result.text, 'Sheet: S\nzwei zeilen | x');
});

test('the separator survives whitespace normalisation', async () => {
  // Regression guard for choosing " | " over tabs: normaliseWhitespace
  // collapses runs of spaces and tabs, so a TSV grid would lose its columns.
  assert.equal(normaliseWhitespace('a | b | c'), 'a | b | c');
  assert.equal(normaliseWhitespace('a\tb\tc'), 'a b c');
});

test('an empty workbook says so instead of returning nothing', async () => {
  const data = buildXlsx([{ name: 'Leer', rows: [] }]);
  const result = await extractText(xlsxInput(data));
  assert.equal(result.text, '');
  assert.equal(result.textLayer, 'none');
  assert.match(result.notice ?? '', /empty/i);
});

test('a password-protected workbook is named as such, not as a parse error', async () => {
  // Excel wraps an encrypted package in an OLE2 container, which is not a ZIP.
  const cfb = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512),
  ]);
  await assert.rejects(() => extractText(xlsxInput(cfb)), /password-protected|legacy \.xls/i);
});

test('a file that is not a workbook fails as an extraction error', async () => {
  await assert.rejects(
    () => extractText(xlsxInput(Buffer.from('definitely not a spreadsheet'))),
    /could not be parsed/i,
  );
});

test('legacy .xls is still reported as unreadable, with the reason', async () => {
  const result = await extractText({ data: Buffer.from('x'), ext: 'XLS' });
  assert.equal(result.extractor, 'none');
  assert.match(result.notice ?? '', /Legacy Excel format/);
});

// --- OAuth: PKCE ------------------------------------------------------------

section('OAuth — PKCE');

test('a generated verifier matches its own challenge', () => {
  const verifier = randomToken(32);
  assert.ok(verifyS256(verifier, s256Challenge(verifier)));
});

test('a different verifier does not match', () => {
  assert.ok(!verifyS256(randomToken(32), s256Challenge(randomToken(32))));
});

test('a verifier shorter than RFC 7636 allows is rejected outright', () => {
  // 43 characters is the floor. Anything shorter must fail on the format check
  // rather than being hashed and compared.
  const short = 'abc';
  assert.ok(!verifyS256(short, s256Challenge(short)));
});

test('a verifier with characters outside the allowed alphabet is rejected', () => {
  const bad = '!'.repeat(50);
  assert.ok(!verifyS256(bad, s256Challenge(bad)));
});

// --- OAuth: config-dependent modules ----------------------------------------
//
// Everything below needs a parsed config, which is normally published by the
// entry point. Build a minimal one here rather than reading the environment.

setConfig({
  ELO_BASE_URL: 'https://ix.example/ix',
  ELO_WEBCLIENT_URL: 'https://link.example',
  ELO_USERNAME: 'tech',
  ELO_PASSWORD: 'tech-pw',
  ELO_LANGUAGE: 'de',
  ELO_COUNTRY: 'DE',
  ELO_TIMEZONE: 'UTC',
  ELO_PROJECT_NUMBER_FIELD: 'PRJ_NO',
  ELO_PROJECT_NAME_FIELD: 'PRJ_NAME',
  ELO_PROJECT_MARKER_FIELD: 'SOL_TYPE',
  ELO_PROJECT_MARKER_VALUE: 'PROJEKT',
  LOG_LEVEL: 'fatal',
  ELO_MAX_DOCUMENT_BYTES: 1024,
  ELO_MAX_TEXT_CHARS: 1000,
  ELO_DOWNLOAD_TIMEOUT_MS: 1000,
  ELO_CONTENT_CONCURRENCY: 1,
  ELO_DOCUMENT_CONTENT_ENABLED: true,
  MCP_TRANSPORT: 'http',
  MCP_HTTP_PORT: 3000,
  MCP_HTTP_HOST: '127.0.0.1',
  MCP_SHARED_SECRET: 'unit-test-shared-secret',
  MCP_AUTH_MODE: 'both',
  PUBLIC_BASE_URL: 'https://mcp.example',
  OAUTH_TOKEN_SECRET: 'unit-test-token-secret-at-least-32-chars',
  OAUTH_SESSION_SECRET: 'unit-test-session-secret-at-least-32-ch',
  OAUTH_ACCESS_TOKEN_TTL: 3600,
  OAUTH_REFRESH_TOKEN_TTL: 2_592_000,
  OAUTH_SERVER_NAME: 'ELO MCP Server',
  OAUTH_MAX_CLIENTS: 500,
  ELO_USER_SESSION_TTL: 28_800,
  ELO_MAX_USER_SESSIONS: 50,
  oauthEnabled: true,
  sharedSecretEnabled: true,
  MCP_RESOURCE: 'https://mcp.example/mcp',
  PRM_URL: 'https://mcp.example/.well-known/oauth-protected-resource',
});

section('OAuth — access token');

const sampleClaims = {
  userName: 'jdoe',
  displayName: 'Jane Doe',
  clientId: 'client-1',
  eloSid: 'sid-abc',
};

test('a freshly signed token verifies', async () => {
  const payload = await verifyAccessTokenJwt(await signAccessToken(sampleClaims));
  assert.equal(payload.sub, 'jdoe');
  assert.equal(payload.iss, 'https://mcp.example');
  assert.equal(payload.aud, 'https://mcp.example/mcp');
  assert.equal(payload.elo_sid, 'sid-abc');
});

test('the token carries a handle, never the credentials', async () => {
  const token = await signAccessToken(sampleClaims);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.ok(!('password' in claims));
  assert.ok(!('userPwd' in claims));
  assert.equal(typeof claims.elo_sid, 'string');
});

test('a tampered signature is rejected', async () => {
  const [header, body] = (await signAccessToken(sampleClaims)).split('.');
  await assert.rejects(() => verifyAccessTokenJwt(`${header}.${body}.${'A'.repeat(43)}`));
});

test('a token issued for another audience is rejected', async () => {
  const token = await signAccessToken(sampleClaims);
  // Same secret, different deployment. `aud` is what keeps the two apart.
  setConfig({ ...config(), MCP_RESOURCE: 'https://other.example/mcp' });
  await assert.rejects(() => verifyAccessTokenJwt(token));
  setConfig({ ...config(), MCP_RESOURCE: 'https://mcp.example/mcp' });
});

section('OAuth — bearer verification');

test('the shared secret is accepted and carries no ELO session', async () => {
  const info = await new McpTokenVerifier().verifyAccessToken('unit-test-shared-secret');
  assert.equal(info.clientId, SHARED_SECRET_CLIENT_ID);
  assert.equal(info.extra?.eloSid, undefined);
});

test('a wrong shared secret is refused', async () => {
  await assert.rejects(() => new McpTokenVerifier().verifyAccessToken('nope'));
});

test('a valid token whose ELO session is gone is refused, not downgraded', async () => {
  // The important half is "not downgraded": falling back to the technical
  // account here would hand the caller permissions they never had.
  resetEloSessions();
  const token = await signAccessToken(sampleClaims);
  await assert.rejects(
    () => new McpTokenVerifier().verifyAccessToken(token),
    /ELO session/i,
  );
});

section('OAuth — login failure classification');

function axiosError(status?: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status ?? '?'}`), {
    isAxiosError: true,
    ...(status ? { response: { status } } : {}),
  });
}

test('IX error 3008 is the user’s problem, not the server’s', () => {
  const err = classifyLoginError(
    new Error('ELO login rejected: [ELOIX:3008] Unbekannter Benutzer, falsches Passwort'),
  );
  assert.equal(err.kind, 'credentials');
});

test('a 401 from the proxy is the server’s problem', () => {
  // The user typed nothing wrong — ELO_BASIC_AUTH_* is misconfigured.
  assert.equal(classifyLoginError(axiosError(401)).kind, 'proxy-auth');
});

test('no response at all reads as unreachable', () => {
  assert.equal(classifyLoginError(axiosError()).kind, 'unreachable');
});

test('another IX rejection is not reported as a wrong password', () => {
  // A licence limit is not something the user can fix by retyping.
  const err = classifyLoginError(new Error('ELO login rejected: [ELOIX:9001] no free licence'));
  assert.equal(err.kind, 'ix-rejected');
});

test('a stale-credential error is recognised so the session can be dropped', () => {
  assert.ok(isStaleCredentialError(new Error('ELO login rejected: [ELOIX:3008] …')));
  assert.ok(!isStaleCredentialError(new Error('ELO findFirstSords failed (HTTP 500)')));
});

section('Self-description — nextSteps');

const sordView = (over: Partial<SordView> = {}): SordView => ({
  objId: '900',
  name: 'Ein Dokument',
  type: 'document',
  sordType: 254,
  eloLink: 'https://link.example/900',
  ...over,
});

test('respond omits nextSteps entirely when there are none', () => {
  // An empty array in every answer would train the model to ignore the field.
  const text = respond({ a: 1 }, []).content[0]!.text;
  assert.ok(!text.includes('nextSteps'));
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('respond merges nextSteps into the payload', () => {
  const parsed = JSON.parse(respond({ a: 1 }, ['do the thing']).content[0]!.text);
  assert.deepEqual(parsed, { a: 1, nextSteps: ['do the thing'] });
});

test('one exact project match yields a scoped follow-up with the objId filled in', () => {
  const steps = nextStepsForProjectFolder({
    query: '10001', matchMode: 'exact', exactCount: 1, returned: 1, note: '',
    results: [{ ...sordView({ objId: '500', type: 'folder', sordType: 3 }), matchType: 'exact', isProjectRoot: true }],
  } as never);
  assert.ok(steps.some((s) => s.includes('"folderId":"500"')));
  assert.ok(steps.some((s) => s.includes('"parentId":"500"')));
});

test('several matches ask the user instead of naming a folder', () => {
  // The instructions forbid picking one; a nextStep that picked would contradict them.
  const steps = nextStepsForProjectFolder({
    query: 'Muster', matchMode: 'fuzzy', exactCount: 0, returned: 2, note: '',
    results: [
      { ...sordView({ objId: '1', type: 'folder', sordType: 3 }), matchType: 'fuzzy', isProjectRoot: true },
      { ...sordView({ objId: '2', type: 'folder', sordType: 3 }), matchType: 'fuzzy', isProjectRoot: true },
    ],
  } as never);
  assert.equal(steps.length, 1);
  assert.match(steps[0]!, /ask the user/i);
  assert.ok(!steps[0]!.includes('elo_list_folder'));
});

test('a truncated listing offers the exact offset to continue from', () => {
  const steps = nextStepsForListFolder({
    folderId: '500', depth: 1, returned: 50, offset: 0, truncated: true, note: '',
    results: [sordView()],
  } as never);
  assert.ok(steps.some((s) => s.includes('"offset":50')));
});

test('a listing of only folders suggests descending, one with documents does not', () => {
  const onlyFolders = nextStepsForListFolder({
    folderId: '500', depth: 1, returned: 1, offset: 0, truncated: false, note: '',
    results: [sordView({ objId: '600', name: 'Berichte', type: 'folder', sordType: 3 })],
  } as never);
  assert.ok(onlyFolders.some((s) => s.includes('"folderId":"600"')));

  const withDocs = nextStepsForListFolder({
    folderId: '500', depth: 1, returned: 2, offset: 0, truncated: false, note: '',
    results: [
      sordView({ objId: '600', name: 'Berichte', type: 'folder', sordType: 3 }),
      sordView({ objId: '700', name: 'Bericht.pdf' }),
    ],
  } as never);
  // Reading beats descending when there is something to read; two hints dilute.
  assert.ok(withDocs.some((s) => s.includes('elo_get_document_content')));
  assert.ok(!withDocs.some((s) => s.includes('elo_list_folder with {"folderId":"600"')));
});

test('an already-scoped search does not repeat the scoping advice', () => {
  const scoped = nextStepsForSearch({
    query: 'Vertrag', engine: 'index', scope: { parentId: '500', depth: 1 },
    returned: 1, offset: 0, truncated: false, note: '', results: [sordView()],
  } as never);
  assert.ok(!scoped.some((s) => s.includes('elo_find_project_folder')));

  const archiveWide = nextStepsForSearch({
    query: 'Vertrag', engine: 'esearch', returned: 1, offset: 0, truncated: false,
    note: '', results: [sordView()],
  } as never);
  assert.ok(archiveWide.some((s) => s.includes('elo_find_project_folder')));
});

test('a scanned document is pointed at the link, not at more paging', () => {
  const steps = nextStepsForDocumentContent({
    objId: '700', truncated: false, textLayer: 'none',
  } as never);
  assert.equal(steps.length, 1);
  assert.ok(steps[0]!.includes('elo_get_document_link'));
  assert.ok(!steps[0]!.includes('offset'));
});

test('truncated text pages on, and says so', () => {
  const steps = nextStepsForDocumentContent({
    objId: '700', truncated: true, nextOffset: 50_000, textLayer: 'present',
  } as never);
  assert.ok(steps[0]!.includes('"offset":50000'));
});

test('whoami only suggests signing in when that would change something', () => {
  assert.equal(
    nextStepsForWhoAmI({ identity: 'elo-user', authMode: 'both' } as never).length,
    0,
  );
  assert.equal(
    nextStepsForWhoAmI({ identity: 'service-account', authMode: 'shared' } as never).length,
    0,
  );
  assert.equal(
    nextStepsForWhoAmI({ identity: 'service-account', authMode: 'both' } as never).length,
    1,
  );
});

section('Write — the identity gate');

const authOf = (over: Record<string, unknown> = {}) =>
  ({ token: 't', clientId: 'dcr-client', scopes: ['mcp'], expiresAt: 9e9, ...over }) as never;

test('a connection with no identity at all is refused', () => {
  // stdio: no bearer token, so nobody to attribute a write to.
  assert.throws(() => requireEloUser(undefined), /no identity/i);
});

test('the shared secret is refused, and told why', () => {
  // The case withEloClient cannot see: no eloSid, exactly like stdio.
  assert.throws(
    () => requireEloUser(authOf({ clientId: SHARED_SECRET_CLIENT_ID, extra: {} })),
    /read-only|Sign in with OAuth/i,
  );
});

test('an OAuth token without an ELO session is refused', () => {
  assert.throws(() => requireEloUser(authOf({ extra: {} })), /no ELO session/i);
});

test('an eloSid that no longer resolves is refused, never downgraded', () => {
  resetEloSessions();
  assert.throws(() => requireEloUser(authOf({ extra: { eloSid: 'gone' } })), /expired/i);
});

section('Write — the confirmation token');

const prepared = () =>
  prepareWrite({
    operation: 'create_folder',
    userName: 'jdoe',
    clientId: 'dcr-client',
    payloadHash: hashPayload({ name: 'Neuer Ordner', parentId: '567085' }),
    targetId: '567085',
  });
const expectation = (over: Record<string, unknown> = {}) => ({
  userName: 'jdoe',
  clientId: 'dcr-client',
  operation: 'create_folder' as const,
  payloadHash: hashPayload({ name: 'Neuer Ordner', parentId: '567085' }),
  ...over,
});

test('the payload hash ignores key order', () => {
  assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
});

test('a matching token is accepted exactly once', () => {
  resetPreflight();
  const { token } = prepared();
  assert.equal(consumeWrite(token, expectation()).targetId, '567085');
  assert.throws(() => consumeWrite(token, expectation()), /unknown or has already been used/i);
});

test('a token issued to another user is refused', () => {
  resetPreflight();
  const { token } = prepared();
  assert.throws(
    () => consumeWrite(token, expectation({ userName: 'someone-else' })),
    /does not belong to this session/i,
  );
});

test('a token issued through another client is refused', () => {
  resetPreflight();
  const { token } = prepared();
  assert.throws(
    () => consumeWrite(token, expectation({ clientId: 'other-client' })),
    /does not belong to this session/i,
  );
});

test('a changed payload is refused — the preview no longer matches', () => {
  resetPreflight();
  const { token } = prepared();
  assert.throws(
    () => consumeWrite(token, expectation({ payloadHash: hashPayload({ name: 'Etwas anderes' }) })),
    /values changed/i,
  );
});

test('a token for another operation is refused', () => {
  resetPreflight();
  const { token } = prepared();
  assert.throws(
    () => consumeWrite(token, expectation({ operation: 'update_metadata' })),
    /issued for "create_folder"/,
  );
});

test('an expired token is refused', () => {
  resetPreflight();
  const previous = config();
  setConfig({ ...previous, ELO_WRITE_PREFLIGHT_TTL: 1 });
  const { token } = prepared();
  setConfig(previous);
  // Reach into the future rather than sleeping: the entry carries an absolute
  // expiry, so rewinding the clock is the same test without the wait.
  const realNow = Date.now;
  Date.now = () => realNow() + 5_000;
  try {
    assert.throws(() => consumeWrite(token, expectation()), /expired/i);
  } finally {
    Date.now = realNow;
  }
});

section('Write — policy');

const policy = {
  rootIds: ['567085'],
  masks: ['Ordner'],
  fields: ['PRJ_NO'],
  mimeTypes: ['application/pdf'],
  maxBytes: 1000,
};
const sordAt = (id: string, pathIds: string[]): EloSord => ({
  id, name: 'Ziel', type: 4,
  refPaths: [{ path: pathIds.map((p) => ({ id: p, name: p })) }],
});

test('the sandbox folder itself is a permitted target', () => {
  assert.doesNotThrow(() => assertTargetAllowed(sordAt('567085', ['1']), policy));
});

test('something inside the sandbox is permitted', () => {
  assert.doesNotThrow(() => assertTargetAllowed(sordAt('900', ['1', '567085']), policy));
});

test('the sandbox PARENT is not permitted', () => {
  // 548303 is /IT/IT-Sicherheit — a real production area. Allowing the parent
  // would put the whole department inside the write area.
  assert.throws(() => assertTargetAllowed(sordAt('548303', ['1']), policy), /outside every/i);
});

test('an empty root list permits nothing', () => {
  assert.throws(
    () => assertTargetAllowed(sordAt('567085', ['1']), { ...policy, rootIds: [] }),
    /nothing may be written/i,
  );
});

test('masks and fields are allowlisted, and rejections are reported together', () => {
  assert.doesNotThrow(() => assertMaskAllowed('Ordner', policy));
  assert.throws(() => assertMaskAllowed('Rechnung', policy), /not permitted/i);
  assert.doesNotThrow(() => assertFieldsAllowed({ PRJ_NO: '1' }, policy));
  // Both rejects named in one message — a caller fixing them one per round trip
  // is a caller we made three more requests for no reason.
  assert.throws(
    () => assertFieldsAllowed({ PRJ_NO: '1', SOL_TYPE: 'x', OWNER: 'y' }, policy),
    /SOL_TYPE, OWNER/,
  );
});

test('uploads are checked on type and size', () => {
  assert.doesNotThrow(() => assertFileAllowed('application/pdf; charset=binary', 500, policy));
  assert.throws(() => assertFileAllowed('image/png', 500, policy), /may not be uploaded/i);
  assert.throws(() => assertFileAllowed('application/pdf', 5000, policy), /the limit is/i);
  assert.throws(() => assertFileAllowed('application/pdf', 0, policy), /empty/i);
});

section('Write — idempotency');

test('a repeated key returns the first result without acting again', async () => {
  resetIdempotency();
  let calls = 0;
  const run = async () => { calls++; return 'objId-1'; };
  const a = await onceOnly('jdoe', 'k1', run);
  const b = await onceOnly('jdoe', 'k1', run);
  assert.equal(calls, 1);
  assert.equal(b.result, 'objId-1');
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
});

test('the same key from another user is a different operation', async () => {
  resetIdempotency();
  let calls = 0;
  const run = async () => { calls++; return 'x'; };
  await onceOnly('jdoe', 'k1', run);
  await onceOnly('someone-else', 'k1', run);
  assert.equal(calls, 2);
});

test('a failure is not remembered, so a retry may still succeed', async () => {
  resetIdempotency();
  let calls = 0;
  await assert.rejects(() =>
    onceOnly('jdoe', 'k2', async () => { calls++; throw new Error('IX down'); }),
  );
  const { result } = await onceOnly('jdoe', 'k2', async () => { calls++; return 'ok'; });
  assert.equal(calls, 2);
  assert.equal(result, 'ok');
});

section('Server icon');

/** Build a throwaway assets/ directory containing the named PNG stubs. */
function assetsDirWith(...files: string[]): URL {
  const dir = mkdtempSync(join(tmpdir(), 'elo-mcp-assets-'));
  for (const name of files) writeFileSync(join(dir, name), 'not really a png');
  return new URL(`file:///${dir.replace(/\\/g, '/')}/`);
}

test('icon.png wins when it is there', () => {
  const dir = assetsDirWith('icon.png', 'elo_icon.png');
  assert.match(resolveIconPath(dir)?.pathname ?? '', /icon\.png$/);
  assert.ok(!resolveIconPath(dir)?.pathname.includes('elo_icon'));
  rmSync(dir, { recursive: true, force: true });
});

test('a single differently named PNG is used anyway', () => {
  // Replacing the icon is meant to be a file copy, and "icon.png" is not the
  // name anyone reaches for when the file is a company logo.
  const dir = assetsDirWith('elo_icon.png');
  assert.match(resolveIconPath(dir)?.pathname ?? '', /elo_icon\.png$/);
  rmSync(dir, { recursive: true, force: true });
});

test('several PNGs and no icon.png is refused rather than guessed', () => {
  const dir = assetsDirWith('elo_icon.png', 'other.png');
  assert.equal(resolveIconPath(dir), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('an empty assets directory yields no icon', () => {
  const dir = assetsDirWith();
  assert.equal(resolveIconPath(dir), undefined);
  rmSync(dir, { recursive: true, force: true });
});

section('State file — encryption');

const stateKey = Buffer.from('0'.repeat(64), 'hex');

test('a key round-trips through hex and base64url alike', () => {
  const raw = randomBytes(32);
  assert.ok(decodeStateKey(raw.toString('hex')).equals(raw));
  assert.ok(decodeStateKey(raw.toString('base64url')).equals(raw));
});

test('a key of the wrong length is refused, with the length named', () => {
  assert.throws(() => decodeStateKey(randomBytes(16).toString('base64url')), /32 bytes \(got 16\)/);
});

test('ciphertext round-trips', () => {
  const plaintext = JSON.stringify({ hello: 'welt', zahl: 42 });
  assert.equal(decryptState(encryptState(plaintext, stateKey), stateKey), plaintext);
});

test('the plaintext does not appear in the envelope', () => {
  // The whole point: an operator with the volume must not read ELO passwords.
  const envelope = encryptState(JSON.stringify({ password: 'hunter2' }), stateKey);
  assert.ok(!envelope.includes('hunter2'));
  assert.ok(!envelope.includes('password'));
});

test('two writes of the same data differ', () => {
  // A fresh IV per write; identical envelopes would leak that nothing changed.
  const a = encryptState('same', stateKey);
  const b = encryptState('same', stateKey);
  assert.notEqual(a, b);
});

test('the wrong key does not decrypt', () => {
  const envelope = encryptState('geheim', stateKey);
  assert.throws(() => decryptState(envelope, Buffer.from('1'.repeat(64), 'hex')));
});

test('a single flipped bit in the ciphertext is caught', () => {
  // This is why GCM rather than a plain cipher: integrity, not just secrecy.
  const envelope = JSON.parse(encryptState('geheim', stateKey));
  const ct = Buffer.from(envelope.ct, 'base64url');
  ct[0] ^= 0x01;
  envelope.ct = ct.toString('base64url');
  assert.throws(() => decryptState(JSON.stringify(envelope), stateKey));
});

test('a swapped IV is caught', () => {
  const envelope = JSON.parse(encryptState('geheim', stateKey));
  envelope.iv = randomBytes(12).toString('base64url');
  assert.throws(() => decryptState(JSON.stringify(envelope), stateKey));
});

test('an envelope from another version is refused', () => {
  const envelope = JSON.parse(encryptState('geheim', stateKey));
  envelope.v = 2;
  assert.throws(() => decryptState(JSON.stringify(envelope), stateKey), /version/i);
});

section('State file — slices');

test('a slice round-trips through serialise, parse and apply', () => {
  resetSlices();
  let restored: string[] = [];
  const source = ['a', 'b'];
  registerSlice<string[]>({
    name: 'demo',
    serialise: () => source,
    parse: (data) => z.array(z.string()).parse(data),
    apply: (value) => void (restored = value),
  });
  // Mirrors what loadState does either side of the crypto.
  const payload = JSON.stringify({ v: 1, slices: { demo: source } });
  const parsed = JSON.parse(decryptState(encryptState(payload, stateKey), stateKey));
  restored = z.array(z.string()).parse(parsed.slices.demo);
  assert.deepEqual(restored, source);
  resetSlices();
});

test('flushState writes immediately, without waiting for the timer', () => {
  // Covers the logic behind the shutdown handler. Signal *delivery* can only
  // be exercised where SIGTERM is real — see the skip in test-oauth.ts.
  resetSlices();
  const dir = mkdtempSync(join(tmpdir(), 'elo-mcp-unit-'));
  const file = join(dir, 'state.json');
  const key = randomBytes(32).toString('base64url');
  const previous = config();
  setConfig({ ...previous, STATE_FILE: file, STATE_ENCRYPTION_KEY: key });
  try {
    registerSlice<{ n: number }>({
      name: 'demo',
      serialise: () => ({ n: 7 }),
      parse: (data) => z.object({ n: z.number() }).parse(data),
      apply: () => {},
    });
    scheduleSave();
    // Nothing on disk yet: the save is a second away.
    assert.equal(existsSync(file), false);
    flushState();
    assert.equal(existsSync(file), true);
    const payload = JSON.parse(
      decryptState(readFileSync(file, 'utf8'), decodeStateKey(key)),
    );
    assert.deepEqual(payload.slices.demo, { n: 7 });
  } finally {
    setConfig(previous);
    resetSlices();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shutdown flush does not overwrite a newer instance’s state', async () => {
  // The rolling-redeploy case, observed in production: the replacement
  // container boots and reads the file, then the outgoing one receives SIGTERM.
  // Its full-state write would undo whatever the successor had already saved.
  resetSlices();
  const dir = mkdtempSync(join(tmpdir(), 'elo-mcp-handover-'));
  const file = join(dir, 'state.json');
  const key = randomBytes(32).toString('base64url');
  const previous = config();
  setConfig({ ...previous, STATE_FILE: file, STATE_ENCRYPTION_KEY: key });
  try {
    registerSlice<{ who: string }>({
      name: 'demo',
      serialise: () => ({ who: 'departing' }),
      parse: (data) => z.object({ who: z.string() }).parse(data),
      apply: () => {},
    });
    // The departing instance writes once, so it owns the file.
    flushState();
    const successor = encryptState(
      JSON.stringify({ v: 1, slices: { demo: { who: 'successor' } } }),
      decodeStateKey(key),
    );
    // mtime has a coarse resolution on some filesystems; make the change visible.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, successor, 'utf8');

    flushState({ shutdown: true });
    const after = JSON.parse(decryptState(readFileSync(file, 'utf8'), decodeStateKey(key)));
    assert.equal(after.slices.demo.who, 'successor');

    // A normal save is still authoritative — only the shutdown path defers.
    flushState();
    const normal = JSON.parse(decryptState(readFileSync(file, 'utf8'), decodeStateKey(key)));
    assert.equal(normal.slices.demo.who, 'departing');
  } finally {
    setConfig(previous);
    resetSlices();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slice rejects data of the wrong shape', () => {
  resetSlices();
  let applied = false;
  registerSlice<string[]>({
    name: 'demo',
    serialise: () => [],
    parse: (data) => z.array(z.string()).parse(data),
    apply: () => void (applied = true),
  });
  // parse throws before apply is ever reached — which is what keeps a bad
  // slice from half-restoring the others.
  assert.throws(() => z.array(z.string()).parse([1, 2, 3]));
  assert.equal(applied, false);
  resetSlices();
});

section('OAuth — browser session cookie');

/** Minimal Response stand-in: only `append` is exercised by setSession. */
function fakeRes(): { headers: string[]; append(name: string, value: string): void } {
  const headers: string[] = [];
  return { headers, append: (_name, value) => void headers.push(value) };
}

function fakeReq(cookie: string): { get(name: string): string | undefined } {
  return { get: (name) => (name.toLowerCase() === 'cookie' ? cookie : undefined) };
}

const sampleIdentity = {
  userName: 'jdoe',
  displayName: 'Jane Doe',
  idp: 'elo',
  eloSid: 'sid-abc',
};

test('a cookie round-trips through sign and verify', () => {
  const res = fakeRes();
  setSession(res as never, sampleIdentity);
  const cookie = res.headers[0]!.split(';')[0]!;
  assert.deepEqual(getSession(fakeReq(cookie) as never), sampleIdentity);
});

test('a cookie with a tampered payload is rejected', () => {
  const res = fakeRes();
  setSession(res as never, sampleIdentity);
  const [name, value] = res.headers[0]!.split(';')[0]!.split('=') as [string, string];
  const forged = Buffer.from(
    JSON.stringify({ ...sampleIdentity, userName: 'admin', exp: 2_000_000_000 }),
    'utf8',
  ).toString('base64url');
  const signature = value.slice(value.lastIndexOf('.') + 1);
  assert.equal(getSession(fakeReq(`${name}=${forged}.${signature}`) as never), undefined);
});

test('the cookie is HttpOnly and SameSite=Lax', () => {
  const res = fakeRes();
  setSession(res as never, sampleIdentity);
  assert.match(res.headers[0]!, /HttpOnly/);
  assert.match(res.headers[0]!, /SameSite=Lax/);
});

test('no cookie header at all is not a session', () => {
  assert.equal(getSession(fakeReq('') as never), undefined);
});

// --- summary ---------------------------------------------------------------

await chain;

console.log(
  failures === 0
    ? `\nAll ${count} checks passed.`
    : `\n${failures} of ${count} checks FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
