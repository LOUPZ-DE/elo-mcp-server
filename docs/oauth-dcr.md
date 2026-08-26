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

- **Without `STATE_FILE`, a restart logs everyone out** — and worse, leaves
  clients stuck. See "Surviving a redeploy" below; configure it.
- **An expired session is a 401, never a downgrade.** When a token's session is
  gone, the request is refused. It is never quietly served under the technical
  account — that would hand someone permissions they never had.
- **A password change ends the session.** The next background re-login fails,
  the session is dropped, and the client sends the user back through the form.
- **At least one IX session per signed-in user**, bounded by
  `ELO_MAX_USER_SESSIONS` (default 50) and `ELO_USER_SESSION_TTL`.
  `EloClient` re-logins every 8 minutes of use and does not log the previous
  session out, so an abandoned session lingers until IX reaps it. How many pile
  up therefore depends on the IX session timeout, which is configured in ELO,
  not by us: at the 10 minutes this code was written against, roughly one; at a
  one-hour timeout, up to seven or eight per continuously active user. Check
  your instance's setting before sizing `ELO_MAX_USER_SESSIONS` against a
  licence count.

## Surviving a redeploy

Configure this. Without it, every deploy strands your users.

```bash
STATE_FILE=/data/state.json
STATE_ENCRYPTION_KEY=<32 bytes, different from the two secrets above>
```

Easypanel: mount a volume at `/data`. The image creates the directory owned by
the `node` user, so a *named* volume works out of the box. A *bind mount* keeps
the host directory's ownership — if that is root, the server refuses to start
rather than discovering the problem at the next restart, when the state would
already be gone.

### Why it matters more than it looks

Registrations, refresh tokens and signed-in sessions all live in memory. Losing
the refresh tokens and sessions is recoverable on its own: the client gets a 401
from `/mcp` and runs the flow again.

Losing the **registrations** is not. A client that stored its `client_id` —
Notion and claude.ai both do — presents it at `/authorize` and gets

> Diese Anwendung ist nicht (mehr) registriert.

on an error page that renders **in the browser**. The client never sees it, so
nothing re-registers. Somebody has to delete and re-add the connector, after
every single deploy.

### What is in the file

`clients`, `refreshTokens`, and the credential vault — ELO user names and
passwords. Authorization codes and half-finished logins are not: both expire
faster than a restart takes.

The whole file is one AES-256-GCM message. GCM because it is AEAD: a tampered
file fails authentication instead of loading quietly. Written `0600` into a
`0700` directory, via a temp file and an atomic rename, one second after the
first change in a burst — and flushed immediately on `SIGTERM`, which is what a
redeploy sends.

**The trade-off, stated plainly:** real ELO passwords now sit encrypted on a
volume. Whoever holds both the file and the key holds the accounts. Treat
`STATE_ENCRYPTION_KEY` like the passwords it protects, and keep it out of the
same place you keep backups of the volume.

### Keys

Separate from `OAUTH_TOKEN_SECRET` and `OAUTH_SESSION_SECRET`, and the server
refuses to start if you reuse either — leaking a signing key must not also hand
over the vault.

Rotating the key makes the existing file unreadable. That is not destructive:
it is renamed to `state.json.unreadable-<timestamp>` and the server starts
empty, so clients re-register and users sign in once. Restore the old key and
rename the file back if the rotation was a mistake.

### One instance only

Every save writes the complete state, so two replicas on one volume would take
turns discarding each other's registrations. The server logs this requirement
at boot whenever persistence is on.

One instance *at a time* still overlaps during a rolling redeploy: the
replacement boots before the outgoing container is stopped. Observed in
production, the new instance read the file two seconds before the old one
flushed on `SIGTERM`. The shutdown flush therefore checks first — if the file
has moved on since this process last wrote it, the newer instance owns it and
the flush stands down instead of overwriting. In the log that reads
`skipping the shutdown flush`, and it is the correct outcome, not a failure.

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
- **State persistence assumes one instance**, and is off unless `STATE_FILE`
  is configured. See "Surviving a redeploy".

## Session lifetime vs. Notion's refresh handling

Notion does not recover from a failed refresh grant. When `/token` answers
`invalid_grant` because the ELO session behind the refresh token is gone,
Notion offers no sign-in again — the connector stays broken till someone
deletes and re-adds it. A vault session that expires before the refresh token
therefore caps the effective connector lifetime, and idle expiry mid-week
becomes a manual repair, not a re-login.

Deployments whose primary consumer is Notion should align the vault TTL with
the refresh token TTL:

    ELO_USER_SESSION_TTL=2592000   # match OAUTH_REFRESH_TOKEN_TTL (30 days)

`lastUsed` is refreshed on every successful refresh grant, so any connection
used at least once within 30 days never hits the idle expiry. The browser
login cookie (`elo_mcp_session`) is capped independently at 8 hours
(src/authn/session.ts) — the vault TTL must not leak into cookie lifetime:
a month-long SSO cookie on a client device is a different risk than
server-side state, and an expired cookie costs one login, not the connector.

Signed-in browser consumers (claude.ai) log in again daily; the OAuth
connector behind them keeps working because the vault entry outlives the
cookie.

### Accepted residual risks

With the 30-day vault TTL the following holds for up to 30 days per user,
until the next idle sweep:

- **Cleartext credentials in process memory.** The vault holds ELO passwords
  in RAM because `EloClient` needs them for the periodic IX re-login. The
  encrypted state file protects them at rest; it cannot protect them in the
  process. Anyone with access to the running container (debug interfaces,
  core dumps, compromised runtime) can read them. Mitigation is operational:
  no shell access to the container, restricted platform access, no core
  dumps enabled.
- **Delayed enforcement of a password change.** After an ELO password change
  the session is dropped on the next background re-login attempt
  (`isStaleCredentialError`). Until that attempt fires, up to one IX refresh
  interval may pass before the change is enforced here.
- **Licence accounting is idle-based.** Only concurrently re-logged-in IX
  sessions consume ELO licences; the vault entry itself does not.
  `ELO_MAX_USER_SESSIONS` still bounds the pool.

If any of these is not acceptable, leave `ELO_USER_SESSION_TTL` at the
8-hour default and accept that Notion connectors must be re-added by hand
after any idle window longer than 8 hours.
