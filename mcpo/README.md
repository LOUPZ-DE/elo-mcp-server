# mcpo wrapper for Easypanel

Tiny wrapper around the official [`mcpo`](https://github.com/open-webui/mcpo)
image, started in **single-server mode** so the OpenAPI spec sits at
`/openapi.json` and tool endpoints at `/<toolname>`. This matches the URL
shape Open WebUI's "Tool Server" feature expects (URL → 200, URL/openapi.json
→ spec).

## Required environment

| Variable | Purpose |
|---|---|
| `MCPO_API_KEY` | Bearer token that clients (e.g. Open WebUI) must send to mcpo |
| `UPSTREAM_URL` | URL of the upstream MCP server, e.g. `http://elo-mcp-server:3000/mcp` |
| `UPSTREAM_SECRET` | Bearer token mcpo will send to the upstream MCP server |

Optional:

| Variable | Purpose |
|---|---|
| `MCPO_PORT` | HTTP port mcpo listens on, defaults to `8000` |

## Easypanel deployment

1. **Create App → Source: GitHub** (not Image), pick this repo.
2. **Build Path:** `/mcpo` so Easypanel finds the wrapper Dockerfile.
3. **Target Port:** `8000`.
4. **Environment:** set the three required env vars above.
5. **Deploy.** mcpo starts in single-server mode, connects to the upstream
   MCP server, exposes its tools at `https://<your-domain>/<toolname>` and
   the OpenAPI spec at `https://<your-domain>/openapi.json`.

## Open WebUI configuration

In Open WebUI → Admin → Settings → Integrations → Manage Tool Servers:

| Field | Value |
|---|---|
| URL | `https://<your-mcpo-domain>` (root, **no path**) |
| API Key | `MCPO_API_KEY` (just the token, no `Bearer ` prefix) |

Open WebUI fetches `<URL>/openapi.json` automatically and registers all
upstream MCP tools.

## Local testing

```bash
docker build -t mcpo-bridge ./mcpo
docker run --rm \
  -p 8000:8000 \
  -e MCPO_API_KEY=test \
  -e UPSTREAM_URL=http://host.docker.internal:3000/mcp \
  -e UPSTREAM_SECRET=<elo-mcp-secret> \
  mcpo-bridge

# Spec at root
curl -H "Authorization: Bearer test" http://localhost:8000/openapi.json | jq .

# Tool call
curl -H "Authorization: Bearer test" -H "Content-Type: application/json" \
  -X POST -d '{"query":"Vertrag","maxResults":3}' \
  http://localhost:8000/elo_search
```

## Note on multiple upstreams

This wrapper supports exactly **one** upstream MCP server. If you later
need to proxy multiple servers through one mcpo, switch to mcpo's multi-
server config mode (`--config` flag) — but be aware that Open WebUI's
Tool-Server feature only handles one server per registration, so you may
need to register each upstream separately anyway.
