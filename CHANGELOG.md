# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LOUPZ-DE/elo-mcp-server/releases/tag/v0.1.0
