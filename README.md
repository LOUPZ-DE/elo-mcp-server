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
| `elo_search` | Full-text and index-field search across documents and folders |
| `elo_get_metadata` | Returns index fields, mask, owner, and version info for a given `objId` |
| `elo_get_document_link` | Builds a web-client link and (when available) a short-lived download URL |
| `elo_find_project_folder` | Resolves a project folder by project number or name |

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
| `ELO_PROJECT_NUMBER_FIELD` | Index-field name that holds the project number. Default `PRJ_NO` |
| `ELO_LANGUAGE` / `ELO_COUNTRY` / `ELO_TIMEZONE` | ClientInfo defaults |
| `MCP_TRANSPORT` | `stdio` (default) or `http` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP transport bind address (default `0.0.0.0:3000`) |
| `MCP_SHARED_SECRET` | Required when `MCP_TRANSPORT=http`. Bearer token for the HTTP transport |
| `LOG_LEVEL` | pino level, default `info` |

## Local testing with the MCP Inspector

```powershell
npm run build
npm run inspect
```

This opens a browser UI listing every registered tool. Suggested smoke flow:

1. `elo_search` with a query you expect hits for → results with correct
   `type: 'document' | 'folder'` classification.
2. Pick an `objId` from the result and call `elo_get_metadata` → `indexFields`
   must be populated.
3. For a document `objId`, call `elo_get_document_link` → open `eloLink` in the
   browser; should land on the right document.
4. `elo_find_project_folder` with a real project number → matching folder with
   reconstructed `path`.

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

Restart Claude Desktop. The four `elo_*` tools must appear in the tool list.

## Client integrations

Step-by-step guides for the most common integration paths:

- [Open WebUI / OpenAPI (via mcpo)](docs/open-webui.md)
- [Notion (Custom Connector, Agents, n8n bridge, claude.ai)](docs/notion.md)

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
- Optionally restrict by source IP in Easypanel's Traefik labels if your
  callers come from a fixed set of addresses.

## Architecture and operational notes

- **MVP is read-only.** No write operations (`createSord`, `checkinSord`,
  `checkinDocBegin`, …) are exposed. Do not add them without a separate
  review.
- **Credentials never leave the process.** `.env` is git-ignored; logs are
  configured with pino redaction for `userPwd`, `Cookie`, `Authorization`.
- **Download URLs expire.** `elo_get_document_link` returns a `downloadUrl`
  that ELO IX validates for 1–10 minutes only. Do not persist or pass it to
  systems that store it long-term — use the `eloLink` for durable
  references.
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

- Rate-limiting (`express-rate-limit`) and request audit logging on the HTTP
  transport.
- Per-client tokens with rotation, replacing the single shared secret.
- Optional OAuth flow for clients that require it (Notion Custom Connectors,
  claude.ai).

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
