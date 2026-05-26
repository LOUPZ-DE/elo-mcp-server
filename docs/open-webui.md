# Open WebUI / OpenAPI integration

How to make the ELO MCP server available as a tool inside
[Open WebUI](https://github.com/open-webui/open-webui).

## Architecture

```
                                    Easypanel
                                  ┌─────────────────────────────────────────┐
   ┌──────────────┐               │  mcpo                ELO MCP Server     │
   │  Open WebUI  │ ── HTTPS ───► │  ghcr.io/open-webui  Dockerfile from    │
   │  (elsewhere) │   Bearer:     │  /mcpo:latest        this repo          │
   └──────────────┘   <mcpo-key>  │     │                   ▲                │
                                  │     │   HTTPS Bearer:   │                │
                                  │     └── <elo-secret> ───┘                │
                                  └─────────────────────────────────────────┘
```

Background: Open WebUI speaks **OpenAPI** (REST + `openapi.json`), our
server speaks **MCP** (JSON-RPC over Streamable HTTP). Open WebUI's official
bridge is [`mcpo`](https://github.com/open-webui/mcpo) — it introspects the
MCP tools and republishes them as OpenAPI endpoints.

## Prerequisites

1. **The MCP server runs on Easypanel** with `MCP_TRANSPORT=http`, a public
   HTTPS domain, and `MCP_SHARED_SECRET` set. See
   [README → Remote hosting (Easypanel)](../README.md).
2. **Open WebUI** runs somewhere reachable (its own host, cloud, or
   Easypanel).
3. Workspace admin rights in Open WebUI to add Tools/Connections.

## 1. Deploy mcpo as a separate Easypanel service

**Easypanel → Create App → Source: Docker Image** (not GitHub repo).

| Field | Value |
|---|---|
| Image | `ghcr.io/open-webui/mcpo:latest` |
| Container port | `8000` |
| Domain | `mcpo.<your-domain>` (TLS handled automatically) |
| Mounted volume | Persistent volume `mcpo-config` → `/app/config` |
| Command (args) | `--port 8000 --api-key $MCPO_API_KEY --config /app/config/config.json` |
| Env | `MCPO_API_KEY=<random ≥32 bytes>` |

### Config file

Upload `/app/config/config.json` through Easypanel's file browser:

```json
{
  "mcpServers": {
    "elo": {
      "type": "streamable_http",
      "url": "https://<your-elo-mcp-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_SHARED_SECRET>"
      }
    }
  }
}
```

`MCP_SHARED_SECRET` is the value set as an env on the ELO MCP service —
**not** the same as `MCPO_API_KEY`. Two distinct tokens for two distinct
auth hops.

> ⚠️ The transport type key in mcpo's config (`streamable_http`,
> `streamable-http`, `sse`) varies between mcpo versions. If the mcpo log
> shows "unknown transport type" after the first start, check the current
> [mcpo docs](https://github.com/open-webui/mcpo) for the right key name.

## 2. Register the tool in Open WebUI

In Open WebUI, depending on the version, under **Admin Panel → Settings →
Tools** (some versions: **Connections → OpenAPI Tools**):

| Field | Value |
|---|---|
| URL | `https://mcpo.<your-domain>/elo` |
| Type | OpenAPI |
| API Key / Auth | `MCPO_API_KEY`, as a Bearer header |

Open WebUI fetches the OpenAPI schema from
`https://mcpo.<your-domain>/elo/openapi.json` and exposes each ELO tool as a
function: `elo_search`, `elo_get_metadata`, `elo_get_document_link`,
`elo_find_project_folder`.

## 3. Verification

```bash
# 1. mcpo is alive and serves the OpenAPI index
curl -sf https://mcpo.<your-domain>/openapi.json | jq '.info.title'

# 2. mcpo sees the ELO MCP server and maps its tools
curl -sf -H "Authorization: Bearer $MCPO_API_KEY" \
  https://mcpo.<your-domain>/elo/openapi.json | jq '.paths | keys'
# expected paths: /elo_search, /elo_get_metadata, /elo_get_document_link, /elo_find_project_folder

# 3. End-to-end through the chain
curl -sf -X POST https://mcpo.<your-domain>/elo/elo_search \
  -H "Authorization: Bearer $MCPO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Contract","maxResults":3}'
```

If step 3 returns real Sord data, the chain works end-to-end. From the Open
WebUI chat you can then say "Search ELO for Contract" and the assistant will
call the tool on its own.

## Token hygiene

Three tokens are in play — all distinct, each ≥32 random bytes:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Token | Protects | Where it lives |
|---|---|---|
| `MCP_SHARED_SECRET` | The MCP server | Easypanel env on the MCP service, **and** as the Authorization header value inside mcpo's `config.json` |
| `MCPO_API_KEY` | mcpo | Easypanel env on the mcpo service, and as the Bearer token in Open WebUI |
| Open WebUI user auth | Open WebUI itself | Open WebUI's own user management |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `mcpo` starts but `/elo/openapi.json` is 404 | mcpo cannot reach the MCP server — URL or token wrong. Look at the mcpo log for connect errors. |
| `unknown transport type` in the mcpo log | mcpo version uses a different key than `streamable_http`. Check current mcpo docs. |
| `/elo/elo_search` returns 401 | Wrong or missing `Authorization: Bearer` header. mcpo's `--api-key` must match. |
| `/elo/elo_search` returns an IX error (401/400) | The MCP server is alive but cannot reach ELO IX, or credentials drifted. Inspect the MCP service logs in Easypanel. |
| Tool does not appear in the Open WebUI chat | Trigger tool discovery again — open the tool editor and save. |

## Security notes

- `MCP_SHARED_SECRET` must **never** end up in mcpo logs. mcpo does not log
  headers by default, but `--debug` will.
- mcpo's `/openapi.json` (without a server name) is reachable **without
  auth** and lists registered server names. Avoid sensitive server names.
- If mcpo and the MCP server live on the same Easypanel host, prefer the
  **internal Docker network** (`http://<service-name>:3000/mcp`) over the
  public domain. Saves a TLS hop and reduces the attack surface.
