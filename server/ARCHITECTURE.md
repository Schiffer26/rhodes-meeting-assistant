# RHODES API — architecture (phase LAN-1)

The shared backend foundation for RHODES: one service, one SQLite database, one
writer. This document describes what exists today, why it is shaped this way, and what
is deliberately still missing.

> **Status.** This is a foundation, not a finished multi-user application. The service
> binds to loopback only, has no accounts, no authorisation, and no data endpoints
> other than a health check. The React application in `src/` is unchanged and still
> stores its data in the browser.

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
│   ├── index.ts                 ← process entry: config → db → migrations → listen
│   ├── app.ts                   ← Express app (one route, no CORS, no body parser)
│   ├── server.ts                ← HTTP listener lifecycle + graceful close
│   ├── config.ts                ← every environment rule, validated before any I/O
│   ├── errors.ts                ← AppError taxonomy (code / httpStatus / exposure)
│   ├── logger.ts                ← one JSON object per line
│   ├── version.ts               ← service identity reported by /api/health
│   ├── http/
│   │   ├── health.ts            ← GET /api/health
│   │   └── middleware.ts        ← request ids, request log, 404, error handler
│   ├── db/
│   │   ├── index.ts             ← the only place that opens the database
│   │   ├── migrate.ts           ← migration runner (idempotent, checksummed)
│   │   └── migrations/
│   │       ├── 0001-initial-schema.sql
│   │       └── 0002-integrity-hardening.sql
│   └── cli/
│       └── migrate.ts           ← `npm run migrate`, `--status`
└── test/
    ├── helpers.ts               ← temp data dirs, ephemeral ports, fixtures
    ├── config.test.ts
    ├── database.test.ts
    ├── health.test.ts
    └── migrations.test.ts
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
  machine in this phase.

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

Refusal codes: `config.non_loopback_host`, `config.invalid_port`,
`config.invalid_busy_timeout`, `config.invalid_database_file`,
`config.programdata_unavailable`, `config.data_dir_network_share`,
`config.data_dir_synced_folder`, `config.data_dir_not_a_directory`,
`config.data_dir_uncreatable`, `config.data_dir_unresolvable`.

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
  Windows-junction path is not yet exercised on Windows (§12).
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

## 6 · Schema (migrations 0001 and 0002)

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
| `audit_records` | Who did what, when. `actor` is a placeholder for the account id added later. |
| `schema_migrations` | Applied migration version, name, SHA-256 checksum and timestamp. |

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

### Migration procedure

1. Add a new file to `src/db/migrations/`: `0003-<what-it-does>.sql` (four-digit
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

## 7 · Initialisation

```bash
npm --prefix server install     # once, on the host
npm run server:dev              # development: tsx watch, data in <repo>/.local-data
```

First start, in order: load and validate configuration → create the data directory if
absent → open `rhodes.db` and verify pragmas + integrity → apply pending migrations →
listen on loopback. A fresh database contains **schema only**: no demonstration people,
meetings, notes or audit rows.

`.local-data/` is git-ignored. It is development state, not a deliverable, and must
never be committed or copied into the repository.

---

## 8 · Health endpoint

`GET /api/health` — the only endpoint in this phase. It answers "is the service up and
is the database usable?" and nothing else.

```json
{
  "status": "ok",
  "service": "rhodes-api",
  "version": "0.1.0",
  "apiVersion": 1,
  "database": { "status": "ok", "schemaVersion": 1 },
  "uptimeSeconds": 42
}
```

- `200` when the database answers a probe query; `503` with `"status": "unavailable"`
  when it does not.
- `cache-control: no-store`; no CORS headers are ever emitted.
- Contains **no** paths, file names, configuration, credentials, row counts, or record
  data. `x-request-id` identifies the request in the log without exposing anything.
- Every other path returns `404` in the same error envelope:
  `{"error":{"code":"http.not_found","message":"No such endpoint.","requestId":"…"}}`.

---

## 9 · Start and stop

```bash
npm run server:dev        # development, watch mode (tsx)
npm run server:build      # compile to server/dist + copy migrations
npm run server:start      # run the compiled service (node dist/index.js)
npm run server:test       # backend test suite
npm run server:migrate    # apply pending migrations, or --status to inspect
```

Production on the Windows host:

```powershell
$env:NODE_ENV   = "production"
$env:RHODES_PORT = "4317"
npm run server:start
```

Stop with `Ctrl+C` (or `SIGTERM`): the listener closes, in-flight requests finish, the
WAL is checkpointed, the connection closes, and the process exits `0`.

Run the service on the host, not from a mapped drive or a network path — the working
directory and the data directory must both be local.

---

## 10 · Why clients go through the API instead of the file

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

## 11 · Deferred by design

Not implemented, and not started here: authentication and user management; roles and
admin/member permissions; LAN exposure; HTTPS certificates; Electron packaging;
installers or Windows service registration; frontend API integration; import of
existing browser records; Google Calendar/Meet integration; shared live synchronisation;
offline editing; any visual redesign.

The schema is shaped for the next phase: `audit_records.actor`,
`meeting_notes.updated_by`, `note_revisions.author` and `meeting_attendees` are already
the right shape for account identity, and the `row_version` columns already support
conflict detection. None of it assumes a particular auth mechanism.

---

## 12 · Windows verification still required

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
12. **REPLACE protection on Windows.** `PRAGMA recursive_triggers` is a connection-level
    SQLite setting, identical on every platform, but the `INSERT OR REPLACE` refusal has
    only been demonstrated on Linux.
