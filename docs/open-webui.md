# Open WebUI integration

How to make the ELO MCP server available as a tool inside
[Open WebUI](https://github.com/open-webui/open-webui).

Open WebUI 0.9 and later ship native MCP support in their **Tool Server**
feature, so there is nothing to put in between — Open WebUI speaks Streamable
HTTP directly to this server.

## Setup

**Admin Panel → Settings → Tools → Add Tool Server → Type: MCP**

| Field | Value |
|---|---|
| URL | `https://<your-elo-mcp-domain>/mcp` |
| API Key / Bearer | `MCP_SHARED_SECRET` (just the token, no `Bearer` prefix) |

That's it. The six `elo_*` tools appear in the chat tool palette automatically.

## Verify

```powershell
$Domain  = "<your-elo-mcp-domain>"
$Secret  = "<MCP_SHARED_SECRET>"
$Headers = @{ Authorization = "Bearer $Secret" }

# 1. The server is up (this endpoint needs no auth)
Invoke-RestMethod https://$Domain/health

# 2. It answers MCP and lists its tools
$Body = @{
  jsonrpc = "2.0"; id = 1; method = "tools/list"; params = @{}
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $Headers `
  -ContentType 'application/json' `
  -Headers ($Headers + @{ Accept = 'application/json, text/event-stream' }) `
  -Body $Body https://$Domain/mcp
```

From the Open WebUI chat you can then say "Search ELO for Contract" and the
assistant will call the tool on its own. A better first test, because it
exercises the intended workflow end to end:

> Which monthly reports are filed in project &lt;your project number&gt;, and what
> does the most recent one say?

## Token hygiene

One token: `MCP_SHARED_SECRET`, set on the ELO MCP service in Easypanel and
entered into Open WebUI. Generate it with ≥32 random bytes:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Everyone using Open WebUI shares that token, and therefore shares the technical
ELO account behind it — everybody sees whatever that account can see. If you
need results scoped per person, see [OAuth 2.1 + DCR](./oauth-dcr.md); it works
alongside the shared secret (`MCP_AUTH_MODE=both`), so adding it does not
disturb this setup.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Connection fails immediately | The URL must be the full `/mcp` path. Some UI builds prepend the scheme — make sure it reads exactly `https://<domain>/mcp`. |
| 401 on every call | The token in Open WebUI does not match `MCP_SHARED_SECRET` on the service. |
| A tool call returns an IX error (401/400) | The MCP server is alive but cannot reach ELO IX, or the credentials drifted. Check the MCP service logs in Easypanel. |
| A tool does not appear in the chat | Trigger tool discovery again — open the tool editor and save. |
| Open WebUI has no "MCP" server type | The build predates 0.9. Upgrade; the OpenAPI bridge that used to be documented here has been removed. |
