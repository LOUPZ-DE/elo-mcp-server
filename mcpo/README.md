# mcpo wrapper for Easypanel

Tiny wrapper around the official [`mcpo`](https://github.com/open-webui/mcpo)
image that builds the upstream-server configuration from environment
variables at container start. No volume mount or manual file upload needed
to host on Easypanel.

## Why this exists

Easypanel cannot mount a config file from outside the container or expose
an arbitrary entrypoint override on every plan. mcpo, however, requires a
JSON config file to declare its upstream MCP servers — config can include
custom headers (for Bearer auth) which the CLI single-server mode does not
support. This wrapper bridges the gap by writing the config to `/tmp/cfg`
at startup from env vars, then `exec`-ing into mcpo.

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
5. **Deploy.** mcpo starts, writes `/tmp/cfg/config.json` from env, connects
   to the upstream MCP server, exposes its tools at `https://<your-domain>/elo`.

## Local testing

```bash
docker build -t mcpo-bridge ./mcpo
docker run --rm \
  -p 8000:8000 \
  -e MCPO_API_KEY=test \
  -e UPSTREAM_URL=http://host.docker.internal:3000/mcp \
  -e UPSTREAM_SECRET=<elo-mcp-secret> \
  mcpo-bridge

curl -H "Authorization: Bearer test" http://localhost:8000/elo/openapi.json | jq .
```
