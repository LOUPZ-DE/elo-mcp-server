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

A better first test, because it exercises the intended workflow end to end:

> Which monthly reports are filed in project &lt;your project number&gt;, and what
> does the most recent one say?

That should produce `elo_find_project_folder` → `elo_list_folder` →
`elo_get_document_content`, with links carrying the project path.

## What this connector does and does not do

Worth setting out before a pilot, because two expectations come up every time.

**Document text, not document files.** `elo_get_document_content` returns the
extracted *text* of a PDF or Word file. Notion consumes text from tool results;
there is no mechanism by which an MCP tool result becomes a file attachment or
a Notion file block. A literal 1:1 import of the original PDF/DOCX into Notion
requires Notion's file-upload API driven by an ETL job — that is Path C below,
not Path A. Ask for "summarise / extract / quote from this document" rather
than "import this document".

**Scanned documents cannot be read.** A PDF that is a photograph of paper has
no text layer. The tool detects this and says so (`textLayer: "none"`) instead
of returning empty text; open the `eloLink` to view it. No OCR is performed.

**The connector is bound to whatever you attached it to.** Notion scopes custom
connectors per agent — an assistant that does not have the ELO connector
attached cannot reach ELO, even in a workspace where the connector exists, and
it cannot open ELO links on your behalf either. If a prompt yields "ELO is not
reachable in this chat", the fix is to address the agent that holds the
connector, e.g.:

> @ELO MCP Connector (BETA) — use this agent to fetch the information from ELO.

This is a Notion product boundary, not a server-side limitation.

**Links open the ELO client, not a browser view.** With
`ELO_WEBCLIENT_URL=https://elo-link.loupz.de`, an `eloLink` redirects to
`elodms://<objId>`, a protocol handler that opens the installed ELO desktop
client. For recipients without it, the link does nothing. If your installation
has a browser-accessible web client, point `ELO_WEBCLIENT_URL` at it instead —
every tool builds its links from that one value.

### OAuth requirement

If Notion does not accept a Bearer token and insists on "Sign in with OAuth",
the server can do that itself — set `MCP_AUTH_MODE=both` and give it a public
base URL and two signing secrets. Notion then registers itself, the user gets a
login form, and their ELO credentials are checked against ELO.

Two things follow from that, and the second is the more interesting one:

- Nobody has to paste a token.
- Every tool call runs under **that user's** ELO permissions, instead of the
  technical account's. Which is the only way to get per-user permissions here at
  all — IX impersonation is refused by the live instance (`BUGFIXES.md` #21).

Setup, limits and the reasoning: **[OAuth 2.1 + DCR](./oauth-dcr.md)**.

The shared secret keeps working alongside it, so n8n, Make and Open WebUI need
no change.

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

   > **Changed in 0.2.0:** tool results are envelope objects, not bare arrays.
   > The hits live under `.results`, alongside `truncated`, `note` and — for
   > searches — `scope` and `engine`. Update any existing mapping from
   > `parsed.map(…)` to `parsed.results.map(…)`.

3. **Notion node** (with a Notion Integration Token):
   - Operation: "Create Database Page"
   - Database ID: the target database
   - Properties: name, objId, path, mask, last-changed, link — take the link
     from `eloLink` verbatim rather than assembling it.

### This is the path for actual file import

Path C is the only route that can put the original PDF or Word file into Notion
as a file, because it can call Notion's file-upload API — which an MCP tool
result cannot reach. Sketch:

1. `elo_search` / `elo_list_folder` → the objIds you want.
2. `elo_get_document_link` → `downloadUrl`. Note it is session-bound and expires
   within minutes, so n8n must fetch it immediately and with the same
   credentials; it is not a URL you can hand to Notion.
3. n8n downloads the bytes, then uploads them to Notion.

If you only need the *content* (summaries, quotes, extracted figures), skip all
of this and use `elo_get_document_content` from Path A.

### Trade-offs

- ✅ Works with any Notion plan (including Free), because it uses the
  standard Notion API with an Integration Token.
- ✅ The only path that can attach real files.
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
