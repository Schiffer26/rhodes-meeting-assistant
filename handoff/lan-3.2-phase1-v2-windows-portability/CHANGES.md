# RHODES · LAN-3.2 · Phase 1 v2 — Windows portability correction

**Base:** `review/lan-3.2-phase1-v2-handoff` (`5317b14`, the accepted v2 handoff).
**Scope:** four files — **tests and documentation only**. No file under `server/src/` is
touched, so no runtime contract changes and nothing about the implementation is re-opened.

| file | kind | change |
| --- | --- | --- |
| `server/test/db-close.test.ts` | test | abrupt-child termination assertion is now platform-aware |
| `server/test/service-process.test.ts` | test | `SIGTERM` graceful-shutdown test split POSIX/Windows; new Windows forced-termination test |
| `server/test/service-mode.test.ts` | test | new unit test: the registered `SIGTERM` handler requests a clean stop (reason `SIGTERM`, code `0`) |
| `server/ARCHITECTURE.md` | docs | signal semantics per platform; `Ctrl+C`, the service stdin command and a programmatic kill are three distinct cases; termination is classified per platform (§13 typo fixed) |

Diff (cumulative against the accepted v2 base): **4 files, +230 / −8**. No assertion was
removed or loosened; every original claim still holds on the platform where it is true.

> **Revision 2.** A review of the first correction found three claims wrong. They are fixed
> by a second commit on the same branch — nothing was rewritten or force-pushed. The
> corrections are recorded in [§ Revision 2](#revision-2--corrections-to-the-first-correction)
> at the end; the text below has been corrected in place so no obsolete claim survives.

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
3. **`a forced termination on Windows is reported as a signal death but is not a shutdown`**
   — Windows only; `t.skip()` on POSIX. Calls `kill()` (which Node emulates with
   `TerminateProcess`), then asserts `code === null`, `signal === 'SIGTERM'`, and that
   **no** `service.shutdown_complete` line exists. The exit metadata is the *mechanism*;
   the missing shutdown record is the *outcome*, and only the second is evidence about our
   code.

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

- **Interactive `Ctrl+C`** reaches the registered `SIGINT` handler on Windows too, and is a
  graceful stop for an operator at a console — exit `0` when every shutdown stage succeeds,
  `69` when one fails. It stays in the §13 checklist.
- **A Windows service host** has no console and receives no `SIGTERM` — `SIGTERM` "is not
  supported on Windows, it can be listened on", i.e. never received — so **the supported
  graceful stop for the host is the documented stdin command** `{"cmd":"shutdown"}`, which
  a future SCM stop request will drive.
- **A programmatic kill is not a signal delivery.** `ChildProcess.kill('SIGINT')/('SIGTERM')`
  and `process.kill(pid, …)` both terminate unconditionally through `TerminateProcess`, and
  neither runs the target's shutdown handler. What the parent *observes* differs by API —
  `uv_process_kill()` records the request (`code: null`, `signal: 'SIGTERM'`), `uv_kill()`
  records nothing (`code: 1`, `signal: null`) — so exit metadata alone never decides whether
  a shutdown was clean.
- Termination is **not** uniformly unclean: a POSIX `SIGTERM` delivered to the handler is
  potentially graceful and is judged by the shutdown result, whereas the Windows kill
  emulation and `TerminateProcess`/`TerminateJobObject` are forceful and unclean.
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
| the 1 skip | `a forced termination on Windows is reported as a signal death but is not a shutdown` — Windows-only, skipped on Linux by design |

Re-run after the revision 2 corrections: identical counts (typecheck 0 errors; targeted run
of the three files 31 declared · 30 passed · 1 skipped; full suite 235 · 234 · 0 · 1).

Expected counts **on Windows after applying this patch** (to be confirmed, not claimed):
235 declared · 232 passed · 0 failed · 3 skipped (the POSIX signal test plus the two
pre-existing Windows skips recorded in the first run).

> **Windows acceptance is not claimed.** This correction was authored and executed on Linux
> x64 only. The Windows branches of both tests have never run. They must be executed on the
> host and their output recorded before anything is called portable.

---

## Revision 2 — corrections to the first correction

The first correction carried three claims that are wrong. Each is fixed below, with the
source that decides it. Nothing was rewritten or force-pushed: this is an additional commit
on top of the existing one.

### R1 · `service-process.test.ts` — what a Windows `kill()` reports

**Was:** `assert.equal(exit.signal, null)` and `assert.notEqual(exit.code, 0)`.

**Now:** `assert.equal(exit.code, null)` and `assert.equal(exit.signal, 'SIGTERM')`. The
"no `service.shutdown_complete` line" assertion is unchanged and is still the assertion that
carries the outcome.

**Why:** Node documents the emulation explicitly (process docs, *Signal events*): "Windows
does not support signals so has no equivalent to termination by signal, but Node.js offers
some emulation with `process.kill()`, and `subprocess.kill()`: sending `SIGINT`, `SIGTERM`,
and `SIGKILL` will cause the unconditional termination of the target process, **and
afterwards, `subprocess` will report that the process was terminated by signal**."

The mechanism is in libuv, `src/win/process.c`:

| line | code | effect |
| --- | --- | --- |
| 1385 | `TerminateProcess(process_handle, 1)` inside `uv__kill()` | the process is ended forcefully, exit code 1 |
| 1457 | `process->exit_signal = signum` in `uv_process_kill()` | the *requested* signal is recorded on the handle |
| 860 | `handle->exit_cb(handle, exit_code, handle->exit_signal)` | the recorded signal is what the parent is given |

Node turns that into `exit(null, 'SIGTERM')`, so `code` is `null` and `signal` is the
requested name. **Note the two kill APIs differ** `[INFER from the same source, not yet run
on Windows]`: `ChildProcess.kill()` goes through `uv_process_kill()` and records a signal;
`process.kill(pid, …)` goes through `uv_kill()`, which has no process handle to record on,
so the parent sees an exit code and `signal: null`. That is why the `db-close.test.ts`
assertion is *not* changed here — its fixture kills **itself** with
`process.kill(process.pid, 'SIGKILL')`, which is the second path. (Its comment says
`signal` is "always" `null`; the statement holds for the path it uses, and revision 3 makes
the two-path distinction explicit in `ARCHITECTURE.md` rather than editing the test.)

### R2 · `ARCHITECTURE.md` §10 and §10.2 — "Node does not deliver SIGTERM or SIGINT to a Windows process"

**Was:** that sentence, with the stdin command named as "exactly one supported trigger".

**Now:** three cases, kept apart — the paragraph states, and the §10 table tabulates:

1. **Interactive `Ctrl+C`** produces a console control event that Node raises as `SIGINT`;
   the registered handler runs and the process exits `0` if every stage succeeded. Node:
   "`SIGINT` from the terminal is supported on all platforms, and can usually be generated
   with `Ctrl+C`." This stays in the §13 Windows verification checklist (item 6 unchanged,
   and item 12a now names it).
2. **A Windows service host** has no console and receives no `SIGTERM` — "`SIGTERM` is not
   supported on Windows, it can be listened on", i.e. the listener never fires — so the
   **stdin command** `{"cmd":"shutdown"}` is the supported graceful stop for the host, and a
   future SCM stop request will drive it.
3. **Programmatic `ChildProcess.kill('SIGINT'/'SIGTERM')`** delivers nothing to the handler:
   it is forceful termination that is nonetheless reported as a signal death (R1).

### R3 · `ARCHITECTURE.md` §10.2 — "termination is unclean on every platform"

**Was:** `kill()`, `TerminateProcess` and `TerminateJobObject` classified unclean
everywhere.

**Now:** classified per case — a POSIX `SIGTERM` delivered to the registered handler is
**potentially graceful**, and whether it was clean is decided by the result itself (exit
`0`, final line `ok: true`), not by the fact that a signal started it; the Windows
`ChildProcess.kill()` emulation and Windows `TerminateProcess`/`TerminateJobObject` are
**forceful and unclean**. The only-true claim that survives unchanged is that a *Windows*
graceful stop is the stdin command, and the four-part conjunction for calling a Windows stop
clean is untouched.

### R4 · `ARCHITECTURE.md` §13 — typo

`specify /child` (a mangled path introduced with item 12a) is gone; the sentence now states
the corrected expectation — a killed child reports `code: null, signal: 'SIGTERM'` and still
leaves no `service.shutdown_complete` line, and an interactive `Ctrl+C` produces a final
line and exit `0` — or the documented `69` when a stage failed (§10.1).

### What revision 2 does not change

No file under `server/src/`, no `package.json`/`package-lock.json`, no migrations, no
frontend. No assertion weakened, no test removed, no test newly skipped: POSIX still runs
the graceful `SIGTERM` test and Windows still runs the forced-termination test.

> **Still not Windows-accepted.** The corrected Windows assertions were derived from the
> Node documentation and the libuv source above and have **not** executed on Windows — no
> Windows host was available. They must pass there before the portability claim is accepted,
> and if the host disagrees with the documentation, the host's output wins and the assertion
> gets fixed again.

---

## Revision 3 — documentation consistency

Two further inconsistencies were found by review, both documentation-only. No test, no
`server/src/` file, no manifest, no migration and no dependency is touched by this revision.

### R5 · `ARCHITECTURE.md` §10 and §10.2 — `ChildProcess.kill()` is not `process.kill(pid, …)`

Revision 2 grouped the two APIs and then stated one exit shape (`code: null,
signal: 'SIGTERM'`), while CHANGES already recorded that they take different libuv paths.
The architecture document now separates them:

| call | libuv path | parent's exit event on Windows |
| --- | --- | --- |
| `ChildProcess.kill(sig)` | `uv_process_kill()` → `process->exit_signal = signum` | `code: null`, `signal: <requested name>` |
| `process.kill(pid, sig)` (including a self-kill) | `uv_kill()` — no child-process handle to record on | `TerminateProcess`'s code (normally `1`), `signal: null` |

§10's trigger table gained a row per API; §10.2's third case became a two-row table with the
libuv path named for each, plus the rule that follows from it:

- both APIs terminate the target forcefully on Windows;
- neither invokes the application's shutdown handler, so neither writes
  `service.shutdown_complete`;
- the reported metadata depends on the API *and* on how the parent observes the child;
- therefore **exit metadata alone never decides whether a shutdown was clean** — the final
  shutdown record (`ok`) and the exit code (`0` / `69` / `1`, §10.1) are the evidence.

It also states why the two existing tests assert what they assert: `service-process.test.ts`
checks the **absence of the shutdown line** (not the metadata), and `db-close.test.ts`
self-kills with `process.kill(process.pid, 'SIGKILL')`, which is the `signal: null` path.
**No test was changed** — no defect was found in either.

### R6 · `ARCHITECTURE.md` §10, §10.2 and §13 — `Ctrl+C` and exit code `69`

Revision 2's Windows text said `Ctrl+C` "exits `0`" unconditionally. A graceful request is
not a guaranteed clean result: the handler runs and the process exits `0` **only when the
listener close, the checkpoint, the database close and the close's own verdict all
succeeded**; a stop that ran but failed a stage exits `69` (§10.1), and a fatal fault stays
`1`. The §10 table, §10.2 item 1 and §13 item 6 now say so, and §13 item 6 keeps the
graceful `Ctrl+C` check while accepting the documented `69` outcome as a failed stage rather
than a failed `Ctrl+C` path.

### R7 · `ARCHITECTURE.md` §13 — checklist numbering and item 6

Item `12a` sat **before** item `12` — introduced that way in the first correction and not
noticed until this consistency pass. It now follows item 12, and its text names the
`uv_kill()` path so that it agrees with §10.2 instead of describing a bare `TerminateProcess`
death. Item 12a also states both expected Windows exit shapes, and the HTTPS `Ctrl+C` step
accepts `69` as the documented outcome of a failed stage.

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
