# ELO MCP Server – Bugfix-Dokumentation

**Projekt:** elo-mcp-server
**Zeitraum:** 2026-05-18
**Status:** alle vier Tools (`elo_search`, `elo_get_metadata`, `elo_get_document_link`, `elo_find_project_folder`) gegen Loupz-Production verifiziert.

Dokumentiert sind die Bugs in der Reihenfolge, in der sie auftraten, jeweils mit Symptom, Ursache, Fix und ggf. Hinweis für die Zukunft.

---

## 1. `test:login` meldete „Login OK", obwohl der Login fehlschlug

**Symptom:** `npm run test:login` gab `Login OK` aus. `elo_search` lieferte trotzdem HTTP 401.

**Ursache:** ELO IX antwortet bei falschen Credentials mit HTTP **200** + Body `{ "exception": "[ELOIX:3008]Unbekannter Benutzer, falsches Passwort oder Konto gesperrt." }` und setzt **trotzdem** ein `JSESSIONID`-Cookie (anonyme Session). Der Client prüfte nur das Cookie, nicht das `exception`-Feld.

**Fix:** In `EloClient.login()` das `exception`-Feld auswerten und bei Vorhandensein eine sprechende Fehlermeldung werfen.

```ts
const exception = (response.data as { exception?: unknown })?.exception;
if (exception) {
  throw new Error(`ELO login rejected: ${msg}`);
}
```

**Lesson learned:** ELO IX gibt fast alle Fehler als HTTP 200 mit `exception`-Body zurück, nicht als 4xx. Statuscode allein reicht nicht.

---

## 2. Passwort wurde durch `.env`-Parsing verstümmelt

**Symptom:** Login mit korrekten Credentials schlug mit `[ELOIX:3008]` fehl. Web-Client- und Java-Client-Login funktionierten mit denselben Credentials.

**Ursache:** Das Passwort enthielt ein Sonderzeichen, das `dotenv` ohne Quoting falsch parst (`#` startet Kommentar, `$` löst Variablensubstitution aus).

**Fix:** Im `.env` Credentials in **einfache** Anführungszeichen setzen:

```env
ELO_USERNAME='dein.user'
ELO_PASSWORD='dein!komplizier$tes#Passwort'
```

**Lesson learned:** Bei jedem `.env`-Bug mit Credentials zuerst `console.log(p.length, p.charCodeAt(0))` machen, um Längen-Mismatch oder gestrippte Zeichen zu erkennen.

---

## 3. Empty-Body 401 bei jedem Nicht-Login-Call (nginx Basic Auth)

**Symptom:** Nach erfolgreichem Login (`haveTicket: true`) lieferte `findFirstSords` HTTP 401 mit einer HTML-Seite `<title>401 Unauthorized</title>`.

**Ursache:** Vor ELO IX sitzt ein **nginx** als Reverse Proxy. Dieser ist so konfiguriert, dass `/IXServicePortIF/login` öffentlich erreichbar ist (damit User sich überhaupt einloggen können), aber für **alle anderen Pfade HTTP Basic Auth** erforderlich ist. Der `server: nginx/1.24.0 (Ubuntu)`-Header und das HTML-401-Template waren der Hinweis.

**Fix:** `Authorization: Basic <base64>` auf **jeden** Request setzen (auch Login — nginx ignoriert es dort, IX auch). Bei Loupz sind die nginx-Credentials identisch zu den ELO-Credentials, werden aber optional über `ELO_BASIC_AUTH_USER` / `ELO_BASIC_AUTH_PASS` overridebar gehalten, falls IT die später trennt.

```ts
this.basicAuthHeader =
  'Basic ' + Buffer.from(`${baUser}:${baPass}`).toString('base64');
```

**Lesson learned:** Bei einem HTML-401 mit `server: nginx`-Header und kleinem Content-Length ist die Auth-Schicht *vor* der Anwendung der Übeltäter, nicht die Anwendung selbst.

---

## 4. `ci` (ClientInfo) fehlte in Nicht-Login-Request-Bodies

**Symptom:** Nach Fix der Basic Auth lieferten Calls einen leeren HTTP **400**.

**Ursache:** ELO IX REST erwartet auf **jedem** Call ein `ci`-Objekt im Body (`{ ticket, language, country, timeZone }`). Wir sendeten es nur beim Login.

**Fix:** In `EloClient.request()` automatisches Injecten eines minimalen `ci` aus den gespeicherten Werten:

```ts
private injectCi(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (obj.ci === undefined) {
      return { ci: this.minimalCi(), ...obj };
    }
  }
  return body;
}
```

**Wichtig:** Das vollständige `clientInfo` aus der Login-Response **nicht zurückspiegeln** — IX gibt dort Server-seitige Metadaten (`appVersion`, `databaseInfo` …) mit, deren Echo manche Setups mit leerem 400 quittieren. Nur die vier Felder Ticket/Sprache/Land/Zeitzone senden.

---

## 5. Bitset-Selektoren als nackte Strings statt `{ bset: "..." }`

**Symptom:** Nach Fix von Basic Auth + `ci` weiterhin HTTP 400 mit leerem Body.

**Ursache:** Felder wie `sordZ`, `editInfoZ`, `docVersionZ` sind keine Strings, sondern Objekte mit Schema `{ bset: string }`. Wir sendeten `sordZ: "name,xDateIso,objKeys,…"` als Komma-Liste.

**Fix:** Wrapping als Objekt und zentral in `src/elo/constants.ts`:

```ts
export const SORD_Z_ALL = { bset: '-1' } as const;
export const EDIT_INFO_Z_ALL = { bset: '-1' } as const;
export const DOC_VERSION_Z_ALL = { bset: '-1' } as const;
```

---

## 6. `bset: "mb_all"` löste leeres HTTP 400 aus (Jackson-Deserialisierungsfehler)

**Symptom:** Trotz Objekt-Wrapping blieb der 400er bei `sordZ: { bset: "mb_all" }`. Erst ohne `sordZ` antwortete IX mit einer echten JSON-Exception (`[ELOIX:2000]Falscher Parameter: sordZ==null`).

**Ursache:** Im Swagger-Schema ist `bset` als `type: string` deklariert, in der Java-`SordC`-Klasse aber ein `int`-Bitfeld. Jackson scheitert beim Deserialisieren von `"mb_all"` in ein `int`, bevor die Methode überhaupt aufgerufen wird → Tomcat antwortet mit einem leeren HTTP 400 (ohne IX-Exception-Body, weil IX selbst gar nicht erreicht wird).

**Fix:** Numerische Bitmaske als String:

```ts
export const SORD_Z_ALL = { bset: '-1' } as const;  // alle Bits → alle Member
```

**Lesson learned:** Ein **leerer 400 ohne Body** in einer JSON-RPC-API deutet fast immer auf einen Deserialisierungsfehler hin, nicht auf eine Geschäftslogik-Validierung. Felder, die im Swagger als `string` stehen, aber die Klasse heißt `…Z` (Bitfeld-Convention bei ELO), erwarten stringifizierte Zahlen.

---

## 7. Sessionverlust wurde nicht erkannt (nur IX-Exception, kein HTTP 401)

**Symptom:** Bei abgelaufener Session keine automatische Re-Authentifizierung.

**Ursache:** `isInvalidSession()` prüfte nur auf die IX-Exception-Strings `INVALID_SESSION` und `2001`. nginx liefert bei abgelaufenem Cookie aber HTTP 401, das durchs Sieb fiel.

**Fix:**

```ts
private isInvalidSession(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response?.status === 401) return true;
  // … IX-Exception-Check
}
```

---

## 8. Axios-Fehler verschluckten ELO-Detailmeldungen

**Symptom:** Im Log stand nur `Request failed with status code 400` — keine Information, was IX wirklich beanstandete.

**Ursache:** `asError()` loggte nur `err.message`. Der eigentliche IX-Exception-Body in `response.data.exception` wurde verworfen.

**Fix:** `enrichAxiosError()` extrahiert die IX-Exception aus dem Response-Body, und `assertNoException()` wirft auch bei HTTP 200 + `exception`-Body. Beides in `EloClient.request()` verdrahtet.

**Lesson learned:** Bei jedem axios-basierten Client sofort einen Error-Wrapper bauen, der `err.response?.data` extrahiert. Sonst verbrennt man Stunden, weil die Server-seitige Diagnose nie sichtbar wird.

---

## 9. `elo_get_metadata` lieferte „No object … found" trotz gültiger objId

**Symptom:** `elo_get_metadata` mit `objId: 520079` (existierendes Dokument „Rügeschreiben") warf `Error: No object with objId=520079 found.`

**Ursache:** Das Tool rief `/rest/IXServicePortIF/checkoutSord` auf. In dieser IX-Version liefert `checkoutSord` zwar eine `EditInfo`-Struktur (mit `keywords`, `markerNames`, `mask`, `pathNames`, `sordTypes`, `aspectInfos`, …), aber das `sord`-Feld bleibt unabhängig von `editInfoZ` immer leer. Probe gegen `checkoutDoc` mit identischem Body lieferte das vollständige `result.sord` (id, name, objKeys, …) zurück.

**Fix:** Endpoint in [`elo_get_metadata.ts`](src/tools/elo_get_metadata.ts#L39) auf `checkoutDoc` umgestellt — gleicher Body, gleiches Response-Schema laut OpenAPI (`BResult_820228328` für beide), aber Verhalten unterschiedlich. `elo_get_document_link` nutzt `checkoutDoc` bereits, also konsistent.

**Lesson learned:** OpenAPI-Schema und Laufzeit-Verhalten gleichnamiger ELO-IX-Methoden können auseinanderlaufen. Wenn ein Feld trotz korrektem `bset: '-1'` fehlt, alternative Methoden mit ähnlicher Signatur probieren.

**Caveat:** `checkoutDoc` ist für Dokumente konzipiert. Für reine Folder-objIds könnte ein Fallback auf `checkoutSord` mit verschachteltem `editInfoZ: { bset:'-1', sordZ:{bset:'-1'} }` nötig werden — bei Loupz aber bisher unkritisch, weil Metadaten-Lookups praktisch nur auf Dokumente gehen.

---

## 10. `ELO_WEBCLIENT_URL` zeigte auf den IX-Plugin-Proxy, nicht auf den Webclient

**Symptom:** Generierte Links wie `iegeelodev01:9090/ix-LOUPZ/plugin/de.elo.ix.plugin.proxy/web/app/document/520079` landeten beim Klicken im Nichts.

**Ursache:** `.env.example` hatte als Platzhalter `https://elo.loupz.de/elo-webclient` und im Code-Pfad `…/app/document/<objId>` angenommen. Tatsächlich nutzt Loupz einen separaten **Short-Link-Service** unter `https://elo-link.loupz.de`, der per `/<objId>` direkt auf das Dokument im Web-Client redirected. Der `?title=…`-Query-Parameter ist kosmetisch (Browser-Tab-Title).

**Fix:**

```ts
// elo_get_document_link.ts
const titleParam = sord?.name ? `?title=${encodeURIComponent(sord.name)}` : '';
const eloLink = `${webBase}/${args.objId}${titleParam}`;

// elo_find_project_folder.ts
eloLink: `${webBase}/${s.id}?title=${encodeURIComponent(s.name)}`,
```

`.env.example` und README angepasst:

```env
ELO_WEBCLIENT_URL=https://elo-link.loupz.de
```

**Lesson learned:** ELO-Installations haben oft **drei** URL-Räume parallel — IX REST API, IX Plugin Proxy (Backend-zu-Backend), und Webclient (Human-facing). Den Webclient-URL niemals raten, sondern einmal empirisch im Browser kopieren.

---

## 11. `refPaths` falsch genestet → `firstRefPath.map is not a function`

**Symptom:** `elo_find_project_folder` warf `Error: firstRefPath.map is not a function` für jede gefundene Folder-objId.

**Ursache:** Die Annahme in [`elo_find_project_folder.ts`](src/tools/elo_find_project_folder.ts) und im Typ `EloSord.refPaths` war `refPaths: EloRefPathItem[][]` — also Array aus Item-Arrays. Tatsächlich liefert ELO IX `refPaths` als Array aus **Objekten**, jedes mit `path: EloRefPathItem[]` und einem pre-konkatenierten `pathAsString` (Separator `¶`).

Live-Beispiel:
```json
"refPaths": [{
  "path": [
    { "id": 6411, "name": "Projekte", "guid": "…" },
    { "id": 6618, "name": "Projektmanagement", "guid": "…" },
    …
  ],
  "pathAsString": "¶Projekte¶Projektmanagement¶…"
}]
```

**Fix:** Neuer Typ `EloRefPathInfo`, `EloSord.refPaths` darauf umgestellt, im Tool eine Indirektion mehr:

```ts
// types.ts
export interface EloRefPathInfo {
  path: EloRefPathItem[];
  pathAsString?: string;
}
// EloSord.refPaths: EloRefPathInfo[]

// elo_find_project_folder.ts
const firstRefPath = s.refPaths?.[0]?.path ?? [];
const path = firstRefPath.map((p) => p.name).join('/');
```

**Lesson learned:** Bei ELO IX immer den echten JSON-Body anschauen, bevor man Typen aus dem OpenAPI-Schema ableitet — die Java-Typen-Namen (`RefPath` vs. `RefPathInfo`) sind subtil, und ein verirrter Plural im Schema-Namen kann eine Verschachtelungs-Ebene verschleiern.

---

## Zusammenfassung der Loupz-spezifischen Eigenheiten

| Aspekt | Verhalten bei Loupz |
|---|---|
| Auth-Schichten | nginx Basic Auth **vor** IX, IX-Session per JSESSIONID-Cookie. Login-Pfad ist nginx-Auth-frei. |
| Token-Mechanismus | Cookie-basiert. Login-Response gibt `ticket: "de.elo.ix.client.ticket_from_cookie"` zurück → Header `x-ELOIX-Ticket` wirkungslos. |
| Required body fields | `ci` muss auf **jedem** Call mit, **minimal** gehalten (nur Ticket/Sprache/Land/Zeitzone). |
| Bitset-Felder (`…Z`) | Wire-Format: `{ bset: "<stringified-int>" }`. `-1` = alle Member. Konstantennamen wie `mb_all` triggern 400 ohne Body. |
| Fehlersignalisierung | IX selbst → HTTP 200 + `exception`-Body. nginx → echte 4xx mit HTML- oder leerem Body. Beides separat behandeln. |
| Methoden-Konsistenz | OpenAPI-Schemas und Laufzeit-Verhalten gleichnamiger Methoden divergieren. `checkoutSord` liefert leere `sord`-Felder, obwohl Schema und Bset stimmen — nutze `checkoutDoc`. |
| URL-Räume | Drei getrennte: IX REST API (`elo.loupz.de/ix-LOUPZ`), IX Plugin Proxy (backend-only), Webclient-Short-Link (`elo-link.loupz.de/<objId>`). |
| Nested Refs | `Sord.refPaths` ist `RefPathInfo[]` (mit `.path` + `.pathAsString`), nicht `RefPathItem[][]`. |

---

## Offene Punkte

- **Passwort-Rotation:** Während des Debuggings wurden Credentials in Klartext in der Probe-Script-Output gepostet. Das ELO-Passwort sollte rotiert werden.
- `elo_find_project_folder` referenziert noch den Index-Feld-Platzhalter `PROJEKTNUMMER` — empirisch bestätigen, dass dieses Feld bei Loupz so heißt.
- Folder-Metadaten via `elo_get_metadata` derzeit nicht garantiert — bei reinen Folder-IDs ggf. Fallback auf `checkoutSord` mit verschachteltem `editInfoZ.sordZ` ergänzen, falls Bedarf entsteht.
