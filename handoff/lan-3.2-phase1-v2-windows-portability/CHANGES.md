# RHODES · LAN-3.2 · Phase 1 v2 — Windows portability correction

**Base:** `review/lan-3.2-phase1-v2-handoff` (`5317b14`, the accepted v2 handoff).
**Scope:** four files — **tests and documentation only**. No file under `server/src/` is
touched, so no runtime contract changes and nothing about the implementation is re-opened.

| file | kind | change |
| --- | --- | --- |
| `server/test/db-close.test.ts` | test | abrupt-child termination assertion is now platform-aware |
| `server/test/service-process.test.ts` | test | `SIGTERM` graceful-shutdown test split POSIX/Windows; new Windows forced-termination test |
| `server/test/service-mode.test.ts` | test | new unit test: the registered `SIGTERM` handler requests a clean stop (reason `SIGTERM`, code `0`) |
| `server/ARCHITECTURE.md` | docs | Windows stop semantics: stdin command is the only graceful trigger; termination is unclean |

Diff: **4 files, +143 / −3** (220 lines of patch). No assertion was removed or loosened;
every original claim still holds on the platform where it is true.

---

## Failure A — `db-close.test.ts` · "rows committed before an abrupt death survive the reopen"

**What failed on Windows.** The test ends the fixture with `process.kill(process.pid,
'SIGKILL')` and then asserted `exit.signal === 'SIGKILL'`. Windows has no POSIX signals:
libuv turns that call into `TerminateProcess`, the parent observes an **exit code** and
`signal: null`. The assertion therefore failed on the platform's signal plumbing and the
test never reached the WAL assertions — the part that actually matters.

**Correction.** A helper makes the *evidence* platform-aware while the *claim* stays
identical on both systems: the child died abruptly, with no shutdown code running.

```ts
function assertUncleanTermination(exit: { signal: string | null; code: number | null }): void {
  if (process.platform === 'win32') {
    assert.equal(exit.signal, null, 'Windows does not report POSIX signal metadata');
    assert.notEqual(exit.code, 0, 'an abruptly terminated child must not report a clean exit');
    return;
  }
  assert.equal(exit.signal, 'SIGKILL', 'the fixture must die unclean, not shut down');
  assert.equal(exit.code, null, 'a signal-terminated child reports no exit code');
}
```

| platform | asserted |
| --- | --- |
| POSIX | `signal === 'SIGKILL'` **and** `code === null` (the second assertion is new and stricter) |
| Windows | `signal === null` **and** `code !== 0` (a terminated child is never a clean exit) |

**Not skipped.** The abrupt-termination fixture, the WAL-preservation assertion, the
reopen-recovery assertion and the `quick_check` assertion all still run on Windows.

---

## Failure B — `service-process.test.ts` · SIGTERM expected to be graceful

**What failed on Windows.** `child.kill('SIGTERM')` is not a signal delivery on Windows; it
is `TerminateProcess`. No handler runs, no `service.shutdown_complete` line is written and
the exit code is not `0`. The test asserted a POSIX behaviour that Windows does not have.

**Correction.** One combined test became three, each asserting something true on every
platform where it runs:

1. **`without service mode a terminal is not a shutdown button`** — runs **everywhere**.
   Sends the documented command to a child started without `RHODES_SERVICE_MODE`, then
   asserts the process is still alive, that no `service.control_received` appeared, and
   (new) that no `service.shutdown_complete` appeared either.
2. **`SIGTERM is a graceful shutdown on POSIX`** — POSIX only; `t.skip()` with an explicit
   reason on Windows. Unchanged assertions: exit code `0`, final line with
   `reason: 'SIGTERM'`, `ok: true`, plus a new check on `exitCode: 0`.
3. **`a forced termination on Windows is not a graceful shutdown`** — Windows only;
   `t.skip()` on POSIX. Calls `kill()` (i.e. `TerminateProcess`), then asserts
   `signal === null`, `code !== 0`, and that **no** `service.shutdown_complete` line exists.
   This is the mirror image of test 2 and encodes the documentation rule that termination
   is always unclean.

**Coverage is not lost on either side.** Every platform runs test 1; POSIX additionally
runs test 2; Windows additionally runs test 3. Neither failure is "skipped away": each
platform keeps a real, executing assertion about the behaviour it actually has.

**Handler contract, proven platform-independently.** New unit test in
`service-mode.test.ts`: after `wireLifecycle`, exactly one `SIGTERM` listener exists, and
emitting `SIGTERM` calls the stop callback with `('SIGTERM', 0)` — a clean stop, not a fatal
one. This runs on Linux and Windows alike, so the wiring is verified even where the OS does
not deliver the signal.

---

## Documentation

`ARCHITECTURE.md` §10.2 previously said the service could be stopped by "the channel above,
a Windows signal, or the host terminating the Job Object". The middle item was wrong, and
the paragraph now states:

- Windows has no POSIX signals; `SIGTERM`/`SIGINT` are not delivered, and
  `ChildProcess.kill('SIGTERM')` / `.kill()` ends the process through `TerminateProcess`
  with no handler, no final line and no exit code `0`.
- **The only supported graceful Windows stop is the documented stdin command**
  `{"cmd":"shutdown"}`; a future SCM stop request drives the same command.
- Termination (`kill()`, `TerminateProcess`, `TerminateJobObject`) is classified
  **unclean** on every platform: a deadline backstop, never a shutdown mechanism.
- A clean Windows stop remains the conjunction: stdin command **and** exit `0` **and** a
  final `service.shutdown_complete` with `ok: true` **and** an empty Job Object.

§13 gains item 12a recording that the first Windows run exposed these two POSIX assumptions
and what must be confirmed on the host.

---

## Verification performed (Linux only — see the honesty note)

| command | result |
| --- | --- |
| `npm run typecheck` | 0 errors (both configs) |
| `npm test` | **235 declared · 234 passed · 0 failed · 1 skipped** |
| the 1 skip | `a forced termination on Windows is not a graceful shutdown` — Windows-only, skipped on Linux by design |

Expected counts **on Windows after applying this patch** (to be confirmed, not claimed):
235 declared · 232 passed · 0 failed · 3 skipped (the POSIX signal test plus the two
pre-existing Windows skips recorded in the first run).

> **Windows acceptance is not claimed.** This correction was authored and executed on Linux
> x64 only. The Windows branches of both tests have never run. They must be executed on the
> host and their output recorded before anything is called portable.

---

## How to apply

The patch uses ordinary `a/server/…` `b/server/…` paths, so it applies to a working tree
where the v2 package has been installed into `server/`:

```bash
git apply --check handoff/lan-3.2-phase1-v2-windows-portability/WINDOWS-PORTABILITY.patch
git apply        handoff/lan-3.2-phase1-v2-windows-portability/WINDOWS-PORTABILITY.patch
```

or, without git, copy the four corrected files from `files/` over their counterparts
(paths preserved). `SHA256SUMS` lists both the patch and the corrected copies.
