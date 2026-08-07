import axios from 'axios';
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

/**
 * Does `runAsUser` actually work, and do permissions really change?
 *
 * The OpenAPI spec proves the parameter exists. It does not prove the technical
 * account may use it (ELO ties that to an administrator right), and an accepted
 * login alone does not prove the session really runs under the other identity.
 * So this compares an identical search across both sessions — only a difference
 * in what comes back is evidence.
 */
async function runAsProbe(targetUser: string): Promise<void> {
  hr(`runAsUser — Verifikation für "${targetUser}"`);

  // --- 1. Baseline: the technical user -------------------------------------
  await client.login();
  ok('Login technischer User', 'erfolgreich');

  let baselineSession = '(nicht abrufbar)';
  try {
    const info = await client.request<any>('/rest/IXServicePortIF/getSessionInfos', {});
    baselineSession = describeSession(info);
    ok('Sitzung läuft als', baselineSession);
  } catch (e) {
    err('getSessionInfos (technischer User)', e);
  }

  // --- 2. The actual question ----------------------------------------------
  hr('Wird runAsUser akzeptiert?');
  const asUser = new EloClient({
    baseUrl: cfg.ELO_BASE_URL,
    username: cfg.ELO_USERNAME,
    password: cfg.ELO_PASSWORD,
    basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
    basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
    language: cfg.ELO_LANGUAGE,
    country: cfg.ELO_COUNTRY,
    timeZone: cfg.ELO_TIMEZONE,
    runAsUser: targetUser,
  });

  try {
    await asUser.login();
    ok('runAsUser', 'AKZEPTIERT — der technische User darf sich als anderer Benutzer anmelden');
  } catch (e) {
    err('runAsUser', e);
    // IX collapses "you may not do this" and "no such user" onto the same
    // generic 3008. Without separating them the result is not actionable.
    await diagnoseRunAsFailure(targetUser);
    return;
  }

  try {
    const info = await asUser.request<any>('/rest/IXServicePortIF/getSessionInfos', {});
    const asSession = describeSession(info);
    ok('Sitzung läuft als', asSession);
    if (asSession === baselineSession) {
      no('WARNUNG', 'beide Sitzungen melden denselben Benutzer — runAsUser wirkt womöglich nicht');
    } else {
      ok('Identitätswechsel', `${baselineSession} → ${asSession}`);
    }
  } catch (e) {
    err('getSessionInfos (runAsUser)', e);
  }

  // --- 3. Do permissions actually differ? ----------------------------------
  hr('Wirken die Berechtigungen? (identische Suche, beide Sitzungen)');
  const query = process.env.PROBE_QUERY ?? 'Bericht';
  const findInfo = {
    findByESearch: {
      searchOptions: {},
      searchParams: { query, searchIn: 'TITLE,FULLTEXT,INDEX_FIELDS' },
    },
  };

  const collect = async (c: EloClient, label: string) => {
    const res = await c.request<any>('/rest/IXServicePortIF/findFirstSords', {
      findInfo,
      max: 200,
      sordZ: SORD_Z_ALL,
    });
    const sords: any[] = res.result?.sords ?? [];
    const ids = new Set(sords.map((s) => String(s.id)));
    const paths = sords.map((s) => (s.refPaths?.[0]?.path ?? []).map((p: any) => p.name).join('/'));
    const topLevel = new Set(paths.map((p) => p.split('/')[0]).filter(Boolean));
    ok(`${label}: Treffer`, `${sords.length} (geschätzt gesamt: ${res.result?.estimatedCount ?? '-'})`);
    console.log(`         Top-Level-Bereiche: ${[...topLevel].sort().join(', ') || '(keine)'}`);
    return { ids, topLevel, count: sords.length };
  };

  try {
    const base = await collect(client, 'technischer User');
    const impersonated = await collect(asUser, `als "${targetUser}"`);

    const onlyForTech = [...base.ids].filter((id) => !impersonated.ids.has(id));
    const onlyForUser = [...impersonated.ids].filter((id) => !base.ids.has(id));
    const areasLost = [...base.topLevel].filter((a) => !impersonated.topLevel.has(a));

    hr('Bewertung');
    if (onlyForTech.length === 0 && onlyForUser.length === 0) {
      no('Treffermengen', 'IDENTISCH — kein Nachweis, dass die Rechte wechseln');
      console.log('  Entweder hat das Testkonto dieselben Rechte wie der technische User,');
      console.log('  oder runAsUser wirkt nicht. Test mit einem bewusst eingeschränkten');
      console.log('  Konto wiederholen, sonst ist die Aussage wertlos.');
    } else {
      ok('Treffermengen unterscheiden sich', `${onlyForTech.length} nur für den technischen User sichtbar`);
      if (areasLost.length > 0) {
        ok('NACHWEIS', `Bereiche, die "${targetUser}" nicht sieht: ${areasLost.join(', ')}`);
      }
      if (onlyForUser.length > 0) {
        console.log(`  Hinweis: ${onlyForUser.length} Objekte sieht nur "${targetUser}" — plausibel bei persönlichen Ablagen.`);
      }
    }
  } catch (e) {
    err('Suchvergleich', e);
  }

  // --- 4. Mapping: does ELO know the AD account / e-mail? ------------------
  hr('Zuordnung: kennt ELO das Windows-Konto oder die E-Mail?');
  try {
    const res = await client.request<any>('/rest/IXServicePortIF/checkoutUser', {
      // The parameter is `id` (accepts name, id or GUID), not `userId`.
      id: targetUser,
      checkoutUsersZ: { bset: '-1' },
      lockZ: LOCK_Z_NO,
    });
    const user = res.result;
    if (!user) {
      no('checkoutUser', 'kein result');
    } else {
      ok('UserInfo-Felder', Object.keys(user).join(', '));
      const props: unknown[] = user.userProps ?? [];
      const filled = props
        .map((v, i) => ({ i, v: typeof v === 'string' ? v : '' }))
        .filter((e) => e.v.length > 0);
      ok('userProps', `${props.length} Felder, ${filled.length} belegt`);
      for (const e of filled) {
        // Report the *shape*, not the value — these are personal records.
        const shape = e.v.includes('@')
          ? 'E-MAIL-FORMAT'
          : /\\/.test(e.v)
            ? 'DOMAIN\\KONTO-FORMAT'
            : /^[A-Za-z][A-Za-z0-9._-]{2,20}$/.test(e.v)
              ? 'kurzes Konto-Format'
              : 'sonstiger Text';
        console.log(`         userProps[${e.i}] → ${shape} (${e.v.length} Zeichen)`);
      }
      if (filled.some((e) => e.v.includes('@') || /\\/.test(e.v))) {
        ok('ERGEBNIS', 'ELO kennt eine E-Mail bzw. ein AD-Konto → automatische Zuordnung möglich');
      } else {
        no('ERGEBNIS', 'kein E-Mail-/AD-Feld erkennbar → Zuordnungstabelle nötig');
      }
    }
  } catch (e) {
    err('checkoutUser', e);
  }

  hr('Fertig');
}

/**
 * Separate "the technical account may not impersonate" from "that identifier is
 * not what runAsUser expects". IX returns [ELOIX:3008] for both.
 */
async function diagnoseRunAsFailure(targetUser: string): Promise<void> {
  hr('Diagnose — fehlendes Recht oder falsche Kennung?');

  // A) Is the name a valid ELO user identifier at all?
  let userIdentifiers: string[] = [];
  try {
    // The parameter is `id` (name, id or GUID), not `userId`. And unlike SordZ,
    // CheckoutUsersC rejects bset '-1' — so try the plausible values rather
    // than assuming the SORD_Z_ALL convention carries over.
    const u = await checkoutUserAny(targetUser);
    if (u) {
      ok('checkoutUser', `"${targetUser}" ist ein gültiger ELO-Benutzer (id=${u.id})`);
      userIdentifiers = [u.name, String(u.id), u.guid].filter(Boolean);

      // ldapProperties is where an AD-synced installation keeps the directory
      // link — the difference between automatic identity mapping and a
      // hand-maintained table.
      const ldap = u.ldapProperties;
      if (ldap && (typeof ldap !== 'object' || Object.keys(ldap).length > 0)) {
        const asText = typeof ldap === 'string' ? ldap : JSON.stringify(ldap);
        ok('ldapProperties', `belegt (${asText.length} Zeichen)`);
        console.log(`         Muster: ${asText.replace(/[A-Za-zÄÖÜäöüß]/g, 'a').replace(/[0-9]/g, '9').slice(0, 120)}`);
        if (/@/.test(asText)) console.log('         enthält E-Mail-Format');
        if (/\\|CN=|DC=/i.test(asText)) console.log('         enthält AD-/LDAP-Kennung');
        for (const v of asText.match(/"([^"]{2,60})"/g) ?? []) {
          if (/@|\\|CN=|DC=/i.test(v)) userIdentifiers.push(v.replace(/"/g, ''));
        }
      } else {
        no('ldapProperties', 'leer — keine Verzeichnisverknüpfung an diesem Benutzer');
      }

      if (u.lastLoginIso) ok('letzter Login', String(u.lastLoginIso));
      if (typeof u.internalUser === 'boolean') ok('internalUser', String(u.internalUser));

      const props: unknown[] = u.userProps ?? [];
      const filled = props
        .map((v, i) => ({ i, v: typeof v === 'string' ? v : '' }))
        .filter((e) => e.v.length > 0);
      ok('userProps belegt', `${filled.length} von ${props.length}`);
      for (const e of filled) {
        const shape = e.v.includes('@')
          ? 'E-MAIL-FORMAT'
          : /\\/.test(e.v)
            ? 'DOMAIN\\KONTO-FORMAT'
            : /^[A-Za-z][A-Za-z0-9._-]{2,20}$/.test(e.v)
              ? 'kurzes Konto-Format'
              : 'sonstiger Text';
        console.log(`         userProps[${e.i}] → ${shape} (${e.v.length} Zeichen)`);
        if (shape !== 'sonstiger Text') userIdentifiers.push(e.v);
      }
    } else {
      no('checkoutUser', 'kein result — Name evtl. ungültig');
    }
  } catch (e) {
    err('checkoutUser', e);
  }

  // B) Self-impersonation. If the mechanism works at all, running as *yourself*
  //    must be permitted — so a failure here isolates the missing right.
  hr('Selbsttest: runAsUser = technischer User');
  const selfOk = await tryRunAs(cfg.ELO_USERNAME, 'technischer User (self)');
  if (selfOk) {
    ok('SCHLUSSFOLGERUNG', 'Mechanismus funktioniert — der Fehler lag an der Kennung, nicht am Recht');
  } else {
    no('SCHLUSSFOLGERUNG', 'auch der Selbsttest scheitert → dem technischen User fehlt das Recht');
  }

  // C) Try the other identifier forms ELO might expect.
  const alternatives = [...new Set(userIdentifiers)].filter((v) => v !== targetUser);
  if (alternatives.length > 0) {
    hr('Alternative Kennungen für denselben Benutzer');
    for (const alt of alternatives) {
      await tryRunAs(alt, `Kennung "${alt.length > 40 ? alt.slice(0, 40) + '…' : alt}"`);
    }
  }

  hr('Bewertung');
  console.log('  [ELOIX:3008] deckt in IX mehrere Ursachen ab. Wenn der Selbsttest oben');
  console.log('  ebenfalls scheitert, ist es das fehlende Recht — dann muss die ELO-');
  console.log('  Administration dem technischen Konto das Recht zum Anmelden als anderer');
  console.log('  Benutzer geben (üblicherweise Hauptadministrator). Erst danach erneut testen.');
}

/**
 * Try every login shape IX offers for acting as another user.
 *
 * `login` + `runAsUser` is refused even with FLAG_ADMIN directly assigned, so
 * the assumption that it is *the* impersonation mechanism needs testing rather
 * than repeating. Credentials come from the config, never the command line.
 */
async function loginVariants(target: string): Promise<void> {
  hr(`Anmeldevarianten für Impersonation von "${target}"`);

  const http = axios.create({
    baseURL: cfg.ELO_BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
  const basic =
    'Basic ' +
    Buffer.from(
      `${cfg.ELO_BASIC_AUTH_USER ?? cfg.ELO_USERNAME}:${cfg.ELO_BASIC_AUTH_PASS ?? cfg.ELO_PASSWORD}`,
    ).toString('base64');
  const ci = { language: cfg.ELO_LANGUAGE, country: cfg.ELO_COUNTRY, timeZone: cfg.ELO_TIMEZONE };
  const creds = { userName: cfg.ELO_USERNAME, userPwd: cfg.ELO_PASSWORD, clientComputer: 'MCP-Probe' };

  const variants: Array<[string, string, Record<string, unknown>]> = [
    ['login + runAsUser', 'login', { ci, ...creds, runAsUser: target }],
    ['loginAdmin + reportAsUser', 'loginAdmin', { ci, ...creds, reportAsUser: target }],
    ['loginAdmin ohne reportAsUser', 'loginAdmin', { ci, ...creds }],
    ['login ohne runAsUser (Referenz)', 'login', { ci, ...creds }],
  ];

  for (const [label, method, body] of variants) {
    try {
      const res = await http.post<any>(`/rest/IXServicePortIF/${method}`, body, {
        headers: { Authorization: basic },
      });
      const ex = res.data?.exception;
      if (ex) {
        const msg = typeof ex === 'string' ? ex : (ex.message ?? JSON.stringify(ex));
        no(label, msg.replace(/\[TICKET:[^\]]*\]/, '').slice(0, 110));
      } else {
        // Whose session did we actually get? That is the whole question.
        const user = res.data?.result?.user;
        const who = user?.name ?? '(kein user im Ergebnis)';
        ok(label, `AKZEPTIERT — Sitzung gehört zu: ${who}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(label, msg.slice(0, 110));
    }
  }

  hr('Lesart');
  console.log('  "login ohne runAsUser" muss gelingen — sonst stimmen die Zugangsdaten nicht.');
  console.log('  Gelingt eine Variante und nennt dabei den Zielbenutzer, ist das der Weg.');
  console.log('  Scheitern alle Impersonationsvarianten trotz gesetztem FLAG_ADMIN, ist die');
  console.log('  Funktion serverseitig nicht freigegeben — dann ist es eine Frage an ELO.');
}

/**
 * Side-by-side dump of the fields that decide whether an account can
 * authenticate at all. Built because a service account existed in the archive
 * (`checkoutUser` found it) yet was refused at login with the same generic
 * [ELOIX:3008] the client shows for an unknown user — which suggests ELO is
 * validating the password somewhere other than its own store.
 */
async function accountProbe(names: string[]): Promise<void> {
  hr(`Kontovergleich: ${names.join(' vs. ')}`);

  const fields = [
    'id',
    'name',
    'type',
    'flags',
    'flags2',
    'internalUser',
    'lastLoginIso',
    'superiorId',
    'parent',
  ] as const;

  const rows: Array<Record<string, string>> = [];
  for (const name of names) {
    const u = await checkoutUserAny(name);
    if (!u) {
      rows.push({ name: `${name} (nicht lesbar)` });
      continue;
    }
    const row: Record<string, string> = {};
    for (const f of fields) {
      const v = (u as any)[f];
      row[f] = v === undefined || v === null ? '—' : typeof v === 'object' ? '{…}' : String(v);
    }
    // Values are personal data; report presence and shape only.
    const ldap = (u as any).ldapProperties;
    const ldapText = ldap ? (typeof ldap === 'string' ? ldap : JSON.stringify(ldap)) : '';
    row.ldapProperties = ldapText.length > 0 ? `belegt (${ldapText.length} Zeichen)` : 'leer';
    const props: unknown[] = (u as any).userProps ?? [];
    const filled = props.filter((v) => typeof v === 'string' && v.length > 0).length;
    row.userProps = `${filled}/${props.length} belegt`;
    row.pwdGesetzt = (u as any).pwd ? 'ja' : 'nein/verborgen';
    rows.push(row);
  }

  const cols = ['id', 'type', 'flags', 'flags2', 'internalUser', 'lastLoginIso', 'ldapProperties', 'userProps', 'pwdGesetzt'];
  for (const c of cols) {
    const cells = rows.map((r, i) => `${names[i]}=${r[c] ?? '—'}`);
    const differs = new Set(rows.map((r) => r[c] ?? '—')).size > 1;
    console.log(`  ${differs ? '≠' : ' '} ${c.padEnd(16)} ${cells.join('   |   ')}`);
  }

  hr('Lesart');
  console.log('  Mit ≠ markierte Zeilen sind die Unterschiede. Kann sich das eine Konto');
  console.log('  anmelden und das andere nicht, steckt die Ursache mit hoher Wahrscheinlichkeit');
  console.log('  in genau einer davon — insbesondere internalUser und ldapProperties zeigen an,');
  console.log('  ob ELO das Passwort selbst prueft oder an das Verzeichnis delegiert.');
}

/**
 * `checkoutUser` with whichever CheckoutUsersC bitset this IX accepts.
 * Returns the UserInfo, or null when every variant is refused.
 */
async function checkoutUserAny(id: string): Promise<any | null> {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['ohne checkoutUsersZ', { id, lockZ: LOCK_Z_NO }],
    ['bset 0', { id, checkoutUsersZ: { bset: '0' }, lockZ: LOCK_Z_NO }],
    ['bset 1', { id, checkoutUsersZ: { bset: '1' }, lockZ: LOCK_Z_NO }],
    ['bset 3', { id, checkoutUsersZ: { bset: '3' }, lockZ: LOCK_Z_NO }],
    ['bset 255', { id, checkoutUsersZ: { bset: '255' }, lockZ: LOCK_Z_NO }],
  ];
  for (const [label, body] of variants) {
    try {
      const res = await client.request<any>('/rest/IXServicePortIF/checkoutUser', body);
      if (res.result) {
        ok('checkoutUser-Variante', label);
        return res.result;
      }
    } catch {
      /* try the next shape */
    }
  }
  no('checkoutUser', 'keine der Varianten akzeptiert');
  return null;
}

async function tryRunAs(name: string, label: string): Promise<boolean> {
  const c = new EloClient({
    baseUrl: cfg.ELO_BASE_URL,
    username: cfg.ELO_USERNAME,
    password: cfg.ELO_PASSWORD,
    basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
    basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
    language: cfg.ELO_LANGUAGE,
    country: cfg.ELO_COUNTRY,
    timeZone: cfg.ELO_TIMEZONE,
    runAsUser: name,
  });
  try {
    await c.login();
    ok(label, 'AKZEPTIERT');
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    no(label, msg.replace(/\[TICKET:[^\]]*\]/, '').slice(0, 120));
    return false;
  }
}

/**
 * `getSessionInfos` returns *all* active IX sessions, not the caller's own, so
 * it cannot identify "who am I". Report the scale instead of guessing a name.
 */
function describeSession(info: any): string {
  const r = info?.result;
  if (Array.isArray(r)) return `${r.length} aktive IX-Sitzungen insgesamt (serverweit)`;
  return `unerwartete Form: ${typeof r}`;
}

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
    if (method === '--runas') {
      const target = process.argv.slice(3).join(' ').trim();
      if (!target) {
        console.error('Bitte den ELO-Benutzernamen angeben, z. B.:');
        console.error('  npm run probe:runas -- "Vorname Nachname"');
        process.exitCode = 1;
        return;
      }
      await runAsProbe(target);
    } else if (method === '--variants') {
      const target = process.argv.slice(3).join(' ').trim();
      if (!target) {
        console.error('Bitte den Zielbenutzer angeben, z. B.:');
        console.error('  npm run probe:variants -- "Vorname Nachname"');
        process.exitCode = 1;
        return;
      }
      await loginVariants(target);
    } else if (method === '--accounts') {
      const names = process.argv.slice(3).filter(Boolean);
      if (names.length < 2) {
        console.error('Bitte mindestens zwei Kontonamen/IDs angeben, z. B.:');
        console.error('  npm run probe:accounts -- <Dienstkonto> Administrator');
        process.exitCode = 1;
        return;
      }
      await accountProbe(names);
    } else if (method) {
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

