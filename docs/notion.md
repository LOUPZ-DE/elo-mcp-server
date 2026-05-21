# Notion-Anbindung

Anleitung, um ELO-Daten in Notion verfügbar zu machen. Notion bietet mehrere
Pfade — die richtige Wahl hängt vom Notion-Plan und vom Anwendungsfall ab.

## Welche Option passt?

| Weg | Was in Notion sichtbar wird | Notion-Plan | Auth | Aufwand |
|---|---|---|---|---|
| **A. Custom Connector (MCP)** | Notion AI / Q&A fragt ELO direkt wie eine eingebaute Connection (Slack, Drive, …) | Business / Enterprise | OAuth oder Bearer | klein |
| **B. Notion Agents → Custom Tool** | Agent ruft die MCP-Tools im Workflow auf | Business / Enterprise | wie A | klein-mittel |
| **C. n8n / Make als ETL-Brücke** | Automation ruft `elo_search` periodisch und schreibt Treffer in Notion-DB | jeder Plan | Bearer | mittel |
| **D. claude.ai Custom Connector** | claude.ai-Chats können ELO abfragen, Ergebnisse manuell in Notion einfügen | claude.ai-Konto | Bearer (oder OAuth) | klein, aber kein direkter Notion-Lookup |

**A** ist der natürliche Pfad, wenn Notion-AI ELO live abfragen können soll. **C**
ist der robusteste Fallback, wenn Notion-MCP nicht verfügbar ist oder nicht
gewünscht.

## Weg A: Notion Custom Connector (MCP)

### Voraussetzungen

- **Notion-Workspace auf Business- oder Enterprise-Plan**. Custom Connectors
  sind kein Free/Plus-Feature. Prüfen unter `Settings → Plans`.
- **Workspace-Admin-Rechte**. Reguläre Mitglieder sehen das Menü nicht.
- **ELO-MCP-Server läuft öffentlich** mit gültigem TLS und `MCP_SHARED_SECRET`.
  Siehe [README → Remote hosting (Easypanel)](../README.md).
- **Rollout aktiv** im Workspace. Notion verteilt MCP-Features wellenartig —
  wenn die Help-Center-Doku zu „MCP" / „Custom Connectors" existiert, das
  UI-Menü aber fehlt, ist der Rollout noch nicht da.

### Schritte

1. **In Notion:** `Settings & Members → Connections` → „Develop or manage
   custom connectors" → **„Add custom connector"** (Menü-Bezeichnungen
   wechseln zwischen Notion-Versionen, suche nach „MCP", „Custom App",
   „Connector").
2. **Type:** „MCP" / „Custom MCP server".
3. **URL:** `https://elo-mcp.<deine-domain>/mcp`
4. **Authentication:**
   - **Bearer Token** (wenn angeboten): `MCP_SHARED_SECRET` eintragen.
   - **OAuth** (wenn zwingend): siehe Abschnitt „OAuth-Pflicht" unten.
5. **Scopes / Permissions:** auf den Workspace anwenden, in dem ELO verfügbar
   sein soll.
6. **Save / Connect.**

### Test in Notion

In einer Notion-Seite oder einem AI-Panel fragen:

> Suche in ELO nach „Vertrag".

Notion AI sollte das Tool `elo_search` aufrufen und die Treffer als Antwort
listen. Wenn nicht: in Notion's Activity-Log nachsehen, ob der Connector
überhaupt aufgerufen wird, und parallel im ELO-MCP-Easypanel-Service nach
Request-Logs schauen.

### OAuth-Pflicht

Falls Notion **kein** Bearer-Token akzeptiert, sondern OAuth 2.0 Authorization
Code Flow verlangt, gibt es zwei Wege:

1. **mcpo dazwischen schalten** ([siehe Open-WebUI-Anleitung](./open-webui.md)).
   mcpo kann je nach Version OAuth-Proxying — Notion redet OAuth mit mcpo,
   mcpo redet Bearer mit ELO-MCP. Aktuelle mcpo-Docs prüfen, ob die Version
   das schon kann.
2. **OAuth direkt im ELO-MCP-Server einbauen.** Express-Routen für
   `/authorize` und `/token`, plus statischer Client (`client_id` /
   `client_secret`), plus In-Memory-Authorization-Code-Store. ~150 Zeilen,
   aber zusätzliche Sicherheitsfläche. Sollten wir nur bauen, wenn Weg 1
   wirklich ausscheidet.

## Weg B: Notion Agents

Notion Agents (in einigen Workspaces auch „Workflows") sind autonome
AI-Sequenzen, die externe Tools aufrufen können. Wenn Weg A funktioniert,
ist B nur einen Knopfdruck weiter: Der Agent-Editor erlaubt es, eine
existierende Custom-Connection als Tool zu referenzieren.

Wenn Agents in deinem Workspace verfügbar sind, im Agent-Editor:

1. Schritt hinzufügen → „Tool aufrufen".
2. Connector „ELO" wählen, Tool z. B. `elo_search`.
3. Input-Mapping aus dem Agent-Kontext (Page-Property, vorheriger Schritt).
4. Output speichern oder weiterverarbeiten.

## Weg C: n8n / Make als ETL-Brücke

Wenn Weg A/B nicht verfügbar sind, ist das der robusteste Fallback. Ergebnis
ist allerdings **kein Live-Lookup** — n8n syncht ELO-Daten periodisch in eine
Notion-Datenbank.

### Grundsetup (n8n)

1. **HTTP Request Node** in n8n:
   - Method: `POST`
   - URL: `https://elo-mcp.<deine-domain>/mcp`
   - Authentication: Header Auth, Name `Authorization`, Value `Bearer <MCP_SHARED_SECRET>`
   - Body: MCP JSON-RPC envelope
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "elo_search",
         "arguments": { "query": "Vertrag", "maxResults": 50 }
       }
     }
     ```
2. **Function Node** parst `result.content[0].text` (JSON-String mit der
   Tool-Ausgabe).
3. **Notion Node** (mit Notion Integration Token):
   - Operation: „Create Database Page"
   - Database ID: ID der Ziel-Datenbank
   - Properties: Name, objId, Mask, Last-Changed, Link (alle aus dem MCP-Output).

### Vor- und Nachteile

- ✅ Funktioniert mit jedem Notion-Plan (auch Free), weil hier die normale
  Notion-API + Integration Token genutzt wird.
- ✅ Voller Audit-Trail durch n8n-Logs.
- ❌ Daten sind eine **Kopie**, nicht live. Bei Änderungen in ELO erst nach
  dem nächsten n8n-Run sichtbar.
- ❌ Schema-Änderungen (neue Maske, umbenannte Indexfelder) müssen im
  n8n-Mapping nachgezogen werden.

## Weg D: claude.ai Custom Connector

Wenn der primäre Use-Case ist „ich will im Chat ELO durchsuchen und Notizen
machen", lohnt sich der Umweg über Notion gar nicht. Direkt in claude.ai
einbinden:

1. claude.ai → Profile → **Connectors** → **Add Custom Connector**.
2. URL: `https://elo-mcp.<deine-domain>/mcp`
3. Auth: Bearer, `MCP_SHARED_SECRET`.
4. Save. Tools tauchen in jedem Chat automatisch auf.

Vorteil: claude.ai unterstützt MCP-Custom-Connectors offiziell und stabil.
Nachteil: keine Integration ins Notion-Tooling — du musst manuell
copy/pasten.

## Token-Hygiene

Sicherheitsgleich wichtig wie bei den anderen Connection-Pfaden:

- **`MCP_SHARED_SECRET`** ist der einzige Schutz vor unautorisierten ELO-Lookups.
  Mit dem Token kann jeder mit Netzzugang die volle ELO-Suche aufrufen. Bei
  Verdacht auf Leak rotieren (Easypanel-Env ändern, Notion/claude.ai-Connector
  neu konfigurieren).
- **Notion Integration Token** (Weg C) hat Notion-Schreibrechte — ebenfalls
  ≥32 random Bytes, in n8n's Credential-Manager speichern, nicht in
  Workflow-Definitionen einchecken.
- ELO-MCP selbst ist **read-only** — auch wenn ein Token leakt, kann
  niemand Daten in ELO ändern. Schadensbegrenzung schon eingebaut.

## Troubleshooting

| Symptom | Wahrscheinliche Ursache |
|---|---|
| „Add custom connector"-Menü fehlt | Workspace-Plan unter Business/Enterprise, oder kein Admin, oder Rollout noch nicht aktiv. |
| Notion zeigt „Authentication failed" beim Connector-Anlegen | Bearer-Token falsch eingegeben, oder Notion fordert OAuth. ELO-MCP-Log auf Easypanel zeigt 401-Treffer von Notion. |
| Connector verbunden, aber Tools tauchen im Chat nicht auf | Discovery noch nicht durchgelaufen. In Notion eine triviale ELO-Frage stellen („was kannst du in ELO?"), das zwingt die Tool-Liste zu laden. |
| Tool wird aufgerufen, liefert aber leeres Result | ELO-MCP-Tool funktioniert, aber für die konkrete Anfrage keine Treffer in ELO. In MCP-Inspector (lokal) gegen denselben Query testen. |
| n8n: HTTP-Request endet mit 401 | Bearer-Token im Header-Auth-Setup vergessen oder mit Tippfehler. |
