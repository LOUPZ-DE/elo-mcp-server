# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `npm run test:http` smoke test for the HTTP transport (health, auth, MCP
  initialize, tools/list, optionally tools/call) in `scripts/test-http.ts`.
- `mcpo/` wrapper image as a fallback OpenAPI bridge for clients without
  native MCP support. Single-server mode so the spec is at `/openapi.json`.
- Native MCP path documented as primary recommendation for Open WebUI ≥ 0.9
  in `docs/open-webui.md`; mcpo bridge demoted to Path B.

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

[Unreleased]: https://github.com/LOUPZ-DE/elo-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LOUPZ-DE/elo-mcp-server/releases/tag/v0.1.0
