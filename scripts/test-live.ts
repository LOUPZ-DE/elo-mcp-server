// End-to-end checks against the real ELO instance.
//
//   npm run test:live
//
// These are the regression tests for the pilot feedback: they assert that a
// project resolves to exactly one data room, that a scoped search cannot leak
// documents from other projects, and that the link for one object is identical
// no matter which tool produced it.
//
// Read-only. Discovers its own fixtures, so no setup beyond a working .env;
// override with PROBE_PRJ_NO=<number> to pin a specific project.

import { loadConfig } from '../src/utils/config.js';
import { EloClient } from '../src/elo/client.js';
import { runFind, indexInfo } from '../src/elo/find.js';
import { isFolder } from '../src/elo/constants.js';
import { indexField } from '../src/elo/sord.js';
import { eloFindProjectFolder } from '../src/tools/elo_find_project_folder.js';
import { eloListFolder } from '../src/tools/elo_list_folder.js';
import { eloSearch } from '../src/tools/elo_search.js';
import { eloGetDocumentLink } from '../src/tools/elo_get_document_link.js';
import { eloGetMetadata } from '../src/tools/elo_get_metadata.js';
import { eloGetDocumentContent } from '../src/tools/elo_get_document_content.js';

const cfg = loadConfig();
const client = new EloClient({
  baseUrl: cfg.ELO_BASE_URL,
  username: cfg.ELO_USERNAME,
  password: cfg.ELO_PASSWORD,
  basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
  basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
  language: cfg.ELO_LANGUAGE,
  country: cfg.ELO_COUNTRY,
  timeZone: cfg.ELO_TIMEZONE,
});

const projectFolderOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  projectNumberField: cfg.ELO_PROJECT_NUMBER_FIELD,
  projectNameField: cfg.ELO_PROJECT_NAME_FIELD,
  projectMarkerField: cfg.ELO_PROJECT_MARKER_FIELD,
  projectMarkerValue: cfg.ELO_PROJECT_MARKER_VALUE,
};
const listingOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  projectIndexFields: [
    cfg.ELO_PROJECT_NUMBER_FIELD,
    cfg.ELO_PROJECT_NAME_FIELD,
    cfg.ELO_PROJECT_MARKER_FIELD,
  ],
};

const contentOptions = {
  webclientBaseUrl: cfg.ELO_WEBCLIENT_URL,
  maxBytes: cfg.ELO_MAX_DOCUMENT_BYTES,
  maxChars: cfg.ELO_MAX_TEXT_CHARS,
  timeoutMs: cfg.ELO_DOWNLOAD_TIMEOUT_MS,
};

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  await client.login();

  // --- Fixture discovery ---------------------------------------------------
  section('Fixture discovery');
  let projectNumber = process.env.PROBE_PRJ_NO ?? '';
  if (!projectNumber) {
    const found = await runFind(
      client,
      indexInfo([{ name: cfg.ELO_PROJECT_MARKER_FIELD, data: [cfg.ELO_PROJECT_MARKER_VALUE] }]),
      { max: 50 },
    );
    const withChildren = found.sords.filter(
      (s) => isFolder(s.type) && Number(s.childCount) > 0 && indexField(s, cfg.ELO_PROJECT_NUMBER_FIELD),
    );
    projectNumber = indexField(withChildren[0]!, cfg.ELO_PROJECT_NUMBER_FIELD) ?? '';
  }
  check('found a project number to test with', Boolean(projectNumber), 'set PROBE_PRJ_NO manually');
  if (!projectNumber) return finish();
  console.log(`       using ${cfg.ELO_PROJECT_NUMBER_FIELD}="${projectNumber}"`);

  // --- elo_find_project_folder --------------------------------------------
  section('elo_find_project_folder — exact match beats fuzzy');
  const project = await eloFindProjectFolder(client, { projectNumber }, projectFolderOptions);
  check('matchMode is exact', project.matchMode === 'exact', `got "${project.matchMode}"`);
  check('returned at least one folder', project.returned > 0);
  const root = project.results[0];
  if (!root) return finish();
  console.log(`       -> ${root.objId} "${root.name}" @ ${root.path}`);
  check('top hit is a project data room', root.isProjectRoot === true);
  check('top hit is exact', root.matchType === 'exact');
  check('top hit is a folder', root.type === 'folder');
  check('carries a path', Boolean(root.path));
  check('eloLink points at the web base', root.eloLink.startsWith(cfg.ELO_WEBCLIENT_URL));
  check(
    'eloLink contains the objId',
    root.eloLink.includes(`/${root.objId}`),
    root.eloLink,
  );
  check(
    `project number index field matches the query`,
    root.projectNumber === projectNumber,
    `field="${root.projectNumber}" query="${projectNumber}"`,
  );

  // The wrong-data-room scenario: a fuzzy title search for the same number may
  // legitimately find other folders — they must not outrank the exact hit.
  const fuzzy = await eloFindProjectFolder(client, { projectName: projectNumber }, projectFolderOptions);
  console.log(`       fuzzy lookup for the same string: ${fuzzy.returned} hit(s), mode=${fuzzy.matchMode}`);
  check(
    'fuzzy results are labelled as fuzzy, never as exact',
    fuzzy.results.every((r) => r.matchType === 'fuzzy') || fuzzy.matchMode === 'exact',
  );
  check('note warns when several candidates remain', fuzzy.returned <= 1 || fuzzy.note.length > 0);

  // --- elo_list_folder -----------------------------------------------------
  section('elo_list_folder — the "which reports exist" use case');
  const listing = await eloListFolder(client, { folderId: root.objId }, listingOptions);
  check('folder has children', listing.returned > 0, `returned ${listing.returned}`);
  check('every child carries a path', listing.results.every((r) => Boolean(r.path)));
  check('every child carries an eloLink', listing.results.every((r) => Boolean(r.eloLink)));
  check(
    'the folder does not list itself',
    listing.results.every((r) => r.objId !== root.objId),
  );
  check('note mentions the depth limitation', listing.note.includes('Direct children'));
  for (const r of listing.results.slice(0, 3)) {
    console.log(`       ${r.type === 'folder' ? 'FOLDER' : 'DOC   '} "${r.name}"`);
  }

  const deep = await eloListFolder(client, { folderId: root.objId, depth: 3 }, listingOptions);
  check('depth 3 returns at least as much as depth 1', deep.returned >= listing.returned);

  // --- elo_search scoping — the "wrong project" regression ------------------
  section('elo_search — scoping cannot leak other projects');
  const scoped = await eloSearch(
    client,
    { query: 'e', parentId: root.objId, depth: 5, maxResults: 50 },
    listingOptions,
  );
  check('engine switched to the scoped index engine', scoped.engine === 'index');
  check('scope is echoed back', scoped.scope?.parentId === root.objId);
  check(
    'EVERY hit sits inside the project folder',
    scoped.results.every((r) => r.path?.includes(root.name) || r.parentId === root.objId),
    scoped.results
      .filter((r) => !r.path?.includes(root.name) && r.parentId !== root.objId)
      .map((r) => `${r.name} @ ${r.path}`)
      .join('; '),
  );
  check(
    'note states that content was not searched',
    scoped.note.includes('content') && scoped.note.includes('not searched'),
  );
  console.log(`       ${scoped.returned} hit(s) inside "${root.name}"`);

  const unscoped = await eloSearch(client, { query: 'Bericht', maxResults: 5 }, listingOptions);
  check('unscoped search uses the full-text engine', unscoped.engine === 'esearch');
  check('unscoped hits carry paths', unscoped.results.every((r) => Boolean(r.path)));
  check(
    'truncated is a boolean, always present',
    typeof unscoped.truncated === 'boolean',
  );
  check(
    'truncated results say so in the note',
    !unscoped.truncated || unscoped.note.includes('NOT complete'),
  );

  // --- Link consistency — the "keine Konsistenz" regression -----------------
  section('Link consistency across tools');
  const doc =
    unscoped.results.find((r) => r.type === 'document') ??
    deep.results.find((r) => r.type === 'document');
  if (!doc) {
    check('found a document to cross-check', false, 'no document in either result set');
  } else {
    console.log(`       object ${doc.objId} "${doc.name}"`);
    const viaLink = await eloGetDocumentLink(client, { objId: doc.objId }, listingOptions);
    const viaMeta = await eloGetMetadata(client, { objId: doc.objId }, listingOptions);
    check(
      'search link === elo_get_document_link link',
      doc.eloLink === viaLink.eloLink,
      `${doc.eloLink}\n       ${viaLink.eloLink}`,
    );
    check(
      'search link === elo_get_metadata link',
      doc.eloLink === viaMeta.eloLink,
      `${doc.eloLink}\n       ${viaMeta.eloLink}`,
    );
    check('metadata reports the same path', viaMeta.path === doc.path, `${viaMeta.path} vs ${doc.path}`);
    check('link tool reports the same path', viaLink.path === doc.path, `${viaLink.path} vs ${doc.path}`);
    check('link tool resolves the object name', viaLink.name === doc.name, `"${viaLink.name}" vs "${doc.name}"`);
    check('metadata returns index fields', Object.keys(viaMeta.indexFields).length > 0);
    check('metadata resolves the change date (XDateIso fix)', Boolean(viaMeta.xDateIso));
    check(
      'download URL, if present, is anchored on ELO_BASE_URL',
      !viaLink.downloadUrl || viaLink.downloadUrl.startsWith(new URL(cfg.ELO_BASE_URL).origin),
      viaLink.downloadUrl ?? '(none)',
    );
  }

  // --- elo_get_document_content — the "kein Volltext" regression -----------
  section('elo_get_document_content — reading PDF and Word text');

  // Find a real PDF and a real DOCX by extension rather than by guessing at
  // names; the archive's contentType is often application/octet-stream.
  const { readable, oversize } = await findReadableDocuments();
  check('found at least one PDF or Word document', readable.length > 0);

  for (const target of readable) {
    console.log(`       ${target.ext} ${target.objId} "${target.name}"`);
    const content = await eloGetDocumentContent(client, { objId: target.objId }, contentOptions);

    check(`${target.ext}: extractor matches the file type`, content.extractor === target.ext.toLowerCase());
    check(`${target.ext}: eloLink present`, content.eloLink.startsWith(cfg.ELO_WEBCLIENT_URL));
    check(`${target.ext}: path present`, Boolean(content.path));
    check(`${target.ext}: reports how the bytes were obtained`, content.contentSource === 'stream' || content.contentSource === 'inline');
    check(`${target.ext}: totalCharCount is consistent`, content.totalCharCount >= content.charCount);
    check(
      `${target.ext}: truncation is self-describing`,
      !content.truncated || (typeof content.nextOffset === 'number' && (content.notice ?? '').includes('offset')),
    );
    if (content.textLayer === 'none') {
      check(`${target.ext}: empty text is explained, not silent`, Boolean(content.notice));
      console.log(`       -> no text layer: ${content.notice?.slice(0, 90)}`);
    } else {
      check(`${target.ext}: returned actual text`, content.text.trim().length > 0);
      console.log(
        `       -> ${content.totalCharCount} chars${content.pageCount ? `, ${content.pageCount} pages` : ''}: ${JSON.stringify(content.text.slice(0, 70))}`,
      );
    }

    // Paging must be exact — an off-by-one here silently drops or repeats text.
    if (content.totalCharCount > 200) {
      const head = await eloGetDocumentContent(
        client,
        { objId: target.objId, maxChars: 500 },
        contentOptions,
      );
      check(`${target.ext}: honours maxChars`, head.charCount <= 500);
      check(`${target.ext}: short read reports truncation`, head.truncated === true);
      const tail = await eloGetDocumentContent(
        client,
        { objId: target.objId, maxChars: 500, offset: head.nextOffset! },
        contentOptions,
      );
      check(`${target.ext}: continued read starts where the first ended`, tail.offset === head.nextOffset);
      check(`${target.ext}: continued read returns different text`, tail.text !== head.text);
    }
  }

  // Error paths must stay actionable rather than leaking a parser stack trace.
  section('elo_get_document_content — error handling');

  if (oversize) {
    console.log(`       oversize sample: ${Math.round(oversize.sizeBytes / 1024 / 1024)} MB "${oversize.name}"`);
    try {
      await eloGetDocumentContent(client, { objId: oversize.objId }, contentOptions);
      check('document over the size cap is rejected', false, 'no error thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(
        'document over the size cap is rejected with the size limit named',
        /size limit/i.test(msg),
        msg,
      );
      check('size-cap error still carries the eloLink', msg.includes(cfg.ELO_WEBCLIENT_URL), msg);
    }
  } else {
    console.log('       (no document over the size cap in the sample; skipping that check)');
  }
  try {
    await eloGetDocumentContent(client, { objId: root.objId }, contentOptions);
    check('folder objId is rejected with a helpful message', false, 'no error thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check('folder objId is rejected with a helpful message', msg.includes('folder') && msg.includes('elo_list_folder'), msg);
  }

  try {
    await eloGetDocumentContent(client, { objId: '999999999' }, contentOptions);
    check('unknown objId is rejected', false, 'no error thrown');
  } catch {
    check('unknown objId is rejected', true);
  }

  finish();
}

/**
 * Find one real PDF and one real DOCX.
 *
 * ELO object names carry no file extension, so the type is only visible on the
 * checked-out document version (`docVersion.ext`, lowercase). We therefore scan
 * a broad result set rather than searching by extension.
 */
async function findReadableDocuments(): Promise<{
  readable: Array<{ objId: string; name: string; ext: string }>;
  oversize?: { objId: string; name: string; sizeBytes: number };
}> {
  const wanted = new Set(['pdf', 'docx']);
  const readable: Array<{ objId: string; name: string; ext: string }> = [];
  let oversize: { objId: string; name: string; sizeBytes: number } | undefined;
  const seenExts = new Set<string>();

  const broad = await runFind(
    client,
    {
      findByESearch: {
        searchOptions: {},
        searchParams: { query: process.env.PROBE_QUERY ?? 'Bericht', searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS' },
      },
    },
    { max: 40 },
  );

  for (const sord of broad.sords.filter((s) => !isFolder(s.type)).slice(0, 30)) {
    if (wanted.size === 0 && oversize) break;
    const meta = await eloGetMetadata(client, { objId: sord.id }, listingOptions);
    const ext = meta.docVersion?.ext?.toLowerCase();
    if (!ext) continue;
    seenExts.add(ext);

    const size = meta.docVersion?.sizeBytes ?? 0;
    // Keep one oversized document aside — the size-cap path deserves a real
    // test, and it is the one error path a large archive will hit in practice.
    if (!oversize && size > cfg.ELO_MAX_DOCUMENT_BYTES) {
      oversize = { objId: sord.id, name: sord.name, sizeBytes: size };
      continue;
    }
    if (wanted.has(ext) && size <= cfg.ELO_MAX_DOCUMENT_BYTES) {
      wanted.delete(ext);
      readable.push({ objId: sord.id, name: sord.name, ext });
    }
  }

  if (readable.length === 0) {
    console.log(`       (no PDF/DOCX under the size cap; saw: ${[...seenExts].join(', ') || 'nothing'})`);
  }
  return { readable, oversize };
}

function finish(): never {
  console.log(
    failures === 0 ? `\nAll ${checks} live checks passed.` : `\n${failures} of ${checks} live checks FAILED.`,
  );
  // Set the code and let Node drain naturally. Calling process.exit() here
  // trips a libuv handle assertion under tsx on Windows, which turns a passing
  // run into exit code 255.
  process.exitCode = failures === 0 ? 0 : 1;
  throw new StopSignal();
}

/** Unwinds out of main() without killing the process mid-teardown. */
class StopSignal extends Error {}

main().catch((err) => {
  if (err instanceof StopSignal) return;
  console.error('\nLive test crashed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
