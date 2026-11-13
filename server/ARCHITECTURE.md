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
│   │       └── 0001-initial-schema.sql
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
| `RHODES_DATA_DIR` | dev: `<repo>/.local-data` · prod: `%ProgramData%\RHODES\data` | Not a UNC share, not a cloud-synced folder, not an existing file |
| `RHODES_DB_FILE` | `rhodes.db` | Plain file name ending in `.db`; no directories |
| `RHODES_BUSY_TIMEOUT_MS` | `5000` | Milliseconds a writer waits for the lock |
| `RHODES_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Refusal codes: `config.non_loopback_host`, `config.invalid_port`,
`config.invalid_busy_timeout`, `config.invalid_database_file`,
`config.programdata_unavailable`, `config.data_dir_network_share`,
`config.data_dir_synced_folder`, `config.data_dir_not_a_directory`,
`config.data_dir_uncreatable`.

---

## 4 · Why the database must be on host-local disk

SQLite coordinates concurrent access through POSIX/Windows file locks and a WAL
file that expects a real local filesystem. On SMB/network shares those locks are
unreliable — a lost lease or a cached write can corrupt the database, and corruption
is silent until it is fatal. Cloud sync clients (OneDrive, Dropbox, Google Drive,
SharePoint) are worse: they copy files on their own schedule and will happily
synchronise a half-written `-wal`.

Therefore:

- UNC paths and cloud-synced folders are rejected at startup (`config.data_dir_*`).
- A **mapped network drive** (`Z:\RHODES`) cannot be recognised from Node. Keep the
  production data directory on the system drive (the default `%ProgramData%\RHODES\data`
  is correct); do not remap it to a share.
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

Startup also runs `PRAGMA quick_check`; a damaged file fails the service rather than
serving it. Shutdown (SIGINT/SIGTERM) closes the listener, ends keep-alive sockets,
checkpoints the WAL back into `rhodes.db`, then closes the connection — so a copy of
`rhodes.db` taken afterwards is complete.

Transactions are kept short: one write per HTTP request, wrapped in
`db.transaction()`, with the row version incremented inside the same transaction.

---

## 6 · Schema (migration 0001)

| Table | Purpose |
| --- | --- |
| `personnel` | People who attend meetings. **Not** login accounts. Soft-deleted via `deleted_at`. |
| `meetings` | One meeting: schedule, venue or hand-entered Meet link, organiser, status, soft delete. |
| `meeting_attendees` | One row per participant — invited flag and attendance state (`invited`/`present`/`absent`/`excused`). |
| `agenda_items` | Ordered agenda topics with presenter, estimate and discussion status. |
| `meeting_notes` | The note document for a meeting (1:1). |
| `note_revisions` | Append-only history of every accepted note save. `UPDATE` is refused by trigger. |
| `decisions` | Decisions, optionally tied to an agenda item, with approval status. |
| `action_items` | Follow-ups with assignee, due date, priority and status. |
| `audit_records` | Who did what, when. `actor` is a placeholder for the account id added later. |
| `schema_migrations` | Applied migration version, name, SHA-256 checksum and timestamp. |

Modelling rules encoded in the SQL:

- Every mutable table carries `row_version` (starts at 1) plus `created_at`/`updated_at`
  (UTC ISO-8601). `row_version` is the basis of optimistic concurrency later; the API
  increments it inside the transaction, never a trigger.
- Every table has a `public_id` (opaque) so ids can appear in URLs without exposing
  row numbers. `legacy_id` is reserved for the controlled import of existing browser
  records — that import does not exist yet, and no browser data has been read.
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

### Migration procedure

1. Add a new file to `src/db/migrations/`: `0002-<what-it-does>.sql` (four-digit
   version, kebab-case name). Never edit an applied file — the checksum check refuses
   to start if you do, precisely so the schema and the source cannot drift apart.
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
