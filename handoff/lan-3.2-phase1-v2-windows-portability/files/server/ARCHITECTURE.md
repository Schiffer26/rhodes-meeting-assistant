# RHODES API — architecture (phases LAN-1 … LAN-3.1)

The shared backend foundation for RHODES: one service, one SQLite database, one
writer. This document describes what exists today, why it is shaped this way, and what
is deliberately still missing.

> **Status.** The service has accounts, sessions and role-based authorisation
> (LAN-2), and since LAN-3.1 a native HTTPS transport (below). It still binds to
> loopback only and serves no business data: health, authentication and account
> administration are the whole HTTP surface. The React application in `src/` is
> unchanged, has no login screen, and still stores its data in the browser.
>
> **LAN-3.1 is a transport foundation, not a LAN deployment.** HTTPS can be enabled,
> and that is all: no other computer can reach the service, because the listener still
> refuses every address except `127.0.0.1` and `::1`. Supplying a valid certificate does
> not relax that rule.

---

## 1 · Folder structure

```
server/
├── package.json                 ← pinned dependencies + scripts
├── tsconfig.json                ← build config (src → dist)
├── tsconfig.test.json           ← type-checks src + test without emitting
├── ARCHITECTURE.md              ← this file
├── scripts/
│   ├── run-tests.mjs            ← discovers test/*.test.ts and runs node --test via tsx
│   └── copy-migrations.mjs      ← copies *.sql into dist/ after every build
├── src/
│   ├── index.ts                 ← process entry: signals, exit codes (no startup logic)
│   ├── startup.ts               ← ordered startup: config+TLS → db → migrations → listen
│   ├── app.ts                   ← Express app: health + /api/auth + /api/admin (no CORS)
│   ├── server.ts                ← HTTP/HTTPS listener lifecycle + graceful close
│   ├── config.ts                ← every environment rule, validated before any I/O
│   ├── tls.ts                   ← certificate/key validation, TLS floor, server options
│   ├── errors.ts                ← AppError taxonomy (code / httpStatus / exposure)
│   ├── logger.ts                ← one JSON object per line
│   ├── version.ts               ← service identity reported by /api/health
│   ├── http/
│   │   ├── health.ts            ← GET /api/health (public)
│   │   ├── middleware.ts        ← request ids, request log, 404, error handler
│   │   ├── respond.ts           ← error envelope + no-store helper
│   │   ├── authRoutes.ts        ← /api/auth: login, logout, me, change-password
│   │   └── adminRoutes.ts       ← /api/admin/accounts: list, create, patch, reset
│   ├── auth/
│   │   ├── accounts.ts          ← account repository; every rule enforced in one transaction
│   │   ├── audit.ts             ← audit trail writer (redacting, never throws)
│   │   ├── errors.ts            ← the closed set of auth error codes
│   │   ├── middleware.ts        ← bearer parsing, requireAuth/requireRole/password gate
│   │   ├── password.ts          ← scrypt hashing, format, verification, bounded queue
│   │   ├── policy.ts            ← username and password policy, normalisation
│   │   ├── rateLimit.ts         ← login throttling per account and per address
│   │   └── sessions.ts          ← token issuance, lookup, revocation, cleanup
│   ├── db/
│   │   ├── index.ts             ← the only place that opens the database
│   │   ├── migrate.ts           ← migration runner (idempotent, checksummed)
│   │   └── migrations/
│   │       ├── 0001-initial-schema.sql
│   │       ├── 0002-integrity-hardening.sql
│   │       └── 0003-authentication.sql
│   └── cli/
│       ├── migrate.ts           ← `npm run migrate`, `--status`
│       ├── admin.ts             ← `npm run server:admin:bootstrap` / `:reset`
│       └── prompt.ts            ← hidden password entry; refuses without a terminal
└── test/
    ├── helpers.ts               ← temp data dirs, ephemeral ports, fixtures
    ├── auth-helpers.ts          ← cheap-cost account fixtures, HTTP helpers
    ├── config.test.ts
    ├── database.test.ts
    ├── health.test.ts
    ├── integrity.test.ts
    ├── migrations.test.ts
    ├── auth-migrations.test.ts  ← 0003, the v2 → v3 upgrade, schema rules
    ├── auth-password.test.ts    ← hashing, format, policy, KDF limiter
    ├── auth-login.test.ts       ← sign-in, sessions, expiry, logout, throttling, password ceiling
    ├── authz.test.ts            ← 401/403, roles, self-protection, admin surface
    ├── auth-provisioning.test.ts← bootstrap/recovery, CLI refusals
    ├── auth-secrets.test.ts     ← no secret in logs, database, audit or responses
    ├── auth-stale-authz.test.ts ← LAN-2.1: revalidation after an asynchronous hash
    ├── auth-audit.test.ts       ← LAN-2.1: required audit writes roll the change back
    ├── auth-overload.test.ts    ← LAN-2.1: KDF saturation and dummy-hash recovery
    ├── auth-login-revalidation.test.ts ← LAN-2.1a: sign-in revalidated after the await
    ├── tls-config.test.ts       ← LAN-3.1: TLS refusals, ordering, loopback still enforced
    ├── tls-transport.test.ts    ← LAN-3.1: HTTPS handshake, versions, shutdown, no key in logs
    └── fixtures/tls/            ← TEST-ONLY certificates (see the README there)
```

Nothing under `server/` is imported by the frontend, and the frontend build does not
see it. The root `package.json` gains `server:*` scripts; its existing scripts are
untouched.

---

## 2 · Runtime topology

```
        office LAN (later phase)            this phase: same machine only
                 ✗                                  ✓
   ┌──────────────────────┐          ┌──────────────────────────┐
   │ workstations         │          │ Windows host             │
   │ (browser, later)     │          │  RHODES API  ⟷ rhodes.db │
   └──────────────────────┘          └──────────────────────────┘
```

- Exactly **one** process opens the database file: the API. No client receives a path,
  a connection string, or a driver.
- The database lives on the host's **local disk** (see §4).
- The listener is bound to `127.0.0.1`. A configuration that names any other address is
  rejected before the socket is created, so the service cannot be reached from another
  machine in this phase. Authentication exists (LAN-2) but is deliberately *not* a
  substitute for that boundary: plain HTTP on loopback is acceptable; plain HTTP over a
  network is not.
- The socket speaks **HTTP or HTTPS** (LAN-3.1), decided by two optional environment
  variables. Either way it listens on loopback: the transport and the boundary are
  separate decisions, and a certificate never widens the boundary.

---

## 3 · Configuration

All values come from the environment and are validated by `src/config.ts` before the
data directory is created or anything listens. An invalid value exits non-zero with a
structured error code; it never leaves a half-initialised database behind.

| Variable | Default | Rule |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `RHODES_HOST` | `127.0.0.1` | Loopback only (`127.0.0.1`, `::1`; `localhost` is normalised). Anything else is refused. |
| `RHODES_PORT` | `4317` | 0–65535 |
| `RHODES_DATA_DIR` | dev: `<repo>/.local-data` · prod: `%ProgramData%\RHODES\data` | Not a UNC share, not a cloud-synced folder *after resolution*, not an existing file |
| `RHODES_DB_FILE` | `rhodes.db` | Plain file name ending in `.db`; no directories |
| `RHODES_BUSY_TIMEOUT_MS` | `5000` | Milliseconds a writer waits for the lock |
| `RHODES_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `RHODES_TLS_CERT_FILE` | *(unset)* | PEM certificate; must be set together with the key (§3.1) |
| `RHODES_TLS_KEY_FILE` | *(unset)* | PEM private key; must be set together with the certificate (§3.1) |

Refusal codes: `config.non_loopback_host`, `config.invalid_port`,
`config.invalid_busy_timeout`, `config.invalid_database_file`,
`config.programdata_unavailable`, `config.data_dir_network_share`,
`config.data_dir_synced_folder`, `config.data_dir_not_a_directory`,
`config.data_dir_uncreatable`, `config.data_dir_unresolvable`,
`config.tls_incomplete`, `config.tls_cert_unreadable`, `config.tls_key_unreadable`,
`config.tls_cert_invalid`, `config.tls_key_invalid`, `config.tls_pair_mismatch`,
`config.tls_pair_rejected`.

### 3.1 · TLS transport (phase LAN-3.1)

Native HTTPS using Node's own `node:https` / `node:tls`. No reverse proxy and no
external web server: there is no second process to configure, patch or misroute, and no
place for the loopback rule to be bypassed.

| Situation | Result |
| --- | --- |
| Neither variable set | **HTTP** on loopback. Development and LAN-2.1a behaviour, unchanged |
| Both set, material valid | **HTTPS** on loopback |
| Only one set | Refused: `config.tls_incomplete` |
| File missing, unreadable, empty, or a directory | Refused: `config.tls_cert_unreadable` / `config.tls_key_unreadable` |
| Not PEM, not X.509, or not a private key | Refused: `config.tls_cert_invalid` / `config.tls_key_invalid` |
| Certificate does not belong to the key | Refused: `config.tls_pair_mismatch` |
| OpenSSL cannot build a context from the pair | Refused: `config.tls_pair_rejected` |

**There is no fallback.** A half-configured or broken TLS setup stops startup; the
service never quietly serves HTTP instead. A silent downgrade would be invisible in
production — the one failure mode that must not be possible.

Protocol rules:

- **TLS 1.2 is the floor**, stated explicitly in `src/tls.ts` and passed to the listener,
  so the guarantee does not depend on the runtime's current default. TLS 1.0 and 1.1 are
  withdrawn (RFC 8996); the server answers such an attempt with `tlsv1 alert protocol
  version`.
- **TLS 1.3 remains available.** No maximum version is set.
- **No cipher list is configured.** Node's secure defaults stay in force; pinning a list
  here would create a second, stale copy of a policy the runtime already maintains and
  would risk reintroducing an obsolete cipher.
- Certificate verification is never disabled, and `NODE_TLS_REJECT_UNAUTHORIZED` is never
  set by the service, its tests, or this document. `trust proxy` stays off.

File requirements:

- PEM format, UTF-8. The certificate file holds the leaf first, with any intermediate
  chain after it; the key file holds one **unencrypted** private key (passphrase-protected
  keys are not supported in this phase, and no passphrase is read from the environment).
- Both files are read **once, at startup**. Replacing a certificate requires a restart —
  deliberate for this phase, because a hot reload would add a failure mode (a half-written
  file picked up mid-flight) with no benefit on a single-host service.
- Validity dates are logged, not enforced. An expired certificate is an operational
  problem that clients will refuse anyway, and refusing at startup would make the service
  depend on the host clock being right. Check `validTo` in the startup log.

Operational responsibility:

- **The service never generates certificates.** Nothing is created, signed or installed
  at startup; provisioning is an operational task for a later phase (§13 item 18).
- **The certificate must be trusted by client computers before any future LAN
  deployment.** Until it is, a browser or client will warn or refuse — which is the
  correct behaviour, and must not be worked around by disabling verification.
- **Protect the private-key file with a restrictive Windows ACL**, readable only by the
  service account, for example:
  `icacls C:\RHODES\tls\rhodes.key /inheritance:r /grant:r "<ACCOUNT>:R"`.
  On POSIX the startup log warns (`tls.key_permissions_loose`) when the key is readable
  by group or others; on Windows the ACL cannot be inspected from Node, so it is the
  operator's responsibility and is documented rather than assumed.
- A key in the repository, in a log, in a chat message, or on a share is a leaked key.
  The fixtures under `test/fixtures/tls/` are **test-only**, are public by construction,
  and must never be installed on the host.

What LAN-3.1 does **not** do: it does not bind to a LAN address, change the default host,
open a firewall port, configure a router, add CORS, or decide how a client stores a token.
**LAN access remains disabled.**

### Path resolution (symbolic links and Windows junctions)

Checking the configured string is not enough: a directory that looks local can be a
symbolic link or a Windows junction pointing into a synchronised folder or at a network
share. `resolveDataDir` therefore resolves the path before accepting it.

1. The value as typed is checked for UNC form first, because `path.resolve` collapses a
   leading `\\server\share` on POSIX and would hide it.
2. The absolute path is checked for UNC form, synchronised-folder segments and
   "exists but is a file".
3. The path is then **resolved to its real location**: the nearest existing ancestor is
   resolved with `realpathSync.native` (which follows symlinks and junctions) and the
   not-yet-created segments are appended. On Windows the `\\?\` long-path prefix is
   folded back, and `\\?\UNC\server\share` becomes `\\server\share` — otherwise the
   extended form would slip past the network-share check.
4. The same UNC and synchronised-folder rules run again against the resolved target.

**Comparing a target with a sync root (LAN-2.1a correction).** The synchronised-folder
check also compares the target with the roots the client advertises in the environment
(`OneDrive`, `OneDriveCommercial`, `OneDriveConsumer`, `Dropbox`). The target is a
`path.resolve`d value, so on Windows `RHODES_DATA_DIR=/home/office/CloudData/RHODES`
becomes `C:\home\office\CloudData\RHODES`; comparing an unresolved root against that
could never match, and a synchronised directory was accepted. Both sides now pass through
one comparison key — separators unified to the platform's, resolved by the same rules as
everything else, the `\\?\` prefix stripped, trailing separators dropped and the result
lower-cased — and containment is boundary-aware: equal, or inside by a whole segment.
`CloudDataBackup` beside `CloudData` is therefore not inside it. No drive letter is assumed
or invented, and the configured directory is never rewritten.

The extended-length prefix is removed **before** separators are normalised, because
`\\?\` is recognised by its literal double separator: flattening it first would leave
`\?\C:\Users\Owner\OneDrive` to be resolved as a path on the current drive — a key that
matches nothing. A share likewise keeps both leading separators, so
`\\?\UNC\fileserver\share` normalises to `\\fileserver\share` and is never described as a
directory on the local disk. One consequence worth knowing: `RHODES_DATA_DIR` may not itself
use the extended-length form — it is refused earlier as a UNC-looking path
(`config.data_dir_network_share`), which is conservative but safe; the normalisation above
matters for the environment roots, which are not subject to that check.

A refused path is never redirected to somewhere "safe"; the service exits with a
configuration error, because quietly writing a database to a different location than the
operator configured is worse than not starting. Nothing is created before validation
succeeds, so a refused configuration leaves no directory behind.

Resolution is **fail-closed** and distinguishes three outcomes at each step:

| Result | Meaning | Action |
| --- | --- | --- |
| resolves | the component exists | check it is a directory if further segments remain, then stop |
| `ENOENT` / `ENOTDIR`, and `lstat` agrees nothing is there | not created yet | step up to the parent and continue |
| anything else (`EACCES`, `EPERM`, `ELOOP`, `EIO`, …) or a dangling entry | the target cannot be known | refuse with `config.data_dir_unresolvable`, recording the errno |

A dangling symbolic link reports `ENOENT` from `realpath` but is visible to `lstat`, so it
is refused as unresolvable rather than mistaken for "does not exist yet". When segments
remain below an existing ancestor, that ancestor must be a directory: an ordinary file in
that position is refused as `config.data_dir_not_a_directory`, never traversed.

---

## 4 · Why the database must be on host-local disk

SQLite coordinates concurrent access through POSIX/Windows file locks and a WAL
file that expects a real local filesystem. On SMB/network shares those locks are
unreliable — a lost lease or a cached write can corrupt the database, and corruption
is silent until it is fatal. Cloud sync clients (OneDrive, Dropbox, Google Drive,
SharePoint) are worse: they copy files on their own schedule and will happily
synchronise a half-written `-wal`.

Therefore:

- UNC paths and cloud-synced folders are rejected at startup (`config.data_dir_*`),
  including when they are reached indirectly through a symbolic link or junction (see
  §3).
- A **mapped network drive** (`Z:\RHODES`) is **not detected**. `Z:` is a drive letter
  to the operating system, and the fact that it maps to `\\fileserver\share` is not
  visible to a process resolving paths. This remains an operational restriction, not a
  solved problem: keep the production data directory on the system drive (the default
  `%ProgramData%\RHODES\data` is correct) and do not remap or `subst` it.
- Symbolic-link and junction traversal **is** covered by tests on Linux; the
  Windows-junction path is not yet exercised on Windows (§13).
- Backups are copies of the *whole* directory (`rhodes.db` plus `-wal`/`-shm`) taken
  while the service is stopped, or `VACUUM INTO` — never a file-level copy of a live
  database.

---

## 5 · Data layer

`src/db/index.ts` is the only module that opens the file. On every open it applies and
then **verifies** these settings:

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Readers never block the writer; required for several clients |
| `synchronous` | `FULL` | A committed meeting record survives a power cut |
| `foreign_keys` | `ON` | SQLite defaults this to OFF, which would allow silent orphans |
| `busy_timeout` | configured (5 s) | Wait for the lock instead of failing instantly |
| `recursive_triggers` | `ON` | Without it, `REPLACE` can delete a row without firing its delete trigger (see below) |

`recursive_triggers` is a correctness requirement, not a tuning knob. SQLite satisfies a
`REPLACE` conflict by *deleting* the row in the way, and that deletion fires `BEFORE
DELETE` triggers **only when recursive triggers are enabled**. With the default setting,
`INSERT OR REPLACE INTO note_revisions …` overwrote a stored minute revision without the
append-only guard ever running — reproduced in this environment and now closed. Each
setting above is read back after it is applied, and the service refuses to start if any
of them did not take (`db.recursive_triggers_unavailable` included).

Startup also runs `PRAGMA quick_check`; a damaged file fails the service rather than
serving it. Shutdown (SIGINT/SIGTERM) closes the listener, ends keep-alive sockets,
checkpoints the WAL back into `rhodes.db`, then closes the connection — so a copy of
`rhodes.db` taken afterwards is complete.

Transactions are kept short: one write per HTTP request, wrapped in
`db.transaction()`, with the row version incremented inside the same transaction.

---

## 6 · Schema (migrations 0001, 0002 and 0003)

| Table | Purpose |
| --- | --- |
| `personnel` | People who attend meetings. **Not** login accounts. Soft-deleted via `deleted_at`. |
| `meetings` | One meeting: schedule, venue or hand-entered Meet link, organiser, status, soft delete. |
| `meeting_attendees` | One row per participant — invited flag and attendance state (`invited`/`present`/`absent`/`excused`). |
| `agenda_items` | Ordered agenda topics with presenter, estimate and discussion status. |
| `meeting_notes` | The note document for a meeting (1:1). |
| `note_revisions` | Append-only history of every accepted note save. `UPDATE` and `DELETE` are refused by trigger. |
| `decisions` | Decisions, optionally tied to an agenda item, with approval status. |
| `action_items` | Follow-ups with assignee, due date, priority and status. |
| `audit_records` | Who did what, when. Append-only since 0003; `actor` holds an account public id or `operator-cli`. |
| `schema_migrations` | Applied migration version, name, SHA-256 checksum and timestamp. |
| `user_accounts` | Login accounts (0003). Unique case-insensitive username, scrypt hash, role, status, must-change flag, optional Personnel link. Never deleted. |
| `user_sessions` | Live sessions (0003). SHA-256 of the bearer token, creation and absolute expiry, revocation time and reason. No raw token, ever. |

Modelling rules encoded in the SQL:

- Every mutable table carries `row_version` (starts at 1) plus `created_at`/`updated_at`
  (UTC ISO-8601). `row_version` is the basis of optimistic concurrency later; the API
  increments it inside the transaction, never a trigger.
- **Identifiers are not uniform, and the schema should be described as it is.** The
  *entity* tables — `personnel`, `meetings`, `agenda_items`, `decisions`,
  `action_items` — carry an opaque `public_id` (16 random bytes, hex) so an id can
  appear in a URL or an export without exposing a row number, plus a nullable
  `legacy_id` reserved for the controlled import of existing browser records (that
  import does not exist yet, and no browser data has been read). The remaining tables
  do not have one, because they are not addressed individually: `meeting_attendees`
  is identified by its composite key `(meeting_id, person_id)`; `meeting_notes` by its
  `meeting_id` primary key; `note_revisions` by `(meeting_id, revision_no)`;
  `audit_records` and `schema_migrations` use their integer key, and neither is ever
  addressed by a client.
- **No silent cascade from history.** References to people are `ON DELETE RESTRICT`:
  a person with attendance, notes, decisions or assigned actions cannot be deleted at
  all. Meeting-owned rows (attendees, agenda, notes, revisions, decisions, actions)
  cascade with the meeting, because they are meaningless without it; meetings are
  soft-deleted, so that cascade is a safety net rather than the normal path.
  `agenda_item_id` on decisions/actions is `SET NULL` — detaching a topic never
  destroys the decision.
- `CHECK` constraints reject impossible records: unknown status values, a Meet link on
  an in-person meeting, malformed dates, blank titles, negative estimates.
- `meeting_date` / `start_time` / `end_time` remain **local wall-clock** values, exactly
  as the current application models them.
- Personal display settings (theme, motion, density, date format) are **not** in this
  schema. They stay per workstation: one person's theme change must never repaint
  another person's screen.

### Integrity rules added by migration 0002

`0001` is applied and immutable, so every additional rule lives in
`0002-integrity-hardening.sql` as a trigger (`19` of them). SQLite cannot add a `CHECK`
to an existing table, and rebuilding tables that already carry foreign keys would be
more dangerous than the problem it solves.

**Real calendar dates and clock times.** `0001`'s `GLOB` checks prove a value *looks*
like `YYYY-MM-DD`. They cannot prove it exists — SQLite normalises impossible values
instead of rejecting them (`date('2025-02-29')` → `'2025-03-01'`,
`date('2026-04-31')` → `'2026-05-01'`, `strftime('%H:%M','24:00')` → `'00:00'`). The
rule is therefore equality against the normalised form: `date(x) IS NOT x` and
`strftime('%H:%M', x) IS NOT x` reject a value unless it survives normalisation
unchanged. `IS NOT` is used because it is null-safe — `NULL != '2026-13-01'` is `NULL`,
which a `WHERE`/`WHEN` clause would treat as false and let through.

| Column | Rule |
| --- | --- |
| `meetings.meeting_date` | required; a real calendar date (leap days honoured: `2024-02-29` yes, `2025-02-29` no) |
| `meetings.next_meeting_date` | `NULL`, empty, or a real calendar date |
| `meetings.start_time`, `meetings.end_time` | empty, or a real 24-hour time (`00:00`–`23:59`; `24:00` and `12:60` rejected) |
| `decisions.decision_date` | empty, or a real calendar date |
| `action_items.due_date` | empty, or a real calendar date |

The triggers fire on `INSERT` and on `UPDATE OF <that column>`. Validating only the
touched column matters: a database created before 0002 may already hold a value that
0001 accepted, and that row must remain editable (soft-deletable, re-titled) — only a
change *to the bad value itself* is refused.

**Agenda links cannot cross meetings.** `decisions.agenda_item_id` and
`action_items.agenda_item_id` must reference an agenda item belonging to the same
`meeting_id` as the record. `0001`'s foreign key only proves the agenda item exists.
Triggers reject: a cross-meeting link on insert, a cross-meeting link created by an
update (changing either the record's meeting or its agenda item), and moving an agenda
item to another meeting while a decision or action item in the old meeting still links
to it. Detaching a link (`agenda_item_id = NULL`) is always allowed, and an agenda item
with no links may move freely. The check ignores `deleted_at` on purpose: a soft-deleted
decision is still history, so the relationship must remain valid.

**Note revision history cannot be destroyed.** A revision cannot be updated (`0001`)
or deleted individually (`0002`), and a meeting that has any revision history cannot be
hard-deleted at all — ordinary `DELETE` is refused with a message pointing at
`deleted_at`. Soft deletion never touches revisions, and new revisions can always be
appended. Meetings without history remain hard-deletable, along with their dependent
rows.

The guards are only as strong as the conflict resolution mode: `INSERT OR REPLACE` and
`UPDATE OR REPLACE` take the delete path, which needs `recursive_triggers = ON` to fire
the guard (see §5). With that enabled, both are refused like any other deletion, and the
stored revision keeps its number and its text.

> **Permanent purging is deliberately unimplemented.** Should a meeting's history ever
> have to be destroyed for a legal or operational reason, that must be an explicit,
> separately reviewed administrative procedure with its own audit trail — not an
> ordinary delete statement, and not something this service offers today.

### Rules added by migration 0003

`0003-authentication.sql` adds two tables and three triggers; it changes nothing that
0001 or 0002 created.

| Object | Rule |
| --- | --- |
| `user_accounts.username_normalized` | `UNIQUE`, and a `CHECK` that it is lower-case — case-insensitive uniqueness is a database guarantee, not a convention |
| `user_accounts.role` / `.status` | Closed sets (`administrator`/`member`, `active`/`disabled`) |
| `user_accounts.personnel_id` | `UNIQUE`, optional, `ON DELETE RESTRICT` — one account per person, and the person cannot be deleted while an account points at them |
| `trg_user_accounts_no_delete` | `BEFORE DELETE` refusal: accounts are disabled, never removed |
| `user_sessions.token_hash` | `UNIQUE`, exactly 64 hex characters — the column cannot hold a raw token |
| `user_sessions.expires_at` | `CHECK (expires_at > created_at)`: a session that expires when it starts is not a session |
| `user_sessions.revoked_reason` | `NULL` or one of seven known reasons |
| `trg_audit_records_no_update` / `_no_delete` | The audit trail is append-only |

Nothing seeds a row. A fresh database has no account at all, and there is no code path
that creates one except the local bootstrap command (§7.8).

### Migration procedure

1. Add a new file to `src/db/migrations/`: `0004-<what-it-does>.sql` (four-digit
   version, kebab-case name). Never edit an applied file — the checksum check refuses
   to start if you do, precisely so the schema and the source cannot drift apart.
   Line endings do not count as an edit: checksums are computed over **LF-normalised**
   text (`normaliseNewlines` in `src/db/migrate.ts`), and `.gitattributes` enforces
   `*.sql text eol=lf`, so a Windows checkout and a Linux checkout of the same
   migration hash identically. Changing a statement, a comment or whitespace inside a
   line still changes the checksum, exactly as before.
   **Databases created before normalisation** (LAN-1) recorded the hash of the raw file
   — from a CRLF checkout that is a different value. Such a record is accepted when it
   equals the SHA-256 of the same migration's text with Windows line endings
   (`legacyChecksums`). The rule is narrow: it is still a hash of *this* content, any
   real edit changes every variant, the recorded value is never rewritten, and a warning
   (`migration.legacy_checksum_accepted`) is logged so the older provenance is visible.
2. Write forward-only SQL. If a migration fails, its transaction rolls back and the
   previous version stays intact; fix the file and run again.
3. Apply: `npm run server:migrate` (or just start the service — migrations run at
   startup). Inspect: `npm run server:migrate -- --status`.
4. Commit the migration file with the code that needs it. The build copies `*.sql`
   into `dist/db/migrations/` so a packaged install can create its own schema.

---

## 7 · Authentication and authorisation (phase LAN-2)

Backend only. There is no login screen in the React application yet, and nothing in
`src/` knows these endpoints exist; the phase exists so that a later phase has a real
boundary to put a screen in front of.

### 7.1 · Identity: accounts are not people

`personnel` describes who attends meetings, including people who will never sign in.
`user_accounts` describes who may use the application. They are separate tables:

- creating a Personnel record **never** creates a login — there is no code path that
  does it, and no trigger that would;
- an account may optionally link to exactly one Personnel record (`personnel_id`,
  `UNIQUE`, `ON DELETE RESTRICT`), so history cannot lose the person it belongs to;
- `public_id` (16 random bytes, hex) is the only identifier a client ever sees. The
  integer primary key stays inside the process.

Roles are `administrator` and `member`; status is `active` or `disabled`. There is no
third role, no per-record permission table, and no permission cache.

### 7.2 · Password storage

| Property | Value | Why |
| --- | --- | --- |
| Algorithm | `scrypt` from `node:crypto`, asynchronous | No native dependency, no second crypto library, nothing to compile |
| N / r / p | 131072 / 8 / 1 | OWASP-recommended; ~128 MiB and ~0.3 s per hash on the target hardware |
| Salt | 16 random bytes per hash | Two users with the same password do not share a hash |
| Key length | 64 bytes | Derived key length for the stored value |
| `maxmem` | 256 MiB, a constant | Fixed budget; never derived from a stored row (LAN-2.1) |
| Concurrency | 2 at once, 64 queued, then `503` | 2 hashes ≈ 256 MiB — what an office host can spare. An unbounded queue would be a memory-exhaustion vector |
| Format | `scrypt$1$N=131072,r=8,p=1$<salt>$<key>` (base64url) | Self-describing and versioned, so parameters can change without invalidating existing rows |
| Comparison | `timingSafeEqual` | Constant-time equality on the derived key |

Measured in the development container (2 vCPU, Node 22.22.3): **301 / 301 / 348 / 834 ms**
for four consecutive hashes — **348 ms median**, the first run cold — at roughly 128 MiB
resident per hash. That cost is the defence: an attacker with a copy of the database
faces it for every guess.

**The resource budget (LAN-2.1).** A stored hash names its own parameters, so a database
row is untrusted input to the hashing code. LAN-2 validated those parameters against a
broad *range* and then sized `maxmem` **from the row** (`max(256 MiB, 128·N·r·2)`), which
let a hostile row decide how much memory the process would commit. That is now replaced by
an explicit allowlist plus one constant:

- only these profiles are accepted — `N=131072,r=8,p=1,keylen=64` (production) and
  `N=16384,r=8,p=1,keylen=64` (the cheaper profile our test fixtures use, and any row
  written under an older cost). Anything else is refused **before** scrypt is called;
- `maxmem` is always `SCRYPT_MAX_MEMORY` (256 MiB), and every allowlisted profile is
  checked against it at module load — the process cannot be talked into a bigger commit;
- the encoded salt and key must be exactly the length their profile specifies, in the
  base64url alphabet, checked **before** decoding — a megabyte-long "salt" costs a length
  comparison, not an allocation;
- the whole stored string is bounded (≤ 1 024 characters) before it is split.

Hashing always uses the production profile; `needsRehash()` reports a row that does not.
A rejected profile or a malformed encoding is "cannot verify", never an exception.

**Policy.** 15–128 characters, counted in Unicode code points. No composition rules, no
trimming, no Unicode normalisation, no truncation: the exact string the user typed is the
string that is hashed, so a pasted leading space matters and NFC/NFD forms are different
passwords. The ceiling is checked *before* any key derivation.

**Future, not implemented:** multi-factor authentication. It is named here so the absence
is a decision rather than an oversight; the schema would take a TOTP secret column, and
nothing in this design assumes passwords are the only factor.

### 7.3 · Sessions

- A token is 32 random bytes (`crypto.randomBytes`), base64url encoded — 256 bits,
  43 characters. It leaves the process exactly once, in the login response.
- The database stores **only** `sha256(token)` in `user_sessions.token_hash`, plus
  creation time, absolute expiry and (after revocation) a reason. A copy of the database
  cannot be used to impersonate anyone.
- Expiry is **absolute**: eight hours from sign-in, never renewed by use. Using the
  application does not extend a session; signing in again is the only way to get a new one.
- Revoked by: logout, password change, password reset by an administrator, local
  administrator recovery, role change, account disable. Each reason is a value in a
  closed set (`revoked_reason`), so the trail is queryable.
- Expired and revoked rows are deleted opportunistically (login, CLI). That is
  operational state, not history: `audit_records` records why a session ended and is
  append-only.

The middleware re-reads the account row on **every** protected request. Roles are not in
the token (there is no JWT and no role claim), so a role change or a disable takes effect
on the next request rather than at the next login.

### 7.4 · Endpoints

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| GET | `/api/health` | public | Liveness + database readiness |
| POST | `/api/auth/login` | public | `{username, password}` → token, expiry, safe user summary, must-change flag |
| POST | `/api/auth/logout` | bearer | Revokes the current session |
| GET | `/api/auth/me` | bearer | Current account and session expiry |
| POST | `/api/auth/change-password` | bearer | `{currentPassword, newPassword}`; clears the flag; revokes **all** sessions including the current one |
| GET | `/api/admin/accounts` | admin | Account list, no hashes |
| POST | `/api/admin/accounts` | admin | Creates an account, returns a server-generated temporary password **once** |
| PATCH | `/api/admin/accounts/:public_id` | admin | `{role?, status?}` |
| POST | `/api/admin/accounts/:public_id/reset-password` | admin | Temporary password, returned once |

Rules that hold across the surface:

- Everything under `/api/auth` and `/api/admin` is `cache-control: no-store`.
- Credentials are accepted in the request body of `login`, and the token only in an
  `Authorization: Bearer <43 chars>` header. A token in a query string or a body field is
  ignored — it would end up in a log, a history or a referrer.
- Failures are generic: an unknown username, a wrong password and a disabled account all
  answer `401 auth.invalid_credentials` with the same message. An unknown username still
  pays for one scrypt verification against a throwaway hash, so timing does not
  distinguish it either.
- A password longer than 128 code points is refused **before any key derivation** on the
  sign-in path (LAN-2.1). No stored password can be that long, so hashing it would only
  burn a KDF slot. The refusal is the same generic `401` whether or not the username
  exists, and the attempt counts against the login throttle. The change-password route
  applies the same ceiling to the password it is asked to verify.
- When the KDF pool is full, **both** the known and the unknown username paths answer
  `503 auth.hash_overloaded`. The dummy-verification path propagates the error instead of
  swallowing it, and a failed dummy-hash initialisation is forgotten rather than cached, so
  a transient overload cannot permanently disable it — and cannot become an enumeration
  signal.
- A sign-in is only completed against an account that has not changed since its password
  was verified (LAN-2.1a). The row is re-read and the session inserted in one
  `BEGIN IMMEDIATE` transaction: if the account was disabled, re-enabled, reset or
  otherwise modified while scrypt was running, no session is created, the attempt counts
  against the throttle, and the answer is the same generic `401` — never a hint that the
  account changed. The token, the role and the must-change flag in a successful response
  all come from that revalidated row.
- `401` means "we do not know who you are"; `403` means "we do, and not for this".
- An account with `must_change_password = 1` can sign in, read `/api/auth/me` and change
  its password — and is refused everything else with `403 auth.password_change_required`.
  The flag is read from the database per request, so clearing it takes effect immediately.
- No endpoint accepts a role, a status or an id that the server did not just read from
  the database.
- Request bodies are limited to 16 kB and strictly parsed; malformed JSON is `400`,
  oversize is `413`. No wildcard CORS header is ever emitted.

### 7.5 · Administrative rules

Enforced in `src/auth/accounts.ts` inside `BEGIN IMMEDIATE` transactions, not in route
handlers, so any future caller inherits them:

- usernames are unique **case-insensitively** (stored normalised, `UNIQUE` index);
- accounts are **disabled, never deleted** — a `BEFORE DELETE` trigger refuses even a
  statement that forgot;
- disabling an account revokes its sessions; a role change revokes them too;
- an administrator cannot disable or demote **themselves**, and cannot reset their own
  password through the API;
- the **last active administrator** can never be disabled or demoted. The count is taken
  inside the write transaction, so two simultaneous demotions cannot both succeed;
- every action above is audited, with the affected `public_id` and no credential material.

**Revalidation after an asynchronous step (LAN-2.1).** Creating an account and resetting a
password both await a key derivation — deliberately hundreds of milliseconds — before they
write. The middleware's role check happened *before* that await, so by the time the
transaction opens the caller may have been demoted, disabled, forced to change their
password, or signed out. The route therefore passes an `ActorHandle` (account id, session
id, public id) into the repository, and `assertActorAuthorised` re-asks every question
inside the `BEGIN IMMEDIATE` transaction: still active, still `administrator`, no outstanding
password change, and the session is still unrevoked and unexpired. A stale decision is
refused with `403` (no longer an administrator / owes a password change) or `401` (account
disabled, session gone) instead of being committed.

The same pattern protects self-service password change: the route verifies the current
password, then awaits the new hash, then the transaction confirms that the stored
`password_hash` is still the one that was verified and that the session is still live. If
an administrator reset the password in that window, the change is refused with
`409 auth.password_changed_concurrently` rather than overwriting the reset.

### 7.6 · Throttling

Two counters per attempt: the normalised username (10 failures per 15 minutes, then a
15-minute cooldown) and the source address (three times that). A blocked key answers
`429 auth.too_many_attempts` with `Retry-After`. Nothing is permanent: when the cooldown
expires the account works again, with its real password.

Both maps are **bounded** (5,000 keys each, oldest evicted) because usernames are
attacker-chosen; an unbounded map would be a cheap memory-exhaustion attack.

> **Known limitations, stated plainly.** The counters live in process memory. They reset
> when the service restarts, and they are not shared with a second instance. With the
> service bound to loopback, every request arrives from `127.0.0.1`, so the address
> counter is a runaway-client brake rather than a per-machine control; the per-account
> counter is the one doing the work. A future LAN phase needs shared state (or an
> edge proxy) before the address dimension means anything.

### 7.7 · Audit trail

`audit_records` (migration 0001) is reused — there is no second audit table — and
migration 0003 makes it **append-only** with `BEFORE UPDATE` and `BEFORE DELETE` triggers.

Recorded: `account.bootstrap`, `account.create`, `account.disable`, `account.enable`,
`account.role_change`, `account.password_change`, `account.password_reset`,
`account.admin_recovery`, `auth.login`, `auth.login_failed`, `auth.logout` (session
revocations are recorded on the account action that caused them, with a count).

Never recorded: passwords, hashes, tokens, `Authorization` headers. The writer additionally
redacts any detail key matching `pass|secret|token|hash|authoriz| cookie`, so a future call
site cannot start leaking one by accident.

**Two kinds of write (LAN-2.1).**

| Kind | Function | Behaviour on failure | Used for |
| --- | --- | --- | --- |
| Required | `recordRequiredAudit` | throws → the surrounding transaction rolls back | bootstrap, account creation, disable, reactivation, role change, password change, administrator reset, local recovery |
| Best-effort | `recordAudit` | logged, the request continues | sign-in, failed sign-in, sign-out |

A security state change is not committed without its trail: if the audit insert fails, the
account mutation, the session revocation and the audit row all roll back together. Events
that merely describe a request are recorded if possible; a broken audit table must not lock
everyone out of the application.

### 7.8 · Provisioning and recovery

There is **no default account and no default password**, and no HTTP route that can
create the first one. Two local commands exist, both authorised by filesystem access to
the data directory — the same access that would let someone read the database anyway:

```bash
npm run server:admin:bootstrap   # first administrator; refused if any account exists
npm run server:admin:reset       # new password for an administrator (recovery)
```

- Passwords are typed at a **hidden prompt**; they are never accepted as an argument, an
  environment variable or a file, and the command refuses extra arguments outright.
- If the terminal cannot hide input (a pipe, a script, a non-TTY runner), the command
  **stops** with exit code 1. It does not fall back to a visible prompt.
- `bootstrap` runs migrations, then creates one `administrator` with the password the
  operator chose, in a single transaction, and audits `account.bootstrap`.
- `reset` sets a temporary password, sets `must_change_password = 1`, revokes every
  session of the account, and audits `account.admin_recovery`. The operator reads the
  temporary password to the user; it is never printed again.
- A member's password is reset by an administrator in the application, not by this
  command.

### 7.9 · Threat model for this phase

| Assumption | Consequence |
| --- | --- |
| The service binds to loopback only, and speaks HTTP or HTTPS | Credentials never cross a network here. HTTP on loopback is not a credential-transport risk. HTTPS exists since LAN-3.1 but is unused by default; **any change that binds to a LAN address requires it to be enabled in the same change** |
| The host itself is trusted | Anyone who can read the data directory can bootstrap or reset an account. File permissions, not passwords, protect that boundary |
| One process, one host | Throttle state and session state are in that process (sessions in SQLite, counters in memory) |
| No client is attached yet | The token has no storage decision to make yet. When a client is added it must hold the token **in memory only** — never `localStorage`, which any script in the page can read |
| Code does not log request bodies | The request log has method, path, status and duration; never a header or a body |

### 7.10 · Corrections in LAN-2.1

Five findings from the independent review of LAN-2, and what changed.

| # | Finding | Correction | Proven by |
| --- | --- | --- | --- |
| 1 | Stored parameters were range-checked, and `maxmem` was **derived from the row**, letting a hostile row choose the memory commitment | Allowlist of two profiles, one fixed 256 MiB budget, module-load budget assertion, pre-decode salt/key length and alphabet checks | `auth-password.test.ts` (allowlist, `N=2^20,r=32,p=16` refused with zero derivations, 1 MB encodings refused) |
| 2 | The sign-in path did not apply the 128-code-point ceiling before verification, so an oversized password was hashed | Ceiling checked after throttling and before the account lookup; generic 401 for known and unknown usernames; throttle counts it; change-password applies the same ceiling to the value it verifies | `auth-login.test.ts` (128 accepted, 129 refused, identical responses, zero derivations) |
| 3 | Role checks happened before an `await`, so a demoted/disabled caller could still complete an account creation or reset | Repository takes an `ActorHandle` and revalidates inside the write transaction (status, role, must-change flag, live session); self-service change also re-checks the stored hash and session | `auth-stale-authz.test.ts` (5 scenarios with an injected hasher, no sleeps) |
| 4 | `recordAudit` swallowed failures, so a security change could commit without a trail | Split into `recordRequiredAudit` (throws, same transaction) and `recordAudit` (best effort); applied to bootstrap, create, disable, enable, role change, password change, reset, recovery | `auth-audit.test.ts` (audit trigger that aborts; every mutation rolls back, logins still work) |
| 5 | `verifyAgainstDummyHash` swallowed overload, giving unknown usernames 401 while known ones got 503 | Overload propagates on both paths; a rejected dummy-hash promise is cleared so it is retried | `auth-overload.test.ts` (deterministic saturation via a capacity seam, HTTP 503 parity, retry after failure) |

Two test seams exist for these, both documented as such in `password.ts`:
`withHashCapacityForTests` (shrink the limiter instead of launching dozens of real
derivations) and `resetDummyHashForTests` (observe lazy initialisation from a known state).
Neither is reachable from an HTTP route.

### 7.11 · Sign-in revalidation in LAN-2.1a

One more window of the same kind, found by independent review of LAN-2.1. The sign-in route
read the account row, awaited `verifyPassword`, and then created a session from the row it
had read. An administrator who disabled the account or reset its password during that
await revoked every session — and the pending sign-in then inserted a brand-new one
afterwards, exactly the session the revocation was meant to prevent.

| What changed | Where |
| --- | --- |
| `completeLogin` re-reads the row, compares it with the row that was verified, and inserts the session — all in one `BEGIN IMMEDIATE` transaction | `src/auth/accounts.ts` |
| Refusal is `missing`, `password_changed`, `account_changed` (any `row_version` bump) or `inactive`; all four map to the generic `401`, feed the throttle, and write a best-effort `auth.login_failed` row whose `reason` is a neutral `account_changed_during_login` | `src/http/authRoutes.ts` |
| The token, role, username, public id and must-change flag in a successful response are taken from the revalidated row, not the pre-verification snapshot | `src/http/authRoutes.ts` |
| Verification itself is injectable (`passwordVerifier`), so a test can perform the concurrent administrative operation at the exact moment the route awaits the result | `src/app.ts`, `src/http/authRoutes.ts` |

`row_version` is bumped by every security state change in the repository — disable,
re-enable, role change, must-change flag, password reset, password change — so an attempt
that outlived a disable-then-re-enable round trip is refused even though the password never
moved. `auth-login-revalidation.test.ts` proves all of it with no sleeps: reset during
verification, disable during verification, disable-and-re-enable, a session issued before
the operation staying revoked, a later sign-in with the current password working, the
response reflecting the revalidated row, the refusal being byte-identical in shape to a
wrong password, and the ordinary path still producing exactly one session and one audit row.

## 8 · Initialisation

```bash
npm --prefix server install     # once, on the host
npm run server:dev              # development: tsx watch, data in <repo>/.local-data
```

First start, in order: load and validate configuration *including the TLS material* →
create the data directory if absent → open `rhodes.db` and verify pragmas + integrity →
apply pending migrations → listen on loopback (HTTP, or HTTPS when configured). A fresh
database contains **schema only**: no demonstration people, meetings, notes or audit rows.

The sequence lives in `src/startup.ts` and is driven, unchanged, by the tests. The order
matters for LAN-3.1: a bad certificate is detected at step 1, so it cannot create a data
directory, open or modify the database, apply a migration, or open a socket. If the
listener itself fails to bind, the database is closed on the way out, as before.

`.local-data/` is git-ignored. It is development state, not a deliverable, and must
never be committed or copied into the repository.

---

## 9 · Health endpoint

`GET /api/health` — the only endpoint that never needs a session. It answers "is the
service up and is the database usable?" and nothing else.

```json
{
  "status": "ok",
  "service": "rhodes-api",
  "version": "0.1.0",
  "apiVersion": 1,
  "database": { "status": "ok", "schemaVersion": 3 },
  "uptimeSeconds": 42
}
```

- `200` when the database answers a probe query; `503` with `"status": "unavailable"`
  when it does not.
- `cache-control: no-store`; no CORS headers are ever emitted.
- Contains **no** paths, file names, configuration, credentials, row counts, or record
  data. `x-request-id` identifies the request in the log without exposing anything.
- Every other path returns `404` in the same error envelope:
  `{"error":{"code":"http.not_found","message":"No such endpoint.","requestId":"…"}}` —
  including any path that does not exist *yet*, which is why a business endpoint added
  later starts returning `401` rather than silently serving data.

---

## 10 · Start and stop

```bash
npm run server:dev        # development, watch mode (tsx)
npm run server:build      # compile to server/dist + copy migrations
npm run server:start      # run the compiled service (node dist/index.js)
npm run server:test       # backend test suite
npm run server:migrate    # apply pending migrations, or --status to inspect
```

Production on the Windows host requires HTTPS on loopback. `NODE_ENV=production`
without a usable certificate/key pair is refused at startup with the stable code
`config.tls_required`, before the data directory is created, the database is opened or a
socket is bound (LAN-3.1 transport, LAN-3.2 fail-closed rule):

```powershell
$env:NODE_ENV             = "production"
$env:RHODES_PORT          = "4317"
$env:RHODES_TLS_CERT_FILE = "C:\ProgramData\RHODES\tls\server-cert.pem"
$env:RHODES_TLS_KEY_FILE  = "C:\ProgramData\RHODES\tls\server-key.pem"
npm run server:start
```

Development and test are unchanged: they may still run plain HTTP on loopback, and there a
half-configured pair keeps its specific, more explanatory code (`config.tls_incomplete`,
`config.tls_cert_unreadable`, `config.tls_pair_mismatch`, …). In production every TLS
defect is reported as `config.tls_required` with the specific cause named in the message.

The startup log names the transport (`"transport":"http"` or `"https"`), and the
`service.listening` line carries the final URL with the matching scheme, so an operator
can confirm which mode is running without inspecting the configuration. Neither line
contains certificate or key material — only the subject, validity window and SHA-256
fingerprint of the certificate.

Stop with `Ctrl+C` (or `SIGTERM`): the listener closes, in-flight requests finish, the
WAL is checkpointed, the connection closes, and the process exits `0`. Shutdown is the
same for both transports, and the database is closed after the listener in both.

### 10.1 · What a shutdown reports, and what it exits with (phase LAN-3.2)

A stop is only useful if the caller can tell whether it actually worked. Shutdown is
therefore two recorded facts rather than a boolean.

`db.close()` returns a `CloseResult`:

| field | meaning |
| --- | --- |
| `checkpoint` | `{ busy, log, checkpointed }` copied from the real `PRAGMA wal_checkpoint(TRUNCATE)` row, or `null` if the checkpoint never ran |
| `checkpointed` | `busy === 0 && checkpointed >= log` — the WAL was fully folded into the database |
| `closed` | the driver reports the connection as closed (`!db.open`) |
| `stage` | how far it got: `not_open`, `checkpoint`, `close`, `done` |
| `ok` | `checkpointed && closed && no close error` |
| `error` | `{ code, message }` when something failed |

The connection is closed **even when the checkpoint fails**, so a busier reader delays a
checkpoint but cannot leak the handle. An incomplete checkpoint with a closed connection
is reported as exactly that (`checkpointed: false, closed: true, ok: false`) — never as a
clean shutdown. `-wal`/`-shm` files are never deleted by hand: SQLite owns them, and an
uncheckpointed WAL holds committed rows. Closing is idempotent; the result is memoised so
repeated calls log once.

`Runtime.shutdown(reason)` returns a `ShutdownResult`:

| field | meaning |
| --- | --- |
| `listenerClosed` | the listener really closed (`alreadyClosed` counts as closed) |
| `checkpointed` | taken from the database's `CloseResult` — a fact, not a verdict |
| `databaseClosed` | the connection is gone — a fact, not a verdict |
| `ok` | `listenerClosed && CloseResult.ok` |

`checkpointed` and `databaseClosed` are deliberately reported as separate facts: they fail
independently, and neither is a summary. `ok` is the verdict, and it is **stricter than the
two facts together**, because it also requires the database's own `CloseResult.ok`. The case
that matters is a close which threw *after* the handle closed: the WAL is folded
(`checkpointed: true`), the connection is gone (`databaseClosed: true`), and the close still
carries an error (`ok: false`). Such a shutdown reports
`{ listenerClosed: true, checkpointed: true, databaseClosed: true, ok: false }` and exits
`69`. Deriving `ok` from `checkpointed && databaseClosed` alone would have called it clean —
that was a defect found in source review and is now covered by a regression test.

The database is closed even if the listener refuses to close, and both failures are logged
separately (`service.listener_close_failed`, `service.shutdown_incomplete`, the latter
carrying `databaseStage` and `databaseError` when the close reported one). Concurrent
callers share one promise, so a `SIGINT` racing a service-host stop still produces a single
sequence and a single set of log lines.

A startup that fails also unwinds its own work: a failure after the database is open closes
the database, and a failure after the listener is bound closes the listener and then the
database, always rethrowing the **original** error and recording the tidying in one
`service.startup_cleanup` line (`listenerStarted`, `listenerClosed`, `databaseClosed`).
Cleanup failures are logged but never replace the cause: the operator needs to know why the
start failed.

Exit codes:

| code | meaning |
| --- | --- |
| `0` | every shutdown stage succeeded |
| `69` | shutdown ran, but the listener close, the checkpoint, the database close, or the close's own verdict did not succeed |
| `1` | startup failed, or a fatal fault (`uncaughtException` / `unhandledRejection`) was being reported when the process stopped |

A requested non-zero code is never downgraded, so a fatal exit stays `1` even when the
shutdown itself was clean. The last thing written to stdout is exactly one line:

```json
{"level":"info","time":"…","msg":"service.shutdown_complete","reason":"SIGTERM",
 "listenerClosed":true,"checkpointed":true,"databaseClosed":true,"ok":true,"exitCode":0}
```

It is written with a synchronous `write(2)` before the event loop is allowed to drain, so
it is present even when the process is departing under a service host's deadline. Treat it
as evidence, not as proof on its own: a clean stop is the final line **and** exit code `0`
**and** an empty Job Object on the host side.

### 10.2 · Service-mode control channel (phase LAN-3.2)

The stdin protocol exists for a Windows service host that owns the child's stdin, and it is
**off unless explicitly enabled**:

```powershell
$env:RHODES_SERVICE_MODE = "1"    # also accepted: "true", yes
```

With it enabled, stdin is read line by line and exactly one command is recognised:

```
{"cmd":"shutdown"}
```

- The line must parse as JSON, be an object, and contain only the key `cmd` with the value
  `"shutdown"`. Anything else is rejected (`malformed`, `unknown_command`) and logged as
  `service.stdin_rejected` with the reason; the process keeps running.
- A line longer than 4096 bytes is dropped without being buffered further (`oversized`),
  and the buffer is reset so the channel stays usable.
- Repeated commands after the first are logged as `service.stdin_ignored`; they never start
  a second shutdown sequence.
- EOF on stdin (the host closed the pipe) is treated as a stop request (`stdin-eof`) rather
  than leaving an orphaned process behind.
- `service.ready` is emitted only after the signal handlers, the fault handlers and this
  channel are all registered, and it carries the transport, host, port, URL and database
  path so the host can verify what it started.

With the flag absent, stdin is untouched: typing at a developer's terminal can never stop
the server, and `service.ready` still reports `"serviceMode":false`.

There is deliberately no HTTP shutdown endpoint, no PID file, no named pipe and no helper
process: the only ways to stop the service are the channel above, a POSIX signal, or the
host terminating the Job Object (which is recorded as unclean).

**Windows has no POSIX signals.** Node does not deliver `SIGTERM` or `SIGINT` to a Windows
process, and `ChildProcess.kill('SIGTERM')` (or `.kill()`) ends it through
`TerminateProcess`: no handler runs, no final line is written, and no exit code `0` is
reported. A graceful Windows stop therefore has exactly one supported trigger — the stdin
command documented above:

```powershell
# graceful: the child runs its shutdown sequence and writes service.shutdown_complete
$writer.WriteLine('{"cmd":"shutdown"}')
```

When the .NET service host exists, an SCM stop request will drive this same command; it
must never fall back to terminating the child as a normal stop. Termination —
`ChildProcess.kill()`, `TerminateProcess`, or `TerminateJobObject` — is classified
**unclean** on every platform: it is the last resort when the deadline expires, not a
shutdown mechanism. A clean Windows stop is the stdin command **and** exit code `0`
**and** a final `service.shutdown_complete` line with `ok: true` **and** an empty Job
Object.

Run the service on the host, not from a mapped drive or a network path — the working
directory and the data directory must both be local.

---

## 11 · Why clients go through the API instead of the file

- **One lock owner.** Several clients opening a SQLite file over a network is the
  classic corruption path; the API serialises writes and owns the WAL.
- **Validation in one place.** Field rules, referential checks and status transitions
  live server-side, so one client version cannot write a record another cannot read.
- **Safe evolution.** The schema can change behind the API without shipping a new
  frontend, and a future change of storage engine stays invisible to clients.
- **Auditability.** Every write passes through a process that can record who did what.
- **Security.** Authentication, authorisation and rate limiting are enforceable at one
  boundary. A shared file has no boundary at all.

---

## 12 · Deferred by design

Implemented in LAN-2 and documented above: accounts, roles, sessions, password
policy and hashing, login throttling, the administrative account surface, and local
provisioning/recovery.

Deliberately **not** implemented, and not started here: multi-factor authentication;
LAN exposure (the listener stays on loopback); certificate provisioning, a certificate
authority, or Windows trust-store installation; certificate pinning; a login or
account-administration screen in the React application; storing or refreshing tokens in a
client; Electron packaging; installers or Windows service registration; frontend API
integration; import of existing browser records; Google Calendar/Meet integration; shared
live synchronisation; offline editing; any visual redesign.

Gaps that a later phase must close before this is used by more than one person on one
machine:

- **TLS is available but not deployed.** LAN-3.1 built the transport; it did not
  provision a certificate, install it in a trust store, enable a LAN bind, or test any of
  that on the host. The service is still loopback-only, and by default still HTTP.
- **Network-level rate limiting does not exist.** The login throttle is in-memory, per
  process and per restart, and its address dimension is meaningless while every request
  arrives on loopback. It must not be described as network-level protection.
- **No firewall or router configuration** is done anywhere in this repository, and no
  Windows Firewall rule is opened by the service.

The schema is shaped for the next phase: `audit_records.actor`,
`meeting_notes.updated_by`, `note_revisions.author` and `meeting_attendees` are already
the right shape for account identity, and the `row_version` columns already support
conflict detection.

---

## 13 · Windows verification still required

This foundation was developed and tested on Linux. Before it is relied on in the
office, verify on the actual Windows host:

1. `npm --prefix server install` completes without a compiler (prebuilt `better-sqlite3`
   binary) and `node -e "require('better-sqlite3')"` loads.
2. First start creates `%ProgramData%\RHODES\data\rhodes.db`; the service account has
   write permission there.
3. `Get-NetTCPConnection -LocalPort 4317` shows `127.0.0.1` only, never `0.0.0.0`.
4. A second machine cannot reach `http://<host>:4317/api/health` (expected: refused).
5. Setting `RHODES_DATA_DIR` to a UNC path or to `%OneDrive%` is refused at startup.
6. `Ctrl+C` exits cleanly and leaves no `-wal` file behind; a restart keeps records.
7. Task Scheduler / service wrapper behaviour: automatic restart, log capture, and
   correct exit codes on configuration failure.
8. **Junction tests (LAN-1.1, not yet run on Windows).** `mklink /J C:\RHODES-data
   "%OneDrive%\RHODES"` then starting with `RHODES_DATA_DIR=C:\RHODES-data` must exit
   with `config.data_dir_synced_folder`. The Linux symlink tests prove the logic; the
   Windows junction path itself (`realpathSync.native` →
   `GetFinalPathNameByHandle`) has not been executed here.
9. Migration checksum portability across platforms: a database created on Windows must
   verify its checksums on Linux and vice versa. `*.sql` is pinned to LF by
   `.gitattributes` and checksums are LF-normalised, but the cross-platform round trip
   has not been performed — only the equivalent-text test on one machine.
10. Date/time and agenda-relationship triggers under the Windows build of SQLite
    (same version, 3.54.1, but confirm `date()`/`strftime()` behave identically).
11. **Windows permission semantics (manual deployment check).** The fail-closed path
    resolver maps `EACCES` / `EPERM` to `config.data_dir_unresolvable`. Node surfaces
    Windows ACL denials through the same errno values, but only Linux has been exercised
    here. The automated test for this deliberately **skips on Windows**: it denies access
    with `chmod`, and Node does not implement Unix permission bits on Windows, so it
    cannot simulate an ACL denial. Verify by hand instead — create a folder whose ACL
    denies the service account (for example `icacls D:\RHODES-denied /deny "SERVICE
    ACCOUNT:(OI)(CI)(F)"`), point `RHODES_DATA_DIR` inside it, and confirm the service
    exits with `config.data_dir_unresolvable` and creates nothing.
12a. **Signal and termination semantics (found in the first Windows run).** Two Phase 1
    tests encoded POSIX assumptions. They are now platform-aware rather than skipped —
    `db-close.test.ts` accepts an exit code and a `null` signal for a `TerminateProcess`
    death, and the `SIGTERM` graceful-shutdown test is POSIX-only, with a Windows test
    asserting that a forced termination produces no `service.shutdown_complete` line. The
    correction has been verified only on Linux (one test skipped there by design); confirm
    on the host that the Windows branch of each test runs and passes, and that a
    `specify /child` or SCM stop path never produces a `0` exit code by termination.

12. **REPLACE protection on Windows.** `PRAGMA recursive_triggers` is a connection-level
    SQLite setting, identical on every platform, but the `INSERT OR REPLACE` refusal has
    only been demonstrated on Linux.
13. **Hidden password entry (LAN-2, not yet run on Windows).** `npm run
    server:admin:bootstrap` must hide typing in `cmd.exe` and in Windows Terminal, and
    must refuse when stdin is redirected. The automated tests prove the *refusal* path on
    Linux; interactive entry in a Windows console has not been exercised. If a terminal
    echoes the password, stop and report it — do not add a fallback that accepts a
    password as an argument.
14. **Authentication over the loopback interface on Windows.** Sign in, call
    `/api/auth/me`, change the password, and confirm the old token is refused
    afterwards; then confirm `Get-NetTCPConnection -LocalPort 4317` still shows
    `127.0.0.1` only — an authenticated endpoint reachable from a second machine would
    defeat the whole phase.
15. **scrypt cost on the real host.** The parameters were measured on a 2-vCPU Linux
    container at ~350 ms per hash. On a slower office machine the same parameters cost
    more; confirm sign-in latency is acceptable and that two simultaneous sign-ins do not
    exhaust memory (the limiter caps them at two, and every derivation is bounded by the
    fixed 256 MiB budget).
16. **Transactional revalidation on Windows SQLite (LAN-2.1, extended in LAN-2.1a).**
    `BEGIN IMMEDIATE` and the rollback of a failed audit insert were exercised on Linux
    only. Confirm on the host that an account creation with a deliberately broken
    `audit_records` trigger leaves no account behind, that a demotion during an in-flight
    creation is refused, and that an administrator resetting a password while that user is
    signing in produces no session for the pending attempt.
17. **Cloud-sync root comparison on Windows (LAN-2.1a).** The target and each
    `OneDrive`/`Dropbox` root are now resolved with the same rules before they are
    compared, which is what the reported Windows failure needed. The correction was
    verified by emulating Windows path resolution on Linux; run
    `node --import tsx --test test/config.test.ts` on the host to confirm it with real
    `path.win32` values, including a POSIX-style `OneDrive` root and a junction into a
    synced folder.
18. **HTTPS transport on Windows (LAN-3.1, not yet run on Windows).** Everything below
    was executed on Linux only; the Windows-specific parts are the file paths, the ACLs
    and the trust store.
    a. Provision a certificate for `localhost` / `127.0.0.1` (a self-signed one is fine
       for this check), place `rhodes.crt.pem` and `rhodes.key.pem` under
       `C:\RHODES\tls\`, and lock the key down:
       `icacls C:\RHODES\tls\rhodes.key.pem /inheritance:r /grant:r "<ACCOUNT>:R"`.
    b. Start with both `RHODES_TLS_CERT_FILE` and `RHODES_TLS_KEY_FILE` set. Expect
       `"transport":"https"` in `service.starting` and a `https://127.0.0.1:4317` URL in
       `service.listening`.
    c. `Get-NetTCPConnection -LocalPort 4317` must still show `127.0.0.1` only — never
       `0.0.0.0`, `::` or a LAN address. This is the single most important check in the
       phase: TLS must not have widened the listener.
    d. `curl.exe --cacert C:\RHODES\tls\rhodes.crt.pem https://127.0.0.1:4317/api/health`
       returns the same JSON as the HTTP endpoint. Without `--cacert`, it must fail
       verification — if it succeeds, something is trusting the certificate that should
       not be.
    e. Confirm TLS 1.0/1.1 are refused from the host, for example
       `curl.exe --tlsv1.1 --tls-max 1.1 -k https://127.0.0.1:4317/api/health` fails, and
       that `--tlsv1.2` and `--tlsv1.3` both succeed.
    f. Set only one of the two variables, then point one at a missing file, then swap in
       a key from a different certificate: each must exit non-zero with the matching
       `config.tls_*` code, and must **not** create `%ProgramData%\RHODES\data` on a
       first run. Never fall back to HTTP.
    g. `Ctrl+C` with HTTPS enabled exits `0`, leaves no `-wal` file, and the process is
       gone (`Get-Process node`).
    h. Import the certificate into `Cert:\LocalMachine\Root` only when a later phase
       explicitly authorises client trust; installing it is not part of this phase.
