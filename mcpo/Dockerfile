# syntax=docker/dockerfile:1.7
#
# Thin wrapper around the official mcpo image. Adds an entrypoint script that
# materializes /tmp/cfg/config.json from environment variables at container
# start, so no volume mount or file upload is needed in Easypanel.
#
# Required env vars at runtime:
#   MCPO_API_KEY    - Bearer token clients (Open WebUI, …) must send.
#   UPSTREAM_URL    - URL of the MCP server upstream, e.g.
#                     http://elo-mcp-server:3000/mcp  (internal Docker hostname)
#   UPSTREAM_SECRET - Bearer token mcpo sends to that upstream server.
#
# Optional:
#   MCPO_PORT       - HTTP port mcpo listens on (default 8000).

FROM ghcr.io/open-webui/mcpo:latest

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
