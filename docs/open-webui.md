# Open WebUI / OpenAPI-Anbindung

Anleitung, um den ELO-MCP-Server als Tool in [Open WebUI](https://github.com/open-webui/open-webui) verfügbar zu machen.

## Architektur

```
                                    Easypanel
                                  ┌─────────────────────────────────────────┐
   ┌──────────────┐               │  mcpo                ELO MCP Server     │
   │  Open WebUI  │ ── HTTPS ───► │  ghcr.io/open-webui  Dockerfile aus     │
   │  (anderswo)  │   Bearer:     │  /mcpo:latest        Repo               │
   └──────────────┘   <mcpo-key>  │     │                   ▲                │
                                  │     │   HTTPS Bearer:   │                │
                                  │     └── <elo-secret> ───┘                │
                                  └─────────────────────────────────────────┘
```

Hintergrund: Open WebUI versteht **OpenAPI** (REST + `openapi.json`), unser
Server spricht **MCP** (JSON-RPC über Streamable HTTP). Die offizielle Brücke
von Open WebUI ist [`mcpo`](https://github.com/open-webui/mcpo) — sie
introspectet die MCP-Tools und veröffentlicht sie als OpenAPI-Endpoints.

## Voraussetzungen

1. **ELO-MCP-Server läuft auf Easypanel** mit `MCP_TRANSPORT=http`,
   öffentlicher HTTPS-Domain und gesetztem `MCP_SHARED_SECRET`. Siehe
   [README → Remote hosting (Easypanel)](../README.md).
2. **Open WebUI** läuft irgendwo erreichbar (eigener Host, Cloud, Easypanel).
3. Workspace-Admin-Rechte in Open WebUI, um Tools/Connections hinzuzufügen.

## 1. mcpo-Service in Easypanel anlegen

**Easypanel → Create App → Source: Docker Image** (nicht GitHub-Repo).

| Feld | Wert |
|---|---|
| Image | `ghcr.io/open-webui/mcpo:latest` |
| Container Port | `8000` |
| Domain | `mcpo.<deine-domain>` (TLS automatisch) |
| Mount Volume | Persistent Volume `mcpo-config` → `/app/config` |
| Command (Args) | `--port 8000 --api-key $MCPO_API_KEY --config /app/config/config.json` |
| Env | `MCPO_API_KEY=<random ≥32 bytes>` |

### Config-Datei

`/app/config/config.json` über den Easypanel-File-Browser hochladen:

```json
{
  "mcpServers": {
    "elo": {
      "type": "streamable_http",
      "url": "https://elo-mcp.<deine-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_SHARED_SECRET>"
      }
    }
  }
}
```

`MCP_SHARED_SECRET` ist der Wert, den der ELO-MCP-Service als Env hat — **nicht**
derselbe wie `MCPO_API_KEY`. Zwei verschiedene Tokens für zwei verschiedene
Auth-Hops.

> ⚠️ Die Schlüsselnamen in der mcpo-Config (`streamable_http`, `streamable-http`,
> `sse`) variieren zwischen mcpo-Versionen. Wenn nach dem ersten Start im
> mcpo-Log eine „unknown transport type"-Meldung erscheint, in den
> [mcpo-Docs](https://github.com/open-webui/mcpo) den aktuellen Schlüsselnamen
> nachschlagen und anpassen.

## 2. Tool in Open WebUI registrieren

In Open WebUI, je nach Version unter **Admin Panel → Settings → Tools**
(manche Versionen: **Connections → OpenAPI Tools**):

| Feld | Wert |
|---|---|
| URL | `https://mcpo.<deine-domain>/elo` |
| Type | OpenAPI |
| API Key / Auth | `MCPO_API_KEY`, als Bearer-Header |

Open WebUI zieht das OpenAPI-Schema von `https://mcpo.<deine-domain>/elo/openapi.json`
und macht aus jedem ELO-Tool eine Funktion: `elo_search`, `elo_get_metadata`,
`elo_get_document_link`, `elo_find_project_folder`.

## 3. Verifikation

```bash
# 1. mcpo lebt und liefert das OpenAPI-Index
curl -sf https://mcpo.<deine-domain>/openapi.json | jq '.info.title'

# 2. mcpo sieht ELO-MCP und mappt die Tools
curl -sf -H "Authorization: Bearer $MCPO_API_KEY" \
  https://mcpo.<deine-domain>/elo/openapi.json | jq '.paths | keys'
# erwartete Pfade: /elo_search, /elo_get_metadata, /elo_get_document_link, /elo_find_project_folder

# 3. End-to-end durchgereicht
curl -sf -X POST https://mcpo.<deine-domain>/elo/elo_search \
  -H "Authorization: Bearer $MCPO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Vertrag","maxResults":3}'
```

Wenn `3.` echte Sord-Daten zurückgibt, ist die Kette komplett. Im Open-WebUI-Chat
lässt sich dann „Suche in ELO nach Vertrag" abfragen und der Assistent ruft das
Tool eigenständig auf.

## Token-Hygiene

Drei Tokens sind im Spiel — alle verschieden, jeweils ≥32 random Bytes:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Token | Schützt | Wo gesetzt |
|---|---|---|
| `MCP_SHARED_SECRET` | ELO-MCP | Easypanel-Env am ELO-MCP-Service, **und** im Authorization-Header in mcpo's `config.json` |
| `MCPO_API_KEY` | mcpo | Easypanel-Env am mcpo-Service, in Open WebUI als Bearer-Token |
| Open WebUI User-Auth | Open WebUI selbst | Open WebUI-eigene User-Verwaltung |

## Troubleshooting

| Symptom | Wahrscheinliche Ursache |
|---|---|
| `mcpo` startet, aber `/elo/openapi.json` ist 404 | mcpo erreicht ELO-MCP nicht — URL oder Token falsch. Im mcpo-Log nach Connect-Fehlern suchen. |
| `unknown transport type` im mcpo-Log | mcpo-Version verwendet anderen Schlüssel als `streamable_http`. Aktuelle mcpo-Docs prüfen. |
| `/elo/elo_search` liefert 401 | Falsche oder fehlende `Authorization: Bearer`-Header. mcpo's `--api-key` muss übereinstimmen. |
| `/elo/elo_search` liefert IX-Fehler 401/400 | ELO-MCP läuft, aber kann ELO-IX nicht erreichen oder Credentials sind weg. ELO-MCP-Logs in Easypanel prüfen. |
| Tool taucht in Open WebUI nicht im Chat auf | Tool-Discovery in Open WebUI explizit neu triggern (Tool-Editor öffnen, speichern). |

## Sicherheitsnotizen

- `MCP_SHARED_SECRET` darf **nirgendwo** im mcpo-Service in Logs landen. mcpo
  loggt Headers nicht standardmäßig, aber bei `--debug` schon.
- mcpo's `/openapi.json` ohne den Server-Namen ist **öffentlich** ohne Auth
  erreichbar und listet die registrierten Server-Namen auf. Bei sensitiven
  Servernamen darauf achten.
- mcpo und ELO-MCP im selben Easypanel: alternativ über das **interne
  Docker-Netz** (`http://<service-name>:3000/mcp`) statt über die Public-Domain
  ansprechen. Spart einen TLS-Hop, reduziert Angriffsfläche.
