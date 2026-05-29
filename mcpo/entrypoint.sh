#!/bin/sh
set -e

: "${MCPO_API_KEY:?MCPO_API_KEY is required}"
: "${UPSTREAM_URL:?UPSTREAM_URL is required (e.g. http://elo-mcp-server:3000/mcp)}"
: "${UPSTREAM_SECRET:?UPSTREAM_SECRET is required}"

PORT="${MCPO_PORT:-8000}"

# Single-server mode: the OpenAPI spec is exposed at /openapi.json and tool
# endpoints at /<toolname> (no per-server prefix). This is the shape Open WebUI's
# "Tool Server" feature expects — its connection test GETs the URL and then
# auto-appends /openapi.json for discovery; both succeed against the root.
#
# (Multi-server mode with --config would expose the spec at /<server>/openapi.json,
# which is rejected by Open WebUI v0.9.x because <URL>/openapi.json gets
# rewritten to <URL>/openapi.json/openapi.json.)
exec mcpo \
  --port "$PORT" \
  --api-key "$MCPO_API_KEY" \
  --server-type streamable_http \
  --header "Authorization: Bearer $UPSTREAM_SECRET" \
  -- "$UPSTREAM_URL"
