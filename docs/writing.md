# Writing to ELO

The server is read-only until you switch this on, and stays read-only for
everyone who has not signed in personally.

Four operations exist, no more:

| Tool pair | What it does |
|---|---|
| `elo_create_folder` → `_commit` | creates a folder under an allowlisted root |
| `elo_upload_document` → `_commit` | files a new document in a folder |
| `elo_add_document_version` → `_commit` | checks a new version onto an existing document |
| `elo_update_metadata` → `_commit` | overwrites allowlisted index fields |

Deleting, moving, changing permissions, switching a mask, driving a workflow and
calling arbitrary IX methods are all outside the MVP — not disabled by
configuration but absent from the code.

## Two rules that are not configurable

**A write needs a person.** `requireEloUser` runs before anything else and
accepts only a caller carrying a live ELO session from a personal OAuth
sign-in. A shared-secret caller is refused by name; a stdio caller is refused
for having no identity at all. There is no fallback to the technical account,
because a change attributed to the technical account is a change nobody made.

This deliberately does not reuse `withEloClient`, which cannot tell those two
apart — both simply lack an `eloSid` — and correctly falls back for reads.

**Every change takes two calls.** The preview tool checks everything that can be
checked and writes nothing; it returns what would happen plus a `confirmToken`.
The commit tool accepts that token and an idempotency key of the caller's
choosing. So a policy violation surfaces in the preview, before anyone confirms
something that was never going to work.

The token is bound to the user, the client, the operation and a hash of the
payload; it expires (`ELO_WRITE_PREFLIGHT_TTL`, default five minutes) and is
marked spent *before* execution, so a failed commit cannot be replayed with the
same token.

## Configuration

All keys, with their defaults and the reasoning, are in `.env.example` under
"Writing (off by default)". In short:

```
ELO_WRITE_ENABLED=true
ELO_WRITE_ROOT_IDS=567085          # required, non-empty
ELO_WRITE_MASKS=Ordner,Freie Eingabe   # required, non-empty
ELO_WRITE_FIELDS=                  # empty ⇒ no index field may be written
ELO_WRITE_MIME_TYPES=application/pdf
ELO_WRITE_MAX_BYTES=10485760
ELO_WRITE_PREFLIGHT_TTL=300
```

`ELO_WRITE_ENABLED=true` requires `MCP_AUTH_MODE=oauth` or `both` and a
non-empty root and mask list. Otherwise the server exits at boot with the reason
— an allowlist that permits everything is not an allowlist.

With writing off, the eight tools are not registered at all: they do not appear
in `tools/list`, and the server instructions say nothing about changing
anything.

## The limits, and where each is enforced

| Limit | Enforced by | Note |
|---|---|---|
| target folder | `assertTargetAllowed` | against the sord **fetched from ELO**, via `isInsideFolder` — never against a path a caller supplied |
| mask | `assertMaskAllowed` | exact name match |
| index fields | `assertFieldsAllowed` | reports every rejected field at once, so one round trip is enough |
| MIME type | `assertFileAllowed` | case-insensitive |
| size | `assertFileAllowed` | measured after base64 decoding |
| ELO permissions | ELO itself | the write runs on the user's own IX session, so their rights apply unchanged |

Base64 input is decoded, re-encoded and compared. `Buffer.from(x, 'base64')`
never throws — it silently drops anything that is not base64 — so without that
comparison a corrupted argument would arrive as a short, plausible-looking file.

## Concurrency

Optimistic, not locked. The preview records a fingerprint of the target; the
commit re-reads it and aborts if it moved:

```
sha256(id, change date, name, all index fields, version id|number|md5)
```

The version identity is in there because a document-version checkin **does not
move `XDateIso`** — measured against the live instance, and covered by a
regression check in `npm run test:oauth`. The target is read through
`checkoutDoc`, the only call that returns both the sord and its versions.

Locking was considered and rejected: the `LockC` bitmask values are not
derivable from the instance's OpenAPI document (the schemas carry names but no
values), and `lockSord`/`unlockSord` do not exist in its API surface. Guessing a
bitmask that acquires a lock we could then fail to release is worse than
detecting a conflict and refusing. Since nothing is locked, nothing can be left
locked.

## Duplicates

Every commit takes an `idempotencyKey`. The store keeps the **in-flight
promise**, not just the result, so two requests that overlap collapse into one
ELO write rather than racing. Failures are deliberately not remembered: a retry
after a network error should be able to succeed. Keys are scoped per user.

Separately, `EloClient.request()` retries a POST once when the session has
expired — safe for reads, and the reason writes go through `requestOnce()`
instead. A retried `checkinSord` would create a second object.

## Errors from ELO

IX answers business errors with **HTTP 200 and an `exception` body**. Every
write call goes through the client's existing check for that, so a "successful"
response that carries an exception is an error here too. The original IX text is
preserved through our own error classes, which keeps `isStaleCredentialError`
able to recognise a password change and heal the session vault.

## Audit

`withAudit` logs on every path — success, policy refusal, conflict, ELO error —
with the operation, the acting user, the client id, the target objId and, for
uploads, the file name and content type. Index fields appear as **names only**:
the values are the user's data, not ours to copy into a log. No credentials,
tokens, cookies, file contents or upload URLs are ever logged.

## Rolling back

Nothing here destroys anything, so recovery is manual and always possible:

- **A folder or document created by mistake** — delete it in the ELO client. The
  audit line names the objId.
- **A document version** — earlier versions remain; restore the previous working
  version in the ELO client.
- **Index fields** — the preview shows the previous value of every field it
  would change (`from` beside `to`). That preview is the record; keep it if the
  change matters.
- **Everything at once** — set `ELO_WRITE_ENABLED=false` and redeploy. The tools
  vanish from `tools/list`; nothing else changes.

Confirmation tokens and idempotency keys live in RAM, never in the state file.
Their TTLs are minutes, and a restart that lets an open confirmation lapse fails
in the safe direction.

## Testing

```powershell
npm run test:unit    # gate, token binding, policy, idempotency, URL pinning
npm run test:oauth   # full flow against a stub IX: shared secret refused,
                     # write runs on the user session, exception-on-200 is an
                     # error, duplicate commit creates nothing, conflict aborts
npm run test:http    # with writing off, no write tool appears in tools/list

# Against real ELO. Refuses to run without a sandbox, and verifies against ELO
# that every target sits inside it before touching anything.
ELO_TEST_FOLDER_ID=<objId> npm run test:live:write
```

The live test leaves its folder and document behind on purpose, and prints their
objIds, so the result can be inspected in ELO.
