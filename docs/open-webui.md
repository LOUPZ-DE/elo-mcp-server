# Open WebUI integration

How to make the ELO MCP server available as a tool inside
[Open WebUI](https://github.com/open-webui/open-webui). Two paths, pick the
one that matches your Open WebUI version.

## Path A: Direct MCP (recommended, Open WebUI ≥ 0.9)

Recent Open WebUI versions ship native MCP support in their **Tool Server**
feature. No bridge container needed — Open WebUI talks Streamable HTTP
directly to the ELO MCP server.

In Open WebUI: **Admin Panel → Settings → Tools → Add Tool Server →
Type: MCP**.

| Field | Value |
|---|---|
| URL | `https://<your-elo-mcp-domain>/mcp` |
| API Key / Bearer | `MCP_SHARED_SECRET` (just the token, no `Bearer` prefix) |

That's it. The four ELO tools appear in the chat tool palette automatically.

## Path B: OpenAPI via mcpo bridge (fallback, older Open WebUI)

For Open WebUI versions without the native MCP toggle, or for any other
OpenAPI-only consumer, deploy [`mcpo`](https://github.com/open-webui/mcpo)
in front of the ELO MCP server. mcpo introspects the MCP tools and
republishes them as OpenAPI endpoints.

The wrapper image in [`/mcpo`](../mcpo/) of this repo runs mcpo in
**single-server mode** so the spec sits at `/openapi.json` — Open WebUI's
discovery auto-appends `/openapi.json` to the URL, which fails against
multi-server mcpo (`/elo/openapi.json/openapi.json` → 404).

### Architecture

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

In OpenAPI mode, Open WebUI speaks REST + `openapi.json`, our server speaks
MCP — mcpo bridges the two.

### Prerequisites

1. **The MCP server runs on Easypanel** with `MCP_TRANSPORT=http`, a public
   HTTPS domain, and `MCP_SHARED_SECRET` set. See
   [README → Remote hosting (Easypanel)](../README.md).
2. **Open WebUI** runs somewhere reachable (its own host, cloud, or
   Easypanel).
3. Workspace admin rights in Open WebUI to add Tools/Connections.

### 1. Deploy the mcpo wrapper from this repo

**Easypanel → Create App → Source: GitHub** → `LOUPZ-DE/elo-mcp-server`,
branch `main`, **Build Path `/mcpo`**.

| Field | Value |
|---|---|
| Container port | `8000` |
| Domain | Easypanel auto-domain (e.g. `<project>-mcpo.<server>.easypanel.host`) or your own |
| Env | `MCPO_API_KEY=<random ≥32 bytes>` |
|     | `UPSTREAM_URL=http://elo-mcp-server:3000/mcp` (internal service name, no TLS hop) |
|     | `UPSTREAM_SECRET=<MCP_SHARED_SECRET of the ELO-MCP service>` |

The wrapper image runs mcpo in single-server mode — no config file or
volume needed. Three env vars and Easypanel does the rest. See
[mcpo/README.md](../mcpo/README.md) for the details.

### 2. Register the OpenAPI tool in Open WebUI

In Open WebUI: **Admin Panel → Settings → Tools → Add Tool Server →
Type: OpenAPI**.

| Field | Value |
|---|---|
| URL | `https://<your-mcpo-domain>` (root, no path) |
| API Key | `MCPO_API_KEY` (just the token, no `Bearer` prefix) |

Open WebUI fetches the OpenAPI schema from `<URL>/openapi.json` and exposes
each ELO tool as a function: `elo_search`, `elo_get_metadata`,
`elo_get_document_link`, `elo_find_project_folder`.

### 3. Verification

```powershell
$Domain  = "<your-mcpo-domain>"
$Key     = "<MCPO_API_KEY>"
$Headers = @{ Authorization = "Bearer $Key" }

# 1. mcpo is alive and serves the spec at root
Invoke-RestMethod https://$Domain/openapi.json | Select-Object -ExpandProperty info

# 2. Tool paths are present at root
(Invoke-RestMethod -Headers $Headers https://$Domain/openapi.json).paths.PSObject.Properties.Name
# expected: /elo_search, /elo_get_metadata, /elo_get_document_link, /elo_find_project_folder

# 3. End-to-end through the chain
$Body = @{ query = "Contract"; maxResults = 3 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $Headers -ContentType 'application/json' `
  -Body $Body https://$Domain/elo_search
```

If step 3 returns real Sord data, the chain works end-to-end. From the Open
WebUI chat you can then say "Search ELO for Contract" and the assistant will
call the tool on its own.

## Token hygiene

Direct MCP (Path A): one token only — `MCP_SHARED_SECRET`, set on the ELO
MCP service and entered into Open WebUI.

Bridge mode (Path B): two distinct tokens, each ≥32 random bytes:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Token | Protects | Where it lives |
|---|---|---|
| `MCP_SHARED_SECRET` | The MCP server | Easypanel env on the MCP service, **and** as `UPSTREAM_SECRET` on the mcpo service |
| `MCPO_API_KEY` | mcpo | Easypanel env on the mcpo service, and as the Bearer token in Open WebUI |
| Open WebUI user auth | Open WebUI itself | Open WebUI's own user management |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Direct MCP: connection fails immediately | URL must be the full `/mcp` path; some UI builds prepend the scheme — make sure it's exactly `https://<domain>/mcp`. |
| Bridge mode: `/openapi.json` is 404 or empty `paths` | mcpo is in multi-server mode; the wrapper in `/mcpo` here forces single-server mode to expose tools at root. Rebuild from the latest commit. |
| Bridge mode: `/elo_search` returns 401 | Bearer token in Open WebUI doesn't match mcpo's `MCPO_API_KEY`. |
| Either mode: tool call returns an IX error (401/400) | The MCP server is alive but cannot reach ELO IX, or credentials drifted. Inspect the MCP service logs in Easypanel. |
| Tool does not appear in the Open WebUI chat | Trigger tool discovery again — open the tool editor and save. |

## Security notes

- In bridge mode, `MCP_SHARED_SECRET` must **never** end up in mcpo logs.
  mcpo does not log headers by default, but `--debug` will.
- mcpo's `/openapi.json` is reachable **without auth** and lists the
  declared tool names. Avoid sensitive tool names if this matters.
- If mcpo and the MCP server live on the same Easypanel project, use the
  **internal Docker network** (`http://<service-name>:3000/mcp`) for
  `UPSTREAM_URL`. Saves a TLS hop and reduces the attack surface.
