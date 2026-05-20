# ELO MCP Server

Model Context Protocol (MCP) server providing **read-only** access to the ELO
document management system at Loupz. Exposes search, metadata, document links
and project-folder lookup as tools that LLM agents (Claude Desktop, Claude
Code, Notion-integrated agents, …) can call.

## Tools

| Tool | Purpose |
|---|---|
| `elo_search` | Full-text / index search across documents and folders |
| `elo_get_metadata` | Returns index fields, mask, owner and version info for an objId |
| `elo_get_document_link` | Builds an ELO webclient link and (when available) a short-lived download URL |
| `elo_find_project_folder` | Resolves a project folder by project number or name |

## Setup

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

### Environment variables

See [`.env.example`](.env.example).

- `ELO_BASE_URL` — IX REST base, e.g. `https://elo.loupz.de/ix-LOUPZ`
- `ELO_WEBCLIENT_URL` — webclient base used to build human-clickable links.
  **Verify once empirically**: open any document in the ELO web UI, copy the
  URL prefix.
- `ELO_USERNAME` / `ELO_PASSWORD` — technical user; read-only role recommended
- `ELO_LANGUAGE` / `ELO_COUNTRY` / `ELO_TIMEZONE` — defaults to `de` / `DE` / `UTC`
- `LOG_LEVEL` — pino level, default `info`

## Local testing with the MCP Inspector

```powershell
npm run build
npm run inspect
```

This opens a browser UI that lists every registered tool. Click through each
one against the live ELO instance. Suggested smoke flow:

1. `elo_search` with `query: "Vertrag"` → should return ≥1 result with correct
   `type: 'document' | 'folder'` classification.
2. Pick an `objId` from the result and call `elo_get_metadata` → `indexFields`
   must be populated.
3. For a document objId, call `elo_get_document_link` → open `eloLink` in the
   browser; should land on the right document.
4. `elo_find_project_folder` with a real Loupz project number → should return
   the matching folder with reconstructed `path`.

## Claude Desktop integration

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elo": {
      "command": "node",
      "args": ["C:\\Users\\dlehr\\elo-mcp-server\\dist\\index.js"],
      "env": {
        "ELO_BASE_URL": "https://elo.loupz.de/ix-LOUPZ",
        "ELO_WEBCLIENT_URL": "https://elo.loupz.de/elo-webclient",
        "ELO_USERNAME": "...",
        "ELO_PASSWORD": "..."
      }
    }
  }
}
```

Restart Claude Desktop. The four `elo_*` tools must appear in the tool list.

## Security & operational notes

- **MVP is read-only.** No write operations (`createSord`, `checkinSord`,
  `checkinDocBegin`, …) are exposed. Do not add them without a separate review.
- **Credentials never leave the process.** `.env` is git-ignored; logs are
  configured with pino redaction for `userPwd`, `Cookie`, `Authorization`.
- **Download URLs expire.** `elo_get_document_link` returns a `downloadUrl`
  that ELO IX validates for 1–10 minutes only. Do not persist or pass it to
  systems that store it long-term — use the `eloLink` for durable references.
- **Session refresh is automatic.** The client re-authenticates after 8
  minutes of idle time and once on `INVALID_SESSION [2001]`.
- **Folder/document classification** uses the ELO IX convention
  `sord.type < 254` = folder, `>= 254` = document. Do **not** check
  `sord.type === 5` — that's only one folder subtype.

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
5. **Health check** (optional): `GET /health` → returns 200.

### Wire up a remote client

The server listens at `POST /mcp` and `GET /mcp`. Authenticate with the
Bearer token on every request:

```
Authorization: Bearer <MCP_SHARED_SECRET>
```

For claude.ai Custom Connectors, use the `https://<your-domain>/mcp` URL.
For n8n / Make, configure the HTTP node likewise — Bearer header + JSON
body containing the MCP message.

### Security notes

- The HTTP endpoint is **public** once deployed. The shared-secret check
  uses `crypto.timingSafeEqual` to avoid timing leaks, but is only as
  strong as the secret itself — use ≥32 random bytes.
- Rotate `MCP_SHARED_SECRET` if it's exposed anywhere (logs, tickets, …).
- The server still reads from ELO read-only — no write tools are
  registered. The blast radius of a leaked token is read-access to your
  ELO contents through the configured technical user.
- Optionally restrict by source IP in Easypanel's Traefik labels if your
  callers come from a fixed set of addresses.

## Post-MVP

- Rate-limiting (`express-rate-limit`) and request audit logging on the
  HTTP transport.
- Per-client tokens with rotation, replacing the single shared secret.
- Optional OAuth (claude.ai connectors can do OAuth flows too).

## API references

- ELO IX OpenAPI: <https://elo.loupz.de/ix-LOUPZ/rest/openapi.json>
- ELO IX Swagger UI: <https://elo.loupz.de/ix-LOUPZ/plugin/de.elo.ix.plugin.rest/swagger/ui/index.html>
- ELO IX JavaDoc: <https://forum.elo.com/javadoc/ix/23/>
- MCP TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
