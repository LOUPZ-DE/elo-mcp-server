// Read-only reconnaissance against the live ELO IX instance.
//
// BUGFIXES.md documents four cases where the schema said X and the runtime did
// Y (#6, #9, #11, #12). Before building folder listing, exact index lookup or
// document download on top of assumptions, we ask the instance directly.
//
// Usage:
//   npm run probe                      # full battery, prints a report
//   npm run probe -- <method> <json>   # ad-hoc: POST one IX method, dump JSON
//
// Never prints index-field values, document content or credentials — only
// shapes, key names, types and lengths. Folder/document *names* and paths are
// printed because verifying them is the whole point.

import { loadConfig } from '../src/utils/config.js';
import { EloClient } from '../src/elo/client.js';
import { SORD_Z_ALL, EDIT_INFO_Z_ALL, DOC_VERSION_Z_ALL, LOCK_Z_NO, isFolder } from '../src/elo/constants.js';

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

/** Query used to obtain sample objects. Override with PROBE_QUERY. */
const QUERY = process.env.PROBE_QUERY ?? 'Projekt';
/** Project number used for the findByIndex probe. Override with PROBE_PRJ_NO. */
const PRJ_NO = process.env.PROBE_PRJ_NO ?? '';

function hr(title: string): void {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function ok(label: string, value: unknown): void {
  console.log(`  [OK]   ${label}: ${value}`);
}
function no(label: string, value: unknown): void {
  console.log(`  [--]   ${label}: ${value}`);
}
function err(label: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`  [FAIL] ${label}: ${msg.slice(0, 300)}`);
}

/** Describe an object's shape without leaking values. */
function shape(obj: unknown, depth = 0): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (Array.isArray(obj)) {
    return depth === 0 && obj.length > 0
      ? `array(${obj.length}) of ${shape(obj[0], depth + 1)}`
      : `array(${obj.length})`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as object);
    return depth >= 1 ? `{${keys.join(', ')}}` : `{\n    ${keys.join('\n    ')}\n  }`;
  }
  if (typeof obj === 'string') return `string(len=${obj.length})`;
  return typeof obj;
}

async function find(findInfo: unknown, max = 5): Promise<any> {
  return client.request<any>('/rest/IXServicePortIF/findFirstSords', {
    findInfo,
    max,
    sordZ: SORD_Z_ALL,
  });
}

// ---------------------------------------------------------------------------

async function adHoc(method: string, bodyJson: string): Promise<void> {
  const body = bodyJson ? JSON.parse(bodyJson) : {};
  const res = await client.request<unknown>(`/rest/IXServicePortIF/${method}`, body);
  console.log(JSON.stringify(res, null, 2));
}

async function battery(): Promise<void> {
  hr('Login');
  await client.login();
  ok('login', 'successful');
  ok('ELO_BASE_URL', cfg.ELO_BASE_URL);
  ok('ELO_WEBCLIENT_URL', cfg.ELO_WEBCLIENT_URL);

  // -------------------------------------------------------------------------
  hr(`Sample objects via findByESearch (query="${QUERY}")`);
  let sampleDoc: any = null;
  let sampleFolder: any = null;
  let findResult: any = null;

  try {
    const res = await find(
      {
        findByESearch: {
          searchOptions: {},
          searchParams: { query: QUERY, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS' },
        },
      },
      25,
    );
    findResult = res.result;
    const sords: any[] = findResult?.sords ?? [];
    ok('sords returned', sords.length);

    // --- P7: is moreResults actually populated? -----------------------------
    hr('P7 — FindResult.moreResults / searchId');
    ok('result keys', Object.keys(findResult ?? {}).join(', '));
    if ('moreResults' in (findResult ?? {})) {
      ok('moreResults', `${findResult.moreResults} (${typeof findResult.moreResults})`);
    } else {
      no('moreResults', 'ABSENT — derive truncation from returned === max');
    }
    if (findResult?.searchId) {
      ok('searchId', `present (len=${String(findResult.searchId).length})`);
    } else {
      no('searchId', 'absent');
    }

    sampleDoc = sords.find((s) => !isFolder(s.type)) ?? null;
    // Prefer a folder that actually has children — otherwise the findChildren
    // probe reports "0 children" and we cannot tell "filter works" from
    // "filter ignored".
    sampleFolder =
      sords.find((s) => isFolder(s.type) && Number(s.childCount) > 0) ??
      sords.find((s) => isFolder(s.type)) ??
      null;
    if (sampleFolder) {
      ok('sample folder', `id=${sampleFolder.id} childCount=${sampleFolder.childCount} "${sampleFolder.name}"`);
    }

    // --- P1 / P2: sord shape, parentId, refPaths ----------------------------
    hr('P1/P2 — Sord shape, parentId, refPaths');
    const sample = sampleFolder ?? sampleDoc ?? sords[0];
    if (!sample) {
      no('sample', 'no sords returned — try a different PROBE_QUERY');
    } else {
      console.log(`  sample: id=${sample.id} type=${sample.type} name="${sample.name}"`);
      console.log(`  sord keys: ${shape(sample)}`);

      if ('parentId' in sample) {
        ok('P1 Sord.parentId', `${sample.parentId} (${typeof sample.parentId})`);
      } else {
        no('P1 Sord.parentId', 'ABSENT — must fall back to refPaths[0].path.at(-1).id');
      }
      ok('Sord.desc present', 'desc' in sample);
      ok('Sord.deleted present', 'deleted' in sample);

      const rp = sample.refPaths;
      if (!Array.isArray(rp) || rp.length === 0) {
        no('refPaths', 'absent/empty');
      } else {
        ok('refPaths', `array(${rp.length}), entry keys ${shape(rp[0], 1)}`);
        const path = rp[0]?.path ?? [];
        ok('refPaths[0].path', `array(${path.length}), item keys ${shape(path[0], 1)}`);
        console.log(`  path names: ${path.map((p: any) => p.name).join(' / ')}`);
        console.log(`  path ids:   ${path.map((p: any) => p.id).join(' / ')}`);
        const last = path[path.length - 1];
        if (last && String(last.id) === String(sample.id)) {
          no('P2', 'path INCLUDES the object itself as last element — strip it for parentId');
        } else {
          ok('P2', `path EXCLUDES the object itself — parentId = path.at(-1).id = ${last?.id}`);
        }
        if (rp[0]?.pathAsString) {
          ok('pathAsString', `present, separator visible: ${JSON.stringify(String(rp[0].pathAsString).slice(0, 60))}`);
        }
      }
    }
  } catch (e) {
    err('findByESearch', e);
  }

  // --- P8: findClose --------------------------------------------------------
  hr('P8 — findClose');
  if (findResult?.searchId) {
    for (const body of [{ searchId: findResult.searchId }, { id: findResult.searchId }]) {
      try {
        await client.request('/rest/IXServicePortIF/findClose', body);
        ok('findClose', `accepted with body key "${Object.keys(body)[0]}"`);
        break;
      } catch (e) {
        err(`findClose {${Object.keys(body)[0]}}`, e);
      }
    }
  } else {
    no('findClose', 'no searchId to close');
  }

  // --- Discover a real project folder (used as the scope target below) ------
  hr('Discovery — a project folder with children');
  let prjNo = PRJ_NO;
  let projectFolder: any = null;
  try {
    const res = await find({ findByIndex: { objKeys: [{ name: 'SOL_TYPE', data: ['PROJEKT'] }] } }, 25);
    const cands: any[] = (res.result?.sords ?? []).filter((s: any) => isFolder(s.type));
    ok('SOL_TYPE=PROJEKT lookup', `${cands.length} project folders`);
    projectFolder =
      cands.find(
        (s) =>
          Number(s.childCount) > 0 &&
          s.objKeys?.find((k: any) => k.name === cfg.ELO_PROJECT_NUMBER_FIELD)?.data?.[0],
      ) ??
      cands.find((s) => Number(s.childCount) > 0) ??
      cands[0] ??
      null;
    if (projectFolder) {
      const n = projectFolder.objKeys?.find((k: any) => k.name === cfg.ELO_PROJECT_NUMBER_FIELD)?.data?.[0];
      if (!prjNo && n) prjNo = n;
      ok(
        'project folder',
        `id=${projectFolder.id} childCount=${projectFolder.childCount} ${cfg.ELO_PROJECT_NUMBER_FIELD}="${n ?? '-'}" "${projectFolder.name}"`,
      );
    }
  } catch (e) {
    err('SOL_TYPE=PROJEKT lookup', e);
  }

  /** Folder used for all scoping probes — prefer one that really has children. */
  const scopeFolder = Number(projectFolder?.childCount) > 0 ? projectFolder : (sampleFolder ?? projectFolder);
  const scopePath = (scopeFolder?.refPaths?.[0]?.path ?? []).map((p: any) => p.name).join('/');

  /** True when the sord sits inside scopeFolder — any refPath crossing its id. */
  const inScope = (s: any): boolean => {
    if (!scopeFolder) return false;
    if (String(s.id) === String(scopeFolder.id)) return true;
    return (s.refPaths ?? []).some((rp: any) =>
      (rp.path ?? []).some((p: any) => String(p.id) === String(scopeFolder.id)),
    );
  };

  // --- P3: findChildren -----------------------------------------------------
  hr('P3 — findChildren (folder listing)');
  if (!scopeFolder) {
    no('findChildren', 'no folder available');
  } else {
    console.log(`  parent: id=${scopeFolder.id} childCount=${scopeFolder.childCount} name="${scopeFolder.name}"`);
    const variants: Array<[string, unknown]> = [
      ['findChildren{parentId,endLevel:1,mainParent:true}', { findChildren: { parentId: scopeFolder.id, endLevel: 1, mainParent: true } }],
      ['findChildren{parentId,endLevel:1}', { findChildren: { parentId: scopeFolder.id, endLevel: 1 } }],
      ['findChildren{parentId,endLevel:0}', { findChildren: { parentId: scopeFolder.id, endLevel: 0 } }],
      ['findChildren{parentId}', { findChildren: { parentId: scopeFolder.id } }],
      ['findByParent{parentId}', { findByParent: { parentId: scopeFolder.id } }],
    ];
    for (const [label, findInfo] of variants) {
      try {
        const res = await find(findInfo, 20);
        const sords: any[] = res.result?.sords ?? [];
        ok(label, `${sords.length} children (parent childCount=${scopeFolder.childCount})`);
        for (const s of sords.slice(0, 3)) {
          const p = (s.refPaths?.[0]?.path ?? []).map((x: any) => x.name).join('/');
          console.log(`         ${isFolder(s.type) ? 'FOLDER' : 'DOC   '} "${s.name}" @ /${p}`);
        }
      } catch (e) {
        err(label, e);
      }
    }
  }

  // --- P11: endLevel depth semantics ---------------------------------------
  hr('P11 — findChildren endLevel depth + scoped name filter');
  if (!scopeFolder) {
    no('depth', 'no folder');
  } else {
    for (const lvl of [1, 2, 3, 0]) {
      try {
        const res = await find({ findChildren: { parentId: scopeFolder.id, endLevel: lvl } }, 200);
        const sords: any[] = res.result?.sords ?? [];
        const depths = new Set(sords.map((s) => (s.refPaths?.[0]?.path ?? []).length));
        ok(`endLevel:${lvl}`, `${sords.length} hits, distinct path depths: ${[...depths].sort().join(',')}`);
      } catch (e) {
        err(`endLevel:${lvl}`, e);
      }
    }
    // The real use case: "the monthly reports inside project X".
    try {
      const res = await find(
        { findChildren: { parentId: scopeFolder.id, endLevel: 3 }, findByIndex: { name: '*Rechnung*' } },
        50,
      );
      const sords: any[] = res.result?.sords ?? [];
      ok('scoped name filter (endLevel:3, name=*Rechnung*)', `${sords.length} hits, ${sords.filter((s) => !inScope(s)).length} outside`);
      for (const s of sords.slice(0, 3)) {
        console.log(`         "${s.name}" @ /${(s.refPaths?.[0]?.path ?? []).map((x: any) => x.name).join('/')}`);
      }
    } catch (e) {
      err('scoped name filter', e);
    }
  }

  // --- P6: findByIndex ------------------------------------------------------
  hr(`P6 — findByIndex exact match on ${cfg.ELO_PROJECT_NUMBER_FIELD}`);
  if (!prjNo) {
    no('findByIndex', 'no project number discovered; set PROBE_PRJ_NO=<number>');
  } else {
    const PRJ_NO = prjNo;
    const variants: Array<[string, unknown]> = [
      [
        `objKeys[{name:${cfg.ELO_PROJECT_NUMBER_FIELD}}] exact`,
        { findByIndex: { objKeys: [{ name: cfg.ELO_PROJECT_NUMBER_FIELD, data: [PRJ_NO] }] } },
      ],
      [
        `objKeys[{name:${cfg.ELO_PROJECT_NUMBER_FIELD}}] wildcard`,
        { findByIndex: { objKeys: [{ name: cfg.ELO_PROJECT_NUMBER_FIELD, data: [`${PRJ_NO}*`] }] } },
      ],
      ['findByIndex{name:"*"} title wildcard', { findByIndex: { name: `*${PRJ_NO}*` } }],
    ];
    for (const [label, findInfo] of variants) {
      try {
        const res = await find(findInfo, 10);
        const sords: any[] = res.result?.sords ?? [];
        ok(label, `${sords.length} hits`);
        for (const s of sords.slice(0, 3)) {
          const marker = s.objKeys?.find((k: any) => k.name === 'SOL_TYPE')?.data?.[0];
          console.log(`         ${isFolder(s.type) ? 'FOLDER' : 'DOC   '} id=${s.id} "${s.name}" SOL_TYPE=${marker ?? '-'}`);
        }
      } catch (e) {
        err(label, e);
      }
    }
  }

  // --- P4: findChildren + findByIndex combined ------------------------------
  hr('P4 — findChildren AND findByIndex in one findInfo');
  if (!scopeFolder) {
    no('combined', 'no folder');
  } else {
    try {
      const res = await find(
        { findChildren: { parentId: scopeFolder.id, endLevel: 1 }, findByIndex: { name: '*e*' } },
        20,
      );
      const sords: any[] = res.result?.sords ?? [];
      const outside = sords.filter((s) => !inScope(s));
      ok('findChildren+findByIndex', `${sords.length} hits, ${outside.length} OUTSIDE the parent`);
      console.log(`         ${outside.length === 0 ? 'scoping HELD' : 'scoping IGNORED — findByIndex overrode findChildren'}`);
    } catch (e) {
      err('findChildren+findByIndex', e);
    }
  }

  // --- P5: can fulltext search be scoped to a subtree? ----------------------
  hr('P5 — scoping findByESearch to a folder subtree');
  if (!scopeFolder) {
    no('scoped esearch', 'no folder');
  } else {
    console.log(`  scope: id=${scopeFolder.id} /${scopePath}`);
    const variants: Array<[string, unknown]> = [
      [
        'esearch + findChildren',
        {
          findByESearch: { searchOptions: {}, searchParams: { query: QUERY, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS' } },
          findChildren: { parentId: scopeFolder.id, endLevel: 0 },
        },
      ],
      [
        'searchParams.parentId',
        { findByESearch: { searchOptions: {}, searchParams: { query: QUERY, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS', parentId: scopeFolder.id } } },
      ],
      [
        'searchOptions.parentId',
        { findByESearch: { searchOptions: { parentId: scopeFolder.id }, searchParams: { query: QUERY, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS' } } },
      ],
      [
        'searchParams.pathId',
        { findByESearch: { searchOptions: {}, searchParams: { query: QUERY, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS', pathId: scopeFolder.id } } },
      ],
    ];
    for (const [label, findInfo] of variants) {
      try {
        const res = await find(findInfo, 20);
        const sords: any[] = res.result?.sords ?? [];
        const outside = sords.filter((s) => !inScope(s));
        const verdict = sords.length === 0 ? 'no hits (inconclusive)' : outside.length === 0 ? 'SCOPING HELD' : `SCOPING IGNORED (${outside.length}/${sords.length} outside)`;
        ok(label, `${sords.length} hits — ${verdict}`);
        for (const s of sords.slice(0, 2)) {
          const p = (s.refPaths?.[0]?.path ?? []).map((x: any) => x.name).join('/');
          console.log(`         "${s.name}" @ /${p}`);
        }
      } catch (e) {
        err(label, e);
      }
    }
  }

  // --- P10: checkoutDoc / document content ----------------------------------
  hr('P10 — checkoutDoc: inline base64 vs stream URL');
  if (!sampleDoc) {
    no('checkoutDoc', 'no sample document available');
  } else {
    console.log(`  document: id=${sampleDoc.id} name="${sampleDoc.name}"`);
    try {
      const res = await client.request<any>('/rest/IXServicePortIF/checkoutDoc', {
        objId: sampleDoc.id,
        editInfoZ: EDIT_INFO_Z_ALL,
        docVersionZ: DOC_VERSION_Z_ALL,
        lockZ: LOCK_Z_NO,
      });
      const editInfo = res.result;
      ok('EditInfo keys', Object.keys(editInfo ?? {}).join(', '));
      const docs = editInfo?.document?.docs ?? [];
      ok('document.docs', `array(${docs.length})`);
      const d0 = docs[0];
      if (!d0) {
        no('docs[0]', 'absent');
      } else {
        ok('docs[0] keys', Object.keys(d0).join(', '));
        ok('contentType', d0.contentType ?? '-');
        ok('ext', d0.ext ?? '-');
        ok('size', d0.size ?? '-');
        // docs[0].url / previewUrl may be a *web-viewable* route — relevant
        // because the short link resolves to elodms:// (desktop client only).
        for (const f of ['url', 'previewUrl', 'physPath'] as const) {
          if (d0[f]) {
            try {
              const p = new URL(String(d0[f]), cfg.ELO_BASE_URL);
              ok(`docs[0].${f}`, `${p.protocol}//${p.host}${p.pathname}${p.search ? ' ?<query>' : ''}`);
            } catch {
              ok(`docs[0].${f}`, `non-URL: ${String(d0[f]).slice(0, 80)}`);
            }
          } else {
            no(`docs[0].${f}`, 'absent/empty');
          }
        }
        const fd = d0.fileData;
        if (!fd) {
          no('fileData', 'absent');
        } else {
          ok('fileData keys', Object.keys(fd).join(', '));
          if (typeof fd.data === 'string' && fd.data.length > 0) {
            ok('P10 inline base64 (fileData.data)', `PRESENT, base64 len=${fd.data.length} (~${Math.round((fd.data.length * 3) / 4 / 1024)} KB) — every checkoutDoc call is hauling this!`);
          } else {
            no('P10 inline base64 (fileData.data)', 'absent — download must use the stream URL');
          }
          if (fd.stream) {
            ok('fileData.stream keys', Object.keys(fd.stream).join(', '));
            const u = fd.stream.url;
            if (u) {
              try {
                const parsed = new URL(u, cfg.ELO_BASE_URL);
                const baseHost = new URL(cfg.ELO_BASE_URL).host;
                ok('stream.url absolute?', /^https?:\/\//i.test(u));
                ok('stream.url host', parsed.host);
                ok('stream.url path', parsed.pathname);
                ok('stream.url has query', parsed.search.length > 0);
                if (parsed.host !== baseHost) {
                  no('SAME-ORIGIN', `stream host ${parsed.host} != base host ${baseHost} — likely unreachable from the container, must re-anchor`);
                } else {
                  ok('SAME-ORIGIN', 'stream URL is on the same host as ELO_BASE_URL');
                }
              } catch {
                no('stream.url', 'unparseable');
              }
            }
          }
        }
      }
    } catch (e) {
      err('checkoutDoc', e);
    }
  }

  // --- P9: does the short link resolve for a FOLDER id? ---------------------
  hr('P9 — elo-link short service for folder vs document IDs');
  const webBase = cfg.ELO_WEBCLIENT_URL.replace(/\/$/, '');
  for (const [label, s] of [
    ['DOCUMENT', sampleDoc],
    ['FOLDER', sampleFolder],
  ] as Array<[string, any]>) {
    if (!s) {
      no(label, 'no sample');
      continue;
    }
    const url = `${webBase}/${s.id}?title=${encodeURIComponent(s.name)}`;
    try {
      const res = await fetch(url, { redirect: 'manual' });
      const loc = res.headers.get('location');
      const verdict = res.status >= 300 && res.status < 400 ? 'redirect' : res.status === 200 ? '200 OK' : `status ${res.status}`;
      ok(`${label} link`, `${verdict}${loc ? ` -> ${loc.slice(0, 120)}` : ''}`);
      console.log(`         ${url}`);
    } catch (e) {
      err(`${label} link`, e);
    }
  }

  hr('Done');
  console.log('Review the [--] and [FAIL] lines above — those drive the implementation choices.\n');
}

async function main() {
  const [method, body] = process.argv.slice(2);
  try {
    if (method) {
      await adHoc(method, body ?? '{}');
    } else {
      await battery();
    }
  } catch (e) {
    console.error('\nProbe failed:', e instanceof Error ? e.message : e);
    // process.exit() here trips a libuv handle assertion under tsx on Windows;
    // setting the code and letting Node drain avoids the false failure.
    process.exitCode = 1;
  }
}

main();
