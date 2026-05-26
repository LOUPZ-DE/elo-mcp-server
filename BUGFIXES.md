# ELO MCP Server — Bugfix Notebook

**Project:** elo-mcp-server
**Period:** May 2026
**Status:** all four tools (`elo_search`, `elo_get_metadata`,
`elo_get_document_link`, `elo_find_project_folder`) verified against a
production ELO IX instance.

This document is an annotated record of every non-obvious bug we hit while
implementing a client against the ELO IX REST API. Each entry has the symptom,
the actual cause (which often differed from the obvious one), the fix, and —
where relevant — a lesson worth remembering on the next IX project.

---

## 1. `test:login` reported "Login OK" even though the login failed

**Symptom:** `npm run test:login` printed `Login OK`. `elo_search` still
returned HTTP 401.

**Cause:** ELO IX answers bad credentials with HTTP **200** and an
`{ "exception": "[ELOIX:3008]Unknown user, wrong password, or account
locked." }` body — while still setting a `JSESSIONID` cookie (an anonymous
session). The client only checked for the cookie, never for the `exception`
field.

**Fix:** Inspect the `exception` field in `EloClient.login()` and throw a
descriptive error when present.

```ts
const exception = (response.data as { exception?: unknown })?.exception;
if (exception) {
  throw new Error(`ELO login rejected: ${msg}`);
}
```

**Lesson learned:** ELO IX returns nearly every business-logic error as
HTTP 200 with an `exception` body, not as 4xx. The status code alone is not
enough to determine success.

---

## 2. Password mangled by `.env` parsing

**Symptom:** Login with seemingly correct credentials failed with
`[ELOIX:3008]`. The same credentials worked fine in the ELO web client and
Java client.

**Cause:** The password contained a special character that `dotenv` mis-parses
without quoting (`#` starts a comment, `$` triggers variable substitution in
some configurations).

**Fix:** Wrap credentials in **single quotes** in `.env`:

```env
ELO_USERNAME='your.user'
ELO_PASSWORD='your!complicated$#password'
```

**Lesson learned:** For every credential bug coming from `.env`, sanity-check
with `console.log(p.length, p.charCodeAt(0))` first — a length mismatch
exposes parsing problems immediately.

---

## 3. Empty-body 401 on every non-login call (nginx Basic Auth)

**Symptom:** After a successful login (`haveTicket: true`), `findFirstSords`
returned HTTP 401 with an HTML page titled `401 Unauthorized`.

**Cause:** An **nginx** reverse proxy sits in front of ELO IX. It is
configured so that `/IXServicePortIF/login` is publicly reachable (so users
can authenticate), but **every other path requires HTTP Basic Auth**. The
`server: nginx/1.24.0 (Ubuntu)` header on the 401 response and the standard
nginx 401 HTML template were the giveaways.

**Fix:** Add `Authorization: Basic <base64>` to **every** request (including
login — nginx ignores it there, and so does IX). The default behaviour reuses
the ELO credentials for Basic Auth; if your environment splits the two
layers, override with `ELO_BASIC_AUTH_USER` / `ELO_BASIC_AUTH_PASS`.

```ts
this.basicAuthHeader =
  'Basic ' + Buffer.from(`${baUser}:${baPass}`).toString('base64');
```

**Lesson learned:** An HTML 401 with a `server: nginx` header and a small
content length is almost always the proxy talking, not the application. Look
one layer up.

---

## 4. `ci` (ClientInfo) missing from non-login request bodies

**Symptom:** After fixing Basic Auth, calls came back with empty HTTP **400**.

**Cause:** ELO IX REST expects a `ci` object in the body of **every** call
(`{ ticket, language, country, timeZone }`). We only sent it on login.

**Fix:** Inject a minimal `ci` from the stored login state into every request
body in `EloClient.request()`:

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

**Important:** Do **not** echo the full `clientInfo` from the login response
back to subsequent requests. IX includes server-side metadata there
(`appVersion`, `databaseInfo`, …) and some setups reject those fields with
an empty 400. Send only the four needed: ticket, language, country, timezone.

---

## 5. Bitset selectors sent as bare strings instead of `{ bset: "..." }`

**Symptom:** After fixing Basic Auth and `ci`, the calls still returned HTTP
400 with an empty body.

**Cause:** Fields like `sordZ`, `editInfoZ`, `docVersionZ` are not strings;
they are objects with schema `{ bset: string }`. We were sending
`sordZ: "name,xDateIso,objKeys,…"` as a comma-separated list.

**Fix:** Wrap as objects and centralise in `src/elo/constants.ts`:

```ts
export const SORD_Z_ALL = { bset: '-1' } as const;
export const EDIT_INFO_Z_ALL = { bset: '-1' } as const;
export const DOC_VERSION_Z_ALL = { bset: '-1' } as const;
```

---

## 6. `bset: "mb_all"` triggered an empty HTTP 400 (Jackson deserialisation)

**Symptom:** Even with the object wrapper, the 400 remained for
`sordZ: { bset: "mb_all" }`. Only when `sordZ` was omitted entirely did IX
respond with a real JSON exception
(`[ELOIX:2000]Falscher Parameter: sordZ==null`).

**Cause:** The OpenAPI schema declares `bset` as `type: string`. The Java
`SordC` class, however, treats it as an `int` bitmask. Jackson fails to
deserialise `"mb_all"` into an `int` **before** the IX method is invoked, so
Tomcat returns an empty HTTP 400 (no `exception` body — IX itself is never
reached).

**Fix:** Use a stringified numeric bitmask:

```ts
export const SORD_Z_ALL = { bset: '-1' } as const;  // all bits → all members
```

**Lesson learned:** An **empty 400 with no body** in a JSON-RPC-ish API
almost always points to a deserialisation failure, not business-logic
validation. Fields typed as `string` in OpenAPI whose class name ends in
`…Z` (ELO's bit-field convention) really want stringified numbers.

---

## 7. Session expiry not detected (only IX-exception, not HTTP 401)

**Symptom:** When the session expired, no automatic re-authentication
happened.

**Cause:** `isInvalidSession()` only matched IX exception strings
`INVALID_SESSION` and `2001`. nginx, however, returns HTTP 401 when the
cookie expires — that fell through our filter.

**Fix:**

```ts
private isInvalidSession(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response?.status === 401) return true;
  // … IX exception check
}
```

---

## 8. Axios errors swallowed ELO detail messages

**Symptom:** The log only said `Request failed with status code 400` —
nothing about what IX actually rejected.

**Cause:** `asError()` only logged `err.message`. The real IX exception body
in `response.data.exception` was discarded.

**Fix:** `enrichAxiosError()` extracts the IX exception from the response
body, and `assertNoException()` throws when an HTTP 200 carries an
`exception` field. Both wired into `EloClient.request()`.

**Lesson learned:** With any axios-based client, build an error wrapper that
extracts `err.response?.data` immediately. Otherwise you burn hours because
the server-side diagnosis is never surfaced.

---

## 9. `elo_get_metadata` returned "No object … found" for valid objIds

**Symptom:** `elo_get_metadata` with a known existing document objId threw
`Error: No object with objId=<id> found.`

**Cause:** The tool called `/rest/IXServicePortIF/checkoutSord`. In this IX
version, `checkoutSord` returns an `EditInfo` shell (with `keywords`,
`markerNames`, `mask`, `pathNames`, `sordTypes`, `aspectInfos`, …) but the
`sord` field stays empty regardless of `editInfoZ`. Probing with
`checkoutDoc` and the same body returned the complete `result.sord` (id,
name, objKeys, …).

**Fix:** Switched the endpoint in
[`elo_get_metadata.ts`](src/tools/elo_get_metadata.ts) to `checkoutDoc` —
same body, same response schema in the OpenAPI spec (`BResult_820228328`),
different runtime behaviour. `elo_get_document_link` already used
`checkoutDoc`, so the choice is consistent.

**Lesson learned:** OpenAPI schemas and runtime behaviour of similarly-named
ELO IX methods can drift. If a field stays empty despite `bset: '-1'`, try
the sibling method with the same signature.

---

## 10. `ELO_WEBCLIENT_URL` pointed at the IX plugin proxy, not the web client

**Symptom:** Generated links like
`<internal-host>:9090/ix-INSTANCE/plugin/de.elo.ix.plugin.proxy/web/app/document/520079`
went nowhere when clicked.

**Cause:** The placeholder in `.env.example` was a generic web-client URL,
and the code path assumed `…/app/document/<objId>`. The actual installation
used a separate **short-link service** at a different domain that redirects
`/<objId>` directly to the web-client view. The `?title=…` query parameter
is cosmetic (browser tab title).

**Fix:**

```ts
// elo_get_document_link.ts
const titleParam = sord?.name ? `?title=${encodeURIComponent(sord.name)}` : '';
const eloLink = `${webBase}/${args.objId}${titleParam}`;

// elo_find_project_folder.ts
eloLink: `${webBase}/${s.id}?title=${encodeURIComponent(s.name)}`,
```

The `.env.example` and the README now tell users to verify
`ELO_WEBCLIENT_URL` empirically by opening a document in the browser.

**Lesson learned:** ELO installations often have **three** parallel URL
spaces — the IX REST API, the IX plugin proxy (backend-to-backend), and the
human-facing web client. Never guess; copy the URL prefix once from the
browser.

---

## 11. `refPaths` shaped differently than assumed → `firstRefPath.map is not a function`

**Symptom:** `elo_find_project_folder` threw `Error: firstRefPath.map is not
a function` for every folder hit.

**Cause:** The code and the `EloSord.refPaths` type assumed
`refPaths: EloRefPathItem[][]` — an array of item arrays. In reality, ELO IX
returns `refPaths` as an array of **objects**, each with a `path:
EloRefPathItem[]` field and a pre-joined `pathAsString` (separator: pilcrow
`¶`).

Live example:

```json
"refPaths": [{
  "path": [
    { "id": 6411, "name": "Projects", "guid": "…" },
    { "id": 6618, "name": "Project Management", "guid": "…" },
    …
  ],
  "pathAsString": "¶Projects¶Project Management¶…"
}]
```

**Fix:** Added the `EloRefPathInfo` type, switched `EloSord.refPaths` to use
it, and added one indirection in the tool:

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

**Lesson learned:** With ELO IX, always look at a real JSON body before
inferring types from the OpenAPI schema. The Java type names (`RefPath`
vs. `RefPathInfo`) are easy to confuse, and a stray plural in a schema name
can hide a level of nesting.

---

## 12. `EditInfoZ` without nested `sordZ` → empty `objKeys` for folders

**Symptom:** `elo_get_metadata` on a folder objId (e.g. a project folder)
returned a full sord (name, mask, owner) but `indexFields: {}`. As a result
`elo_find_project_folder` had no way to look up the project number.

**Cause:** `EditInfoZ` is a **nested** selector. The outer `bset` controls
which EditInfo top-level fields come back (sord, document, keywords, …). To
control which **members of the contained sord** are populated (e.g.
`sord.objKeys`), you must also set the **nested** `sordZ`. Without it, IX
returns the sord with base fields but no index data — and the result looks
like an empty sord.

**Fix:** Extended `EDIT_INFO_Z_ALL` in
[`src/elo/constants.ts`](src/elo/constants.ts):

```ts
export const EDIT_INFO_Z_ALL = {
  bset: '-1',
  sordZ: { bset: '-1' },
} as const;
```

Bonus finding from the same probe: project folders in the ELO Solutions
standard project mask carry `PRJ_NO` (project number) and `PRJ_NAME`
(human-readable name), with `SOL_TYPE = "PROJEKT"` marking them as project
folders. The field name is exposed as `ELO_PROJECT_NUMBER_FIELD` env var
(default `PRJ_NO`) so custom masks can override it.

**Lesson learned:** For every ELO IX `…Z` selector, always specify the
nested selectors as well. The pattern is hidden in the OpenAPI schema
because every `…Z` renders as `{ bset: string }` — the nested members only
surface when you look at the underlying Java class.

---

## Summary of ELO IX gotchas

| Aspect | What we observed |
|---|---|
| Auth layers | nginx Basic Auth **in front of** IX, IX session via `JSESSIONID` cookie. The login path is exempt from nginx auth. |
| Token mechanism | Cookie-based. The login response returns `ticket: "de.elo.ix.client.ticket_from_cookie"` → the `x-ELOIX-Ticket` header is a no-op here. |
| Required body fields | `ci` is required on **every** call, kept minimal (ticket / language / country / timezone only). |
| Bitset fields (`…Z`) | Wire format: `{ bset: "<stringified-int>" }`. `-1` = all members. Named constants like `mb_all` trigger an empty 400. |
| Error signalling | IX itself → HTTP 200 with an `exception` body. nginx → real 4xx with HTML or empty body. Handle both. |
| Method consistency | OpenAPI schemas and runtime behaviour of similarly-named methods can diverge. `checkoutSord` returns empty `sord` fields here even with the right `bset`; use `checkoutDoc`. |
| URL spaces | Three separate ones: IX REST API, IX Plugin Proxy (backend-only), web client / link service. |
| Nested refs | `Sord.refPaths` is `RefPathInfo[]` (with `.path` + `.pathAsString`), not `RefPathItem[][]`. |
| Nested `Z` selectors | `EditInfoZ` needs a nested `sordZ` to populate `sord.objKeys`. The outer bset alone is not enough. |

---

## Open items

- **Password rotation:** during debugging, credentials appeared briefly in
  probe-script output captured in chat history. Rotate the ELO password if
  you suspect any exposure.
