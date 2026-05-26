# Notion integration

How to expose ELO data inside Notion. There are several paths; the right one
depends on the Notion plan tier and the use case.

## Which option fits?

| Path | What shows up in Notion | Notion plan | Auth | Effort |
|---|---|---|---|---|
| **A. Custom Connector (MCP)** | Notion AI / Q&A queries ELO directly, like a built-in connection (Slack, Drive, …) | Business / Enterprise | OAuth or Bearer | small |
| **B. Notion Agents → Custom Tool** | An agent calls the MCP tools in a workflow | Business / Enterprise | same as A | small-medium |
| **C. n8n / Make as ETL bridge** | Automation periodically calls `elo_search` and writes hits into a Notion database | any plan | Bearer | medium |
| **D. claude.ai Custom Connector** | claude.ai chats can query ELO, results pasted into Notion manually | claude.ai account | Bearer (or OAuth) | small, but no in-Notion lookup |

**A** is the natural path if Notion AI should query ELO live. **C** is the
most robust fallback if Notion-native MCP support is not available.

## Path A: Notion Custom Connector (MCP)

### Prerequisites

- **Notion workspace on a Business or Enterprise plan.** Custom Connectors
  are not part of Free or Plus. Check under `Settings → Plans`.
- **Workspace admin rights.** Regular members do not see the menu.
- **The MCP server runs publicly** with valid TLS and a `MCP_SHARED_SECRET`.
  See [README → Remote hosting (Easypanel)](../README.md).
- **Feature roll-out is active** in the workspace. Notion ships MCP features
  in waves — if the Help Center documents "MCP" / "Custom Connectors" but the
  UI menu is missing, the roll-out has not reached you yet.

### Steps

1. **In Notion:** `Settings & Members → Connections → Develop or manage
   custom connectors → "Add custom connector"`. The menu labels drift between
   Notion versions; search for "MCP", "Custom App", or "Connector".
2. **Type:** "MCP" / "Custom MCP server".
3. **URL:** `https://<your-elo-mcp-domain>/mcp`
4. **Authentication:**
   - **Bearer Token** (when offered): enter the `MCP_SHARED_SECRET`.
   - **OAuth** (when mandatory): see "OAuth requirement" below.
5. **Scopes / Permissions:** apply to the workspace where ELO should be
   available.
6. **Save / Connect.**

### Test in Notion

In any Notion page or AI panel, ask:

> Search ELO for "Contract".

Notion AI should call `elo_search` and list the hits. If it does not: check
Notion's activity log for whether the connector is invoked at all, and the
MCP server logs in Easypanel to see whether a request arrived.

### OAuth requirement

If Notion does **not** accept a Bearer token and insists on the OAuth 2.0
Authorization Code Flow, two workarounds:

1. **Put mcpo in between** (see [Open WebUI guide](./open-webui.md)). Some
   mcpo versions can proxy OAuth — Notion speaks OAuth with mcpo, mcpo
   speaks Bearer to the MCP server. Check the current mcpo docs.
2. **Add an OAuth endpoint to the MCP server.** Express routes for
   `/authorize` and `/token`, a static client (`client_id` /
   `client_secret`), and an in-memory authorization-code store — roughly
   150 lines, plus extra attack surface. Only worth doing if path 1 is
   blocked.

## Path B: Notion Agents

Notion Agents (sometimes called "Workflows") are autonomous AI sequences
that can call external tools. Once path A is set up, B is one click further:
the agent editor lets you reference an existing custom connection as a tool.

If Agents are available in the workspace, in the agent editor:

1. Add step → "Call tool".
2. Pick the "ELO" connector, then a specific tool (e.g. `elo_search`).
3. Map inputs from the agent context (page property, previous step output).
4. Store the output or feed it to the next step.

## Path C: n8n / Make as ETL bridge

If A/B are not available, this is the most robust fallback. The result is
**not a live lookup** — n8n syncs ELO data periodically into a Notion
database.

### Basic setup (n8n)

1. **HTTP Request node** in n8n:
   - Method: `POST`
   - URL: `https://<your-elo-mcp-domain>/mcp`
   - Authentication: Header Auth, name `Authorization`, value
     `Bearer <MCP_SHARED_SECRET>`
   - Body: MCP JSON-RPC envelope
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "elo_search",
         "arguments": { "query": "Contract", "maxResults": 50 }
       }
     }
     ```
2. **Function node** parses `result.content[0].text` (a JSON string with the
   tool output).
3. **Notion node** (with a Notion Integration Token):
   - Operation: "Create Database Page"
   - Database ID: the target database
   - Properties: name, objId, mask, last-changed, link (all from the MCP
     output).

### Trade-offs

- ✅ Works with any Notion plan (including Free), because it uses the
  standard Notion API with an Integration Token.
- ✅ Full audit trail via n8n logs.
- ❌ Data is a **copy**, not live. Changes in ELO appear only after the
  next n8n run.
- ❌ Schema changes (new mask, renamed index fields) must be reflected in
  the n8n mapping.

## Path D: claude.ai Custom Connector

If the primary use case is "I want to search ELO inside a chat and write
notes about the results", routing through Notion is overkill. Wire it up
directly in claude.ai:

1. claude.ai → Profile → **Connectors** → **Add Custom Connector**.
2. URL: `https://<your-elo-mcp-domain>/mcp`
3. Auth: Bearer, `MCP_SHARED_SECRET`.
4. Save. Tools appear automatically in every chat.

Pro: claude.ai supports MCP Custom Connectors officially and reliably.
Con: no integration with Notion tooling — copy/paste manually.

## Token hygiene

Just as important as for the other integration paths:

- **`MCP_SHARED_SECRET`** is the only thing protecting against unauthorised
  ELO lookups. Anyone with network access who has the token can run the full
  ELO search. Rotate it (change the Easypanel env, reconfigure
  Notion/claude.ai) if you suspect a leak.
- **Notion Integration Token** (path C) holds write rights in Notion —
  ≥32 random bytes, store it in n8n's credential manager, do not check it
  into workflow definitions.
- The MCP server is **read-only** in ELO — even a leaked token cannot mutate
  ELO data. Damage containment is baked in.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Add custom connector" menu is missing | Workspace below Business/Enterprise, or not an admin, or roll-out not yet active. |
| Notion shows "Authentication failed" when creating the connector | Bearer token wrong, or Notion requires OAuth. The MCP server log on Easypanel shows the 401 attempt. |
| Connector connected but tools never appear in chat | Discovery has not run. Ask a trivial ELO question in the chat ("what can you do in ELO?") to force the tool list to load. |
| Tool is called but returns empty results | The tool works, the query just has no hits in ELO. Test the same query in the local MCP Inspector. |
| n8n: HTTP request returns 401 | Bearer token missing or mistyped in the header-auth setup. |
