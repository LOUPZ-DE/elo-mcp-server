# ELO MCP Server

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2B%20stdio-7C3AED.svg)](https://modelcontextprotocol.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white)](Dockerfile)

A [Model Context Protocol](https://modelcontextprotocol.io/) server providing
**read-only** access to the [ELO Digital Office](https://www.elo.com/) document
management system. Exposes search, metadata, document links, and project-folder
lookups as tools that LLM agents (Claude Desktop, Claude Code, claude.ai
Custom Connectors, Notion AI, Open WebUI, n8n, Make, …) can call.

## Tools

| Tool | Purpose |
|---|---|
| `elo_find_project_folder` | Resolves a project to its data-room folder — exact match on the project number, fuzzy fallback, clearly labelled |
| `elo_search` | Search across documents and folders, archive-wide or scoped to a project subtree |
| `elo_list_folder` | Lists folder contents with depth, name filter, sorting and paging |
| `elo_get_document_content` | Extracts the text of a PDF, Word, Excel, e-mail (`.eml`/`.msg`) or plain-text document |
| `elo_get_metadata` | Index fields, mask, owner, dates and version info for an `objId` |
| `elo_get_document_link` | The authoritative link to an ELO object |

Every result carries the object's archive `path` and a ready-made `eloLink`.
That is deliberate: an assistant given only an `objId` has to reconstruct both,
and it will do so inconsistently — hits from different projects are otherwise
indistinguishable. The server's MCP `instructions` require links to be copied
verbatim from tool output.

### Two search engines, one trade-off worth knowing

ELO cannot combine full-text search with a folder restriction — the full-text
index runs on a separate engine that ignores folder criteria (see
[`BUGFIXES.md`](BUGFIXES.md) #16). So:

- **Without `parentId`** — `elo_search` searches document *content* across the
  whole archive.
- **With `parentId`** — it searches titles and index fields within that
  subtree only.

The response states which engine ran and says so in its `note`, rather than
implying a scope that was not applied.

## Quick start

```powershell
# 1) install deps
npm install

# 2) copy the env template and fill in the values
copy .env.example .env
notepad .env

# 3) verify credentials & connectivity
npm run test:login   # expects "Login OK"

# 4) build
npm run build
```

### Required environment variables

See [`.env.example`](.env.example) for the complete list with comments.

| Variable | Purpose |
|---|---|
| `ELO_BASE_URL` | IX REST base URL, e.g. `https://elo.example.com/ix-INSTANCE` |
| `ELO_WEBCLIENT_URL` | Browser-facing URL prefix used for human-clickable links |
| `ELO_USERNAME` / `ELO_PASSWORD` | Technical user, read-only role recommended |
| `ELO_BASIC_AUTH_USER` / `ELO_BASIC_AUTH_PASS` | Optional, only if a reverse proxy in front of IX requires HTTP Basic Auth |
| `ELO_PROJECT_NUMBER_FIELD` / `ELO_PROJECT_NAME_FIELD` | Index fields holding the project number and name. Defaults `PRJ_NO` / `PRJ_NAME` |
| `ELO_PROJECT_MARKER_FIELD` / `ELO_PROJECT_MARKER_VALUE` | How a project data room is recognised. Defaults `SOL_TYPE` / `PROJEKT` |
| `ELO_DOCUMENT_CONTENT_ENABLED` | Set to `false` to unregister `elo_get_document_content`. Default `true` |
| `ELO_MAX_DOCUMENT_BYTES` / `ELO_MAX_TEXT_CHARS` | Download and extracted-text caps. Defaults 15 MB / 50 000 characters |
| `ELO_DOWNLOAD_TIMEOUT_MS` / `ELO_CONTENT_CONCURRENCY` | Download timeout and parallelism. Defaults 60 s / 2 |
| `ELO_LANGUAGE` / `ELO_COUNTRY` / `ELO_TIMEZONE` | ClientInfo defaults |
| `MCP_TRANSPORT` | `stdio` (default) or `http` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP transport bind address (default `0.0.0.0:3000`) |
| `MCP_SHARED_SECRET` | Bearer token for the HTTP transport. Required unless `MCP_AUTH_MODE=oauth` |
| `MCP_AUTH_MODE` | `shared` (default), `oauth` or `both`. See [OAuth 2.1 + DCR](docs/oauth-dcr.md) |
| `PUBLIC_BASE_URL`, `OAUTH_TOKEN_SECRET`, `OAUTH_SESSION_SECRET` | Required when OAuth is enabled |
| `STATE_FILE`, `STATE_ENCRYPTION_KEY` | Encrypted persistence, so a redeploy does not strand connected clients. Strongly recommended with OAuth |
| `LOG_LEVEL` | pino level, default `info` |

## Local testing with the MCP Inspector

```powershell
npm run build
npm run inspect
```

This opens a browser UI listing every registered tool. Suggested smoke flow —
it mirrors the workflow the tool descriptions steer the model towards:

1. `elo_find_project_folder` with a real project number → `matchMode: "exact"`,
   one folder with `isProjectRoot: true` and a reconstructed `path`.
2. `elo_list_folder` with that `objId` → the project's sub-folders.
3. `elo_search` with `parentId` set to the same `objId` → every hit's `path`
   starts inside the project.
4. `elo_get_document_content` on a PDF or `.docx` from that list → extracted
   text, with `truncated`/`nextOffset` on longer documents.
5. `elo_get_document_link` on the same `objId` → an `eloLink` byte-identical to
   the one the search returned.

### Automated tests

```powershell
npm run test:unit    # offline; link building, paths, ranking, URL resolution, extraction, OAuth primitives
npm run test:http    # spawns the HTTP transport; auth, tools/list, SSE regression
npm run test:oauth   # offline; the whole OAuth + DCR flow against a stub IX server
npm run test:live    # end-to-end against your real ELO instance (read-only)
npm run probe        # read-only reconnaissance of IX runtime behaviour
```

`test:live` discovers its own fixtures — it finds a project, lists it, searches
within it and reads a document. Steps 3–5 above are its core assertions: a
scoped search must not leak documents from other projects, and one object must
produce one link no matter which tool returned it.

## Claude Desktop integration

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elo": {
      "command": "node",
      "args": ["C:\\path\\to\\elo-mcp-server\\dist\\index.js"],
      "env": {
        "ELO_BASE_URL": "https://elo.example.com/ix-INSTANCE",
        "ELO_WEBCLIENT_URL": "https://elo.example.com/elo-webclient",
        "ELO_USERNAME": "…",
        "ELO_PASSWORD": "…"
      }
    }
  }
}
```

Restart Claude Desktop. The six `elo_*` tools must appear in the tool list.

## Client integrations

Step-by-step guides for the most common integration paths:

- [Open WebUI (native MCP)](docs/open-webui.md)
- [Notion (Custom Connector, Agents, n8n bridge, claude.ai)](docs/notion.md)
- [OAuth 2.1 + Dynamic Client Registration](docs/oauth-dcr.md) — let users sign
  in with their own ELO account instead of sharing one API key, so tool calls
  run under their own ELO permissions

## Remote hosting (Easypanel)

The server speaks two transports, switchable via env:

- `MCP_TRANSPORT=stdio` (default) — local Claude Desktop usage.
- `MCP_TRANSPORT=http` — Streamable HTTP at `POST/GET /mcp`, suitable for
  remote MCP clients (claude.ai Custom Connector, n8n, Make, Notion agents).

### Deploy on Easypanel from this Git repo

1. **Generate a shared secret** locally:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. In Easypanel: **Create App → from GitHub** → pick this repo. Easypanel
   detects the [`Dockerfile`](Dockerfile) and builds it on each push.
3. Set the **Environment** variables (Easypanel UI → Env):
   - `MCP_TRANSPORT=http`
   - `MCP_SHARED_SECRET=<generated>`
   - `ELO_BASE_URL`, `ELO_WEBCLIENT_URL`, `ELO_USERNAME`, `ELO_PASSWORD`
   - `ELO_LANGUAGE`, `ELO_COUNTRY`, `ELO_TIMEZONE` (optional, have defaults)
4. **Port**: expose `3000`. Easypanel auto-attaches a Let's-Encrypt domain.
5. **Health check** (optional): `GET /health` returns `200 OK`.

### Wire up a remote client

The server listens at `POST /mcp` and `GET /mcp`. Authenticate with the
Bearer token on every request:

```
Authorization: Bearer <MCP_SHARED_SECRET>
```

For claude.ai Custom Connectors, use `https://<your-domain>/mcp`.
For n8n / Make, configure the HTTP node likewise — Bearer header + JSON body
containing the MCP message.

### Security notes

- The HTTP endpoint is **public** once deployed. The shared-secret check
  uses `crypto.timingSafeEqual` to avoid timing leaks, but is only as
  strong as the secret itself — use ≥32 random bytes.
- Rotate `MCP_SHARED_SECRET` if it's exposed anywhere (logs, tickets, …).
- The server is read-only — no write tools are registered. A leaked token
  grants read access to your ELO contents through the configured technical
  user, nothing more.
- That last point is the argument for [OAuth](docs/oauth-dcr.md): with
  `MCP_AUTH_MODE=both`, users who sign in with their own ELO account are
  scoped to their own ELO permissions, and a leaked token of theirs exposes
  only what they could already see.
- Optionally restrict by source IP in Easypanel's Traefik labels if your
  callers come from a fixed set of addresses.

## Architecture and operational notes

- **MVP is read-only.** No write operations (`createSord`, `checkinSord`,
  `checkinDocBegin`, …) are exposed. Do not add them without a separate
  review.
- **Credentials never leave the process.** `.env` is git-ignored; logs are
  configured with pino redaction for `userPwd`, `Cookie`, `Authorization`.
- **Download URLs are not shareable.** The `downloadUrl` from
  `elo_get_document_link` is bound to the server's ELO session and expires
  within minutes, so no browser, Notion page or downstream system can open it.
  To read a document use `elo_get_document_content`; to point a human at one
  use `eloLink`.
- **Text extraction, not file transfer.** `elo_get_document_content` returns
  extracted *text*. There is no path from an MCP tool result to a file
  attachment in a downstream tool — a literal 1:1 file import needs that
  system's own upload API driven by an ETL job.
- **Scanned PDFs return no text.** They are detected and reported with
  `textLayer: "none"` plus an explanatory `notice`. No OCR is performed; if
  ELO's own Textreader OCR is enabled, its full-text index is the right source
  and would be a separate integration.
- **Node ≥ 22 is required.** The PDF parser (`unpdf`) uses
  `Promise.withResolvers`, which does not exist on Node 20 — that combination
  builds cleanly and then fails at runtime.
- **Session refresh is automatic.** The client re-authenticates after 8
  minutes of idle time and once on `INVALID_SESSION [2001]`.
- **Folder/document classification** uses the ELO IX convention
  `sord.type < 254` = folder, `>= 254` = document. Do **not** check
  `sord.type === 5` — that's only one folder subtype.

For a complete record of the implementation pitfalls encountered while
talking to ELO IX REST — and how they were resolved — see
[`BUGFIXES.md`](BUGFIXES.md). Release notes live in
[`CHANGELOG.md`](CHANGELOG.md).

## Roadmap

- Horizontal scaling. State persistence is a single encrypted file rewritten in
  full on every change, so it assumes one instance. More than one would need a
  shared store rather than a volume.
- Legacy `.doc` and `.xls` extraction (the pre-2007 binary formats). Deferred:
  both need a BIFF/OLE2 parser, and the maintained options are heavier than the
  demand justifies. Re-saving in the modern format is the cheaper fix.
- Optional signed download proxy, so a document could be fetched by a browser
  or a downstream system without an ELO session. Deliberately not built —
  it would expose archive documents on a URL that anyone holding the link can
  open, which is a decision for the archive owner rather than a default.

## API references

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ELO IX JavaDoc (v23)](https://forum.elo.com/javadoc/ix/23/)
- ELO IX OpenAPI for your instance: `<ELO_BASE_URL>/rest/openapi.json`
- ELO IX Swagger UI: `<ELO_BASE_URL>/plugin/de.elo.ix.plugin.rest/swagger/ui/index.html`

## License

[CC BY-NC 4.0](LICENSE) — free to share and adapt with attribution, no
commercial use. See [`LICENSE`](LICENSE) for the full text.

## Contributing

Issues and pull requests welcome. By submitting a contribution you agree
that your work is licensed under the same CC BY-NC 4.0 terms.
