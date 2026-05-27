#!/bin/sh
set -e

: "${MCPO_API_KEY:?MCPO_API_KEY is required}"
: "${UPSTREAM_URL:?UPSTREAM_URL is required (e.g. http://elo-mcp-server:3000/mcp)}"
: "${UPSTREAM_SECRET:?UPSTREAM_SECRET is required}"

PORT="${MCPO_PORT:-8000}"
CONFIG_DIR="/tmp/cfg"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "elo": {
      "type": "streamable_http",
      "url": "${UPSTREAM_URL}",
      "headers": {
        "Authorization": "Bearer ${UPSTREAM_SECRET}"
      }
    }
  }
}
EOF

exec mcpo --port "$PORT" --api-key "$MCPO_API_KEY" --config "$CONFIG_FILE"
