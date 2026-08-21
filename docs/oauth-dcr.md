# OAuth 2.1 with Dynamic Client Registration

How to let people connect this server with their **own ELO account** instead of
sharing one API key — and what that does and does not buy you.

## Why

Two problems, one answer.

**Clients want OAuth.** Notion Custom Connectors and claude.ai increasingly
expect "Sign in with OAuth" rather than a pasted bearer token. Until now the
only path was a shared secret, and the workaround suggested in
[docs/notion.md](./notion.md) was to put a proxy in front of the server.

**One account for everyone is the wrong permission model.** With a shared
secret, every request runs as the technical account, so every user sees
everything that account can see. The obvious fix — IX impersonation via
`runAsUser` — is refused by the live instance, systematically and without a
usable error message (see `BUGFIXES.md` #21).

Signing the user in directly sidesteps the whole problem. They authenticate to
IX themselves, so their session simply *is* their permissions.

## What happens when someone connects

```
  MCP client                    this server                         ELO IX
  ──────────                    ───────────                         ──────
      │  POST /mcp (no token)        │                                 │
      │─────────────────────────────►│                                 │
      │  401 + WWW-Authenticate      │                                 │
      │◄─────────────────────────────│   resource_metadata=…           │
      │                              │                                 │
      │  GET /.well-known/…          │  discovery                      │
      │◄────────────────────────────►│                                 │
      │  POST /register              │  RFC 7591 — client_id, no secret │
      │◄────────────────────────────►│                                 │
      │                              │                                 │
      │  browser → GET /authorize    │  login form (PKCE parked         │
      │─────────────────────────────►│  server-side under `txn`)        │
      │  POST /authorize  user + pw  │                                 │
      │─────────────────────────────►│  1. login  ────────────────────►│
      │                              │  2. one real read ─────────────►│
      │  302 …?code=…&state=…&iss=…  │◄─── session for THIS user        │
      │◄─────────────────────────────│                                 │
      │  POST /token  code+verifier  │                                 │
      │─────────────────────────────►│                                 │
      │  access_token + refresh      │                                 │
      │◄─────────────────────────────│                                 │
      │                              │                                 │
      │  POST /mcp  Bearer <jwt>     │  tool runs on the USER's session │
      │─────────────────────────────►│────────────────────────────────►│
```

Everything up to `/token` is standard OAuth 2.1: authorization code, PKCE with
S256, refresh tokens with rotation. The ELO-specific part is a single step —
what happens when the login form is submitted.

## Turning it on

```bash
MCP_TRANSPORT=http
MCP_AUTH_MODE=both          # or: oauth
PUBLIC_BASE_URL=https://core-elo-mcp-server.xapfa3.easypanel.host
OAUTH_TOKEN_SECRET=<32+ chars>
OAUTH_SESSION_SECRET=<32+ chars, different>
```

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`MCP_AUTH_MODE` decides what `/mcp` accepts:

| Mode | Shared secret | OAuth token | Use it when |
|---|---|---|---|
| `shared` *(default)* | yes | — | nothing changes; existing deployments are untouched by a redeploy |
| `both` | yes | yes | adding OAuth for Notion/claude.ai while n8n, Make and Open WebUI keep their API key |
| `oauth` | — | yes | every consumer has migrated |

`PUBLIC_BASE_URL` must match byte for byte what clients dial. It is the OAuth
issuer and the token audience; a trailing slash or the wrong scheme surfaces in
the client as an unexplained "issuer mismatch". The server strips a trailing
slash for you but cannot guess the host.

**`ELO_BASIC_AUTH_USER` / `ELO_BASIC_AUTH_PASS` matter now.** The nginx in front
of IX requires Basic Auth on every path except `/login`, and it expects the
technical account. End users authenticate to IX *inside* that, in the request
body. If your proxy credentials differ from `ELO_USERNAME`/`ELO_PASSWORD`, set
them explicitly — otherwise every user login fails at the proxy.

## Verifying the credentials

The login form does not just accept what it is given. Submitting it runs two
stages against ELO:

1. **`login`.** IX reports bad credentials as HTTP **200** with an `exception`
   body (`BUGFIXES.md` #1), so the response body is inspected, not the status.
2. **One real read** on the fresh session — the same `findFirstSords` path the
   tools use. This is what proves the session can actually do something rather
   than merely existing. An empty result counts as success: it means the call
   worked and this user sees nothing at the archive root.

Only then is the session stored and a code issued. Failures are classified,
because they have different audiences:

| What went wrong | Shown to the user | What to do |
|---|---|---|
| `[ELOIX:3008]` | "Benutzername oder Passwort ist falsch, oder das Konto ist gesperrt." | user retypes — IX does not distinguish these three cases, so neither does the message |
| Another IX rejection | "ELO hat die Anmeldung abgelehnt." | check the server log; a licence limit looks like this |
| Proxy returned 401/403 | "Der Server konnte sich nicht bei ELO ausweisen." | **not the user's fault** — check `ELO_BASIC_AUTH_*` |
| IX unreachable | "ELO ist derzeit nicht erreichbar." | check the network and `ELO_BASE_URL` |
| Signed in but cannot read | "Die Anmeldung wurde angenommen, aber der Zugriff auf ELO schlägt fehl." | the account exists but the session is unusable; check the server log |

Failed attempts are logged with the failure *kind* only. The attempted user name
is deliberately not logged: a password typed into the name field would otherwise
end up in the log in clear text.

## Where the credentials live

In memory, in a map keyed by an opaque session handle, and nowhere else.

They have to be kept: IX times a session out after about ten minutes, and
`EloClient` re-logins on demand — which it can only do while it still has the
password. That is the whole reason the vault exists.

What the client receives is an HS256 JWT. It is **signed, not encrypted**, so
every claim in it is readable by whoever holds it. It carries the user name, the
display name and the opaque `elo_sid` handle — never the password.

Consequences worth knowing before you deploy:

- **A restart logs everyone out.** Registrations, refresh tokens and sessions
  are all in memory. Clients re-register automatically; users see the login form
  again. Persisting this needs encryption at rest and is tracked separately in
  [#4](https://github.com/LOUPZ-DE/elo-mcp-server/issues/4).
- **An expired session is a 401, never a downgrade.** When a token's session is
  gone, the request is refused. It is never quietly served under the technical
  account — that would hand someone permissions they never had.
- **A password change ends the session.** The next background re-login fails,
  the session is dropped, and the client sends the user back through the form.
- **One IX session per signed-in user**, bounded by `ELO_MAX_USER_SESSIONS`
  (default 50) and `ELO_USER_SESSION_TTL` (default 8 h idle). Because IX reaps
  its own sessions after ~10 minutes and this server re-logins lazily, only
  *concurrently active* users occupy licences.

## Client setup

### Notion

`Settings → Notion AI → AI connectors → Add connector`. Enter
`https://<host>/mcp` and leave the token field empty — Notion discovers the
authorization server from the 401 and offers "Sign in". Requires a Business or
Enterprise workspace with Custom MCP servers enabled by an admin.

### claude.ai

`Settings → Connectors → Add custom connector`, same URL. It runs DCR and the
browser flow on its own.

### MCP Inspector (local check)

```powershell
npm run inspect
```

Point it at `https://<host>/mcp`, pick OAuth. It registers, opens the login
form, and lists the tools. The quickest way to confirm a deployment.

### Existing API-key clients

Nothing to do in `both` mode. n8n, Make and Open WebUI keep sending
`Authorization: Bearer <MCP_SHARED_SECRET>` and keep running as the technical
account.

## Testing

```powershell
npm run test:unit     # PKCE, JWT, cookie, verifier branches, error classification
npm run test:oauth    # the full flow against a stub IX — no ELO needed
npm run test:http     # the default mode still exposes no OAuth surface
```

`npm run test:oauth` is the interesting one. It stands up a stub IX that answers
a wrong password the way the real one does, records which ELO session made each
call, and then asserts the two things this design turns on: that a tool invoked
with a user's token runs on **that user's** IX session, and that the Basic Auth
presented to the proxy is still the **technical** account.

To see per-user permissions working against the real instance, list the same
folder as a full-access account and as a restricted one and compare.

## Known limits

Deliberate, and worth stating plainly:

- **No consent screen.** An existing login cookie authorizes a newly registered
  client without asking. Acceptable for an internal deployment where every
  client is one your own users added; not for a public one.
- **Scopes are parsed, not enforced.** There is one scope, `mcp`, and holding a
  token means holding it.
- **No CSRF token on the login form.** The 192-bit `txn` handle is the only
  thing tying a submission to a pending request.
- **Registration is unauthenticated**, per RFC 7591. Capped, not prevented.
- **The `resource` parameter is logged, not enforced.** Clients disagree on
  whether to send the origin, the `/mcp` URL, or neither, and rejecting the
  flow over it would be an opaque dead end. The audience minted is always
  `PUBLIC_BASE_URL/mcp` regardless, so this cannot widen a token.
- **No state persistence.** See above, and [#4](https://github.com/LOUPZ-DE/elo-mcp-server/issues/4).
