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
