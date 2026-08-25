# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`elo_whoami`.** Reports which ELO account the connection acts as. With
  `MCP_AUTH_MODE=both` one endpoint serves two very different callers — an OAuth
  user running under their own ELO rights, and an API-key caller running under
  the technical account — and an empty search result means something different
  in each case. Nothing in the protocol revealed which you were.

  Registered without an `inputSchema` on purpose: with one, the SDK zod-checks
  the arguments even when the client omits them entirely, which the MCP spec
  permits, and rejects the call with `-32602`.
- **A server icon**, reaching clients two ways because neither covers
  everything: `serverInfo.icons` on `initialize` (MCP 2025-11-25 / SEP-973),
  which is the only route that works over stdio, and `GET /icon.png` plus the
  `icon` field of `/.well-known/mcp.json`, which is what Notion reads before any
  OAuth round trip. The route is unauthenticated and mounted in every auth mode,
  since Open WebUI never holds an OAuth token and a client must be able to draw
  the mark before it holds any token at all.

  `assets/icon.png` holds the ELO logo, supplied by the maintainer. Note that
  the logo is a registered trademark of ELO Digital Office GmbH and this
  repository is public — using it to identify a connector to ELO is ordinary
  nominative use, but it is worth being aware of rather than discovering later.

  The advertised size is read from the file's PNG header rather than declared in
  code, so replacing the icon stays a single file drop and cannot silently start
  reporting the wrong dimensions. A file that is not a valid PNG is refused with
  a warning instead of being served under the wrong content type.

### Fixed
- **A client asking to authenticate with a secret could not register at all.**
  `/register` refused anything but `token_endpoint_auth_method: "none"` with a
  400. RFC 7591 §3.2.1 is explicit that the server may return metadata differing
  from the request and that the client must use what it gets back, so refusing
  was both unhelpful and unnecessary: such a client is now registered as public
  and told so in the response. Nothing is weakened — `/token` authenticates no
  client either way, and PKCE is mandatory and is what binds the code to the
  caller.

  The symptom this produced was badly misleading. A client that cannot register
  falls back to a `client_id` it cached earlier, which arrives at `/authorize`
  as an unknown id — indistinguishable, from the server, from a client that
  never tried to register.
- **A rejected registration is now logged**, with the reason and the metadata
  the client asked for. It was silent, which is why the above had to be
  inferred rather than read.
- **A rolling redeploy could undo the incoming instance's state.** Easypanel
  starts the replacement container before stopping the outgoing one — observed
  in production, the new instance read the state file two seconds *before* the
  old one flushed on `SIGTERM`. Because every save rewrites everything, that
  final flush would overwrite whatever the successor had already registered.
  The shutdown flush now compares the file's mtime against this process's last
  write and stands down when a newer instance owns it. Normal saves are
  unaffected and remain authoritative.
- **An unknown `client_id` at `/authorize` is now logged.** It was the one
  failure with no trace anywhere: the page renders in the user's browser, so the
  client never sees it, and the server said nothing either. A stale registration
  after a restart and a client that never registered look identical from the
  outside; the log line names the id and how many registrations the process
  holds, which tells the two apart.

### Added
- **Encrypted state persistence (`STATE_FILE`, `STATE_ENCRYPTION_KEY`).**
  Registrations, refresh tokens and signed-in ELO sessions now survive a
  redeploy.

  This fixes a real defect, not just an inconvenience. Losing the refresh
  tokens and sessions was recoverable — the client gets a 401 from `/mcp` and
  runs the flow again. Losing the *registrations* was not: a client that stored
  its `client_id`, as Notion and claude.ai both do, presented it at
  `/authorize` and got "Diese Anwendung ist nicht (mehr) registriert" on an
  error page rendered **in the browser**. The client never saw it, so nothing
  re-registered and somebody had to delete and re-add the connector — after
  every single deploy.

  The whole file is one AES-256-GCM message. GCM because it is AEAD: a tampered
  file fails authentication rather than loading quietly, which matters because
  the credential vault — ELO user names and passwords — is in there. Written
  `0600` into a `0700` directory via a temp file and an atomic rename.
  Authorization codes and half-finished logins are not persisted; both expire
  faster than a restart takes.

  Several things are deliberately stricter than the reference implementation
  this borrows from. Its save timer is `unref()`'d and it registers no signal
  handler, so the last second before a redeploy is discarded — exactly the case
  a state file exists for; ours flushes on `SIGTERM`. It writes with the default
  umask, landing at `0644` on plaintext credentials. It casts the parsed JSON
  blindly and fills its maps *during* parsing, so a fault halfway leaves earlier
  data applied while the log claims a fresh start; ours validates each slice
  with zod and commits only after all of them parse. And an unreadable file is
  moved aside as `<name>.unreadable-<timestamp>` rather than overwritten, so a
  mistyped key costs a round of re-registration instead of the data.

  Configuration refuses to start on the mistakes that matter: `STATE_FILE`
  without a key, a relative path, a key that is not 32 bytes, or a key reused
  from `OAUTH_TOKEN_SECRET`/`OAUTH_SESSION_SECRET`. Directory writability is
  checked at boot rather than discovered in a swallowed catch at the first save.

  **Requires a single instance** — every save rewrites the complete state, so a
  second replica on the same volume would discard the first one's work. The
  server says so at boot.

### Changed
- The credential vault stores the password on the session record and builds its
  `EloClient` on first use. An `EloClient` owns an axios instance and a session
  cookie and cannot be serialised, so persisting the vault meant persisting the
  credentials and rebuilding from them. Restoring deliberately does not log in
  to ELO — that would be N simultaneous logins at boot; the existing
  `ensureSession()` path handles it on first use, and a password changed in the
  meantime is caught by `isStaleCredentialError` as before.

### Added
- **Excel extraction (`.xlsx`, `.xlsm`).** `elo_get_document_content` now reads
  workbooks. Output is one block per sheet — a `Sheet: <name>` heading, then one
  line per row with cells joined by ` | `. Not tabs: the dispatcher's whitespace
  normalisation collapses runs of tabs and spaces, so a TSV grid would arrive at
  the model as a single space with its columns gone. Not markdown tables either
  — the padding and separator row cost tokens on every row of a wide sheet and
  tell a reader nothing.

  `read-excel-file` rather than the `exceljs` the roadmap used to name: exceljs
  has not shipped since October 2023 and pulls in `archiver`, `unzipper` and
  `tmp`, i.e. write-side and filesystem machinery for a job that only reads.
  SheetJS stays rejected for the reason already recorded — the npm build is
  frozen at 0.18.5 with known advisories. `npm audit` remains clean.

  The feature that decided it is number formats. A date in a sheet is stored as
  a serial number, and reporting `45658` where `2025-01-01` was meant is not a
  gap but a wrong answer; the library resolves formats from `xl/styles.xml`.
  A password-protected workbook is an OLE2 container rather than a ZIP, which is
  indistinguishable from a legacy `.xls` saved under the wrong name — the
  message names both possibilities instead of guessing.

  Bounded at 20 000 rows per workbook and says so when it stops: xlsx is
  compressed, so a file well inside the 15 MB download cap can flatten into a
  string large enough to exhaust a small container.
- Legacy `.xls` keeps its "not supported" answer, now naming the binary BIFF
  format and suggesting a re-save rather than only offering the link.
- **OAuth 2.1 authorization server with Dynamic Client Registration.** Clients
  that want "Sign in with OAuth" — Notion Custom Connectors, claude.ai — can now
  connect without anyone pasting a token: the client registers itself (RFC 7591),
  the user gets a login form, and their credentials are checked against ELO.
  Authorization code with mandatory PKCE (S256), refresh tokens with rotation,
  RFC 9728 protected-resource and RFC 8414 authorization-server metadata, and a
  401 that finally carries `WWW-Authenticate` — which is the header that makes a
  client offer to sign in rather than simply failing.
- **Per-user ELO permissions.** This is the part that matters beyond
  convenience. A signed-in user gets their own IX session, so every tool call
  runs under *their* ELO rights instead of the technical account's. That was
  supposed to be `runAsUser`'s job; the live instance refuses it outright and
  gives the same error for "not allowed" and "no such user" (`BUGFIXES.md` #21).
  Signing the user in directly sidesteps the mechanism entirely.
- **Two-stage credential verification.** Submitting the login form runs `login`
  — inspecting the `exception` body, because IX reports bad credentials as
  HTTP 200 (`BUGFIXES.md` #1) — and then one real read on the new session. Only
  the second stage proves the session can actually do something. Failures are
  classified so the form can distinguish a wrong password from a misconfigured
  `ELO_BASIC_AUTH_*`, which are the same "login failed" from the outside and
  have completely different fixes.
- `MCP_AUTH_MODE` (`shared` | `oauth` | `both`), defaulting to `shared`. The
  default is exactly the previous behaviour and mounts none of the new
  endpoints, so an existing deployment is untouched by a redeploy. `both`
  serves API-key and OAuth clients on the same `/mcp`.
- `npm run test:oauth` — the full flow against a stub IX server, offline. It
  asserts the two things the design turns on: that a tool invoked with a user's
  token runs on that user's IX session, and that the Basic Auth presented to the
  proxy in front of IX is still the technical account.
- Fixed-window rate limiting on `/authorize`, `/token` and `/register`, and CORS
  on the discovery, registration, token and `/mcp` routes.

### Changed
- `requireBearerAuth` from the MCP SDK replaces the hand-rolled bearer check.
  Both credentials are verified through one `OAuthTokenVerifier`, so the rest of
  the server sees a single `AuthInfo` and does not care which one was used.
- Log redaction now covers `code`, `code_verifier`, `access_token`,
  `refresh_token`, `client_secret` and form passwords. A failed login logs the
  failure *kind* only — never the attempted user name, which is where a
  mistyped password ends up.
- The server instructions now tell the model that results are filtered by the
  signed-in account's ELO permissions, and that "not found" is not "does not
  exist".
- `jose` added as a direct dependency (already present transitively via the MCP
  SDK); the SDK range moved from `^1.0.0` to `^1.30.0`, which is where
  `requireBearerAuth` and `req.auth` pass-through come from.

### Removed
- **The `mcpo` wrapper image and the OpenAPI bridge it served.** It existed for
  two reasons and has neither left: Open WebUI has spoken MCP natively since
  0.9, and the OAuth support above replaces the "put mcpo in between" workaround
  for clients that insist on OAuth. What remains is an unpinned third-party base
  image in a public repo and a documented architecture that hands
  `MCP_SHARED_SECRET` to a container we do not control. `docs/open-webui.md` is
  now the direct-MCP path only. Recoverable with
  `git checkout cfef1f4 -- mcpo/` if an OpenAPI-only consumer ever turns up.

### Security
- ELO credentials are held in memory only, keyed by an opaque handle. The access
  token is signed but **not** encrypted, so it carries the handle and never the
  password. A restart therefore signs everyone out — deliberate: persisting the
  store means encrypting live ELO sessions at rest, tracked in [#4](https://github.com/LOUPZ-DE/elo-mcp-server/issues/4).
- A token whose ELO session is gone is refused with a 401. It is never served
  under the technical account, which would silently grant permissions the user
  does not have.

## [0.4.0] - 2026-08-19

### Added
- **Outlook message extraction (`.msg`).** Same output shape as `.eml`: header
  block, body, attachment manifest. Unlike `.eml` this one takes libraries —
  `@kenjiuno/msgreader` for the OLE2 container and MAPI properties,
  `@kenjiuno/decompressrtf` for `PidTagRtfCompressed`. Hand-rolling would mean
  four specifications at once, and the RTF path is not optional: many Outlook
  messages carry no plain-text body, so without it they would extract to an
  empty string. Body preference is plain text → HTML → RTF, each stripped to
  prose. The MAPI-fields-to-result mapping is a pure function and unit-tested
  as such; building a valid OLE2 fixture by hand would only test the library.
- **E-mail extraction (`.eml`, RFC 822 / MIME).** `elo_get_document_content`
  now reads e-mail files: a From/To/Cc/Subject/Date block followed by the
  message body, with attachments listed by name and type but not decoded —
  in ELO they are normally filed as separate documents that can be read
  individually. Plain-text parts win over HTML; HTML is stripped when it is
  all that exists. Handles quoted-printable, base64, nested multipart and
  non-UTF-8 charsets. Hand-rolled MIME walk rather than a mail library:
  `mailparser`/`postal-mime` bring 200 kB+ and transitive encoding
  dependencies for a job this narrow. `.eml` is consequently no longer
  reported as unreadable.
- **ELO impersonation diagnostics.** `EloClient` gains an optional
  `runAsUser` (additive; omitted from the login body when unset, so default
  behaviour is unchanged) plus three read-only probe modes: `npm run probe:runas`
  attempts impersonation and compares result sets across both sessions,
  `probe:accounts` puts the fields that decide whether an account can
  authenticate side by side, and `probe:variants` walks every login shape IX
  offers. Groundwork for running under each end user's own ELO identity — the
  mechanism is present in the API but refused by the instance, so this release
  ships the diagnostics and the evidence, not the feature. See `BUGFIXES.md` #21.

### Changed
- **`.ecf` is now reported as ELO-encrypted, not as a mail container.** Reading
  the raw bytes of one from a live archive shows it begins with the marker
  `EloCryptAES_v`: these are documents held in an ELO encryption area, and the
  content stream hands out ciphertext. No parser can help, so the message now
  says so and points at the eloLink, which ELO decrypts for authorised users.

### Fixed
- **PDFs failing with `Math.sumPrecise is not a function`.** The pdf.js
  bundled by `unpdf@1.8.0` calls a TC39 proposal that Node 24 does not ship —
  the dependency is ahead of the runtime, not behind it. `src/extract/sumPrecise.ts`
  supplies the function before pdf.js is evaluated and becomes a no-op once
  Node provides it. Affects encrypted PDFs, XFA forms and form-field
  appearance generation; ordinary documents never reach those code paths.
  See `BUGFIXES.md` #23.

## [0.3.0] - 2026-07-31

Document text extraction. Answers the pilot report that the connector found the
right documents but returned no content from them.

### Added
- **`elo_get_document_content`** — returns the extracted text of a document.
  Supports PDF (via `unpdf`), Word `.docx` (via `mammoth`) and plain-text
  formats. Long documents are truncated and paged via `offset`/`nextOffset`,
  with the continuation instruction spelled out in the response `notice`.
- Scanned PDFs are detected (`textLayer: "none"`) and reported as such instead
  of silently returning empty text. No OCR is attempted.
- Unsupported types (`.xlsx`, `.ecf`, `.msg`, images, archives, CAD) return a
  *successful* result with an explanation and the `eloLink`, rather than an
  error — many MCP clients abort a tool chain on `isError: true`.
- `EloClient.download()` for authenticated binary fetches, with a size cap
  enforced during transfer, a separate timeout, and no redirect following.
- `src/elo/streamUrl.ts` — resolves IX content URLs and pins every request to
  the configured ELO origin, so credentials cannot be sent to another host.
- Concurrency limiter (`ELO_CONTENT_CONCURRENCY`, default 2) around download
  and parsing, to keep parallel large files from exhausting a small container.
- `npm run test:live` — end-to-end checks against a real ELO instance,
  including text extraction, paging and error paths.

### Changed
- **Docker base image and minimum Node version raised to 22** (image uses
  `node:24-alpine`). `unpdf` requires Node ≥ 22; on Node 20 it builds cleanly
  and then fails at runtime. Node 20 is also end-of-life.
- `elo_get_document_link` now labels its `downloadUrl` as unusable by external
  clients and points to `elo_get_document_content` instead.

### Configuration
- New: `ELO_DOCUMENT_CONTENT_ENABLED`, `ELO_MAX_DOCUMENT_BYTES`,
  `ELO_MAX_TEXT_CHARS`, `ELO_DOWNLOAD_TIMEOUT_MS`, `ELO_CONTENT_CONCURRENCY`.
  All have working defaults; no deployment change is required.

## [0.2.0] - 2026-07-31

Search precision and link consistency. Addresses the pilot reports of links
into the wrong project data room, inconsistent links for the same document, and
searches that were "not accurate enough".

### Breaking
- **Tool results are now envelope objects, not bare arrays.** `elo_search` and
  `elo_find_project_folder` return `{ …metadata, results: [...] }`. Consumers
  that parsed `content[0].text` and called `.map()` must use `.results.map()`.
  A bare array cannot express "there are more matches", "this was scoped to
  project X" or "these hits are guesses" — and all three were missing.
- `elo_search` default `maxResults` lowered from 100 to 20, cap from 500 to 100.

### Fixed
- **Wrong project data room.** `elo_find_project_folder` applied `max: 50`
  *before* filtering out documents, so a project folder could be pushed out of
  the window and vanish silently. It now over-fetches, resolves project numbers
  exactly via `findByIndex`, labels every hit `exact` or `fuzzy`, ranks project
  roots (`SOL_TYPE=PROJEKT`) above sub-folders, and drops non-project folders
  once a real data room is found. Verified on a live archive, where a project
  number and a title search for that same number point at *different* folders —
  folder titles and index fields drift apart over a project's life.
- **Inconsistent links.** `elo_search` returned neither a path nor a link, so
  the model had only an objId and filled the gap from conversation context.
  Every result from every tool now carries `path`, `parentId` and a ready-made
  `eloLink`, and the server `instructions` require links to be copied verbatim.
- `elo_get_document_link` omitted `editInfoZ`, so IX returned a stripped-down
  `sord` and the link came back without its `?title=` — the same object got two
  different links depending on which tool produced it.
- The change date was read as `xDateIso`; IX spells it `XDateIso`, so
  `elo_search` and `elo_get_metadata` returned `undefined` on every call.
- `findFirstSords` leaked server-side search handles: `searchId` was never
  passed to `findClose`.

### Added
- **`elo_list_folder`** — lists folder contents with depth, name filter, type
  filter, sorting and paging. Makes "which monthly reports exist in project X"
  answerable; previously the only route was an archive-wide fuzzy search, which
  is how documents from other projects were pulled in.
- `elo_search` gained `parentId` subtree scoping, plus `type`, `depth` and
  `offset`. Note the trade-off, which the response states explicitly: ELO cannot
  combine full-text search with a folder restriction, so a scoped search covers
  titles and index fields only.
- Truncation is now surfaced honestly: every envelope carries `truncated` and a
  `note` telling the model the list is incomplete.
- Server-level `instructions` and rewritten tool descriptions encoding the
  intended workflow (resolve project → scope → cite with path).
- `annotations: { readOnlyHint, idempotentHint, … }` on every tool.
- `scripts/probe-ix.ts` (`npm run probe`) — read-only reconnaissance that
  answers open questions about IX runtime behaviour before code depends on them.
- `scripts/test-units.ts` (`npm run test:unit`) — offline unit tests.

### Configuration
- New: `ELO_PROJECT_NAME_FIELD`, `ELO_PROJECT_MARKER_FIELD`,
  `ELO_PROJECT_MARKER_VALUE`. All default to the ELO Solutions standard mask.

### Notes
- `npm run test:http` smoke test for the HTTP transport, `mcpo/` wrapper image,
  and the Open WebUI ≥ 0.9 native-MCP guidance were added before this release
  and are folded into it.

## [0.1.0] - 2026-05-26

First public release.

### Added
- Four read-only MCP tools that wrap ELO IX REST:
  - `elo_search` — full-text and index-field search across documents and folders.
  - `elo_get_metadata` — index fields, mask, owner, and version info for a given `objId`.
  - `elo_get_document_link` — durable web-client link and short-lived download URL.
  - `elo_find_project_folder` — project folder lookup by project number or name.
- Two transports, switchable via `MCP_TRANSPORT`:
  - `stdio` (default) for local Claude Desktop integration.
  - `http` (Streamable HTTP) for remote MCP clients — claude.ai Custom
    Connectors, n8n, Make, Notion AI, Open WebUI (via `mcpo`).
- HTTP Bearer-token authentication via `MCP_SHARED_SECRET`, with constant-time
  comparison (`crypto.timingSafeEqual`).
- Multi-stage `Dockerfile` (Node 20-alpine, runs as the non-root `node` user),
  ready for deployment on Easypanel or any container platform.
- Configurable ELO project-number index field via `ELO_PROJECT_NUMBER_FIELD`
  (defaults to `PRJ_NO`, matching the ELO Solutions standard project mask).
- Optional split Basic-Auth credentials for reverse-proxy environments via
  `ELO_BASIC_AUTH_USER` / `ELO_BASIC_AUTH_PASS` (defaults to the ELO
  credentials).
- Health endpoint at `GET /health` for liveness checks.
- Documentation:
  - `README.md` — setup, environment, Claude Desktop integration, Easypanel
    deployment, badges.
  - `docs/open-webui.md` — Open WebUI integration via the `mcpo` bridge.
  - `docs/notion.md` — four integration paths (Custom Connector, Agents,
    n8n bridge, claude.ai).
  - `BUGFIXES.md` — annotated record of every non-obvious ELO IX REST issue
    encountered during development.
- CC BY-NC 4.0 license.

### Security
- pino log redaction configured for `userPwd`, `Cookie`, `Authorization` fields.
- HTTP transport requires `MCP_SHARED_SECRET` to be set; the configuration
  loader rejects HTTP mode without it.
- No write tools exposed — leaked tokens grant read-only access through the
  configured technical user, nothing more.

### Notes on early development
- Pre-0.1.0 commits were development-only; their contents are folded into
  the 0.1.0 release. See `BUGFIXES.md` for the substantive design and
  protocol-quirk decisions made during that phase.

[Unreleased]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LOUPZ-DE/elo-mcp-server/releases/tag/v0.1.0
