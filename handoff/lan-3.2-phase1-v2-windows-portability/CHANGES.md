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

Diff (cumulative against the accepted v2 base): **4 files, +288 / −9**. No assertion was
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

The graceful-shutdown POSIX test additionally asserts `signal === null` with `code === 0`
(revision 5): a handled `SIGTERM` completes through a normal process exit.
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
- **A handled POSIX `SIGTERM` ends in a normal exit**, not a signal death: Node removes its
  terminate-on-signal default when a listener exists, so the parent sees `signal: null` with
  the code the handler chose (`0`, `69` or `1`).
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
checks **both** the expected exit metadata (`code: null`, `signal: 'SIGTERM'`) **and** the
absence of the shutdown line, and `db-close.test.ts` self-kills with
`process.kill(process.pid, 'SIGKILL')`, which is the `signal: null` path.
**No test was changed** — no defect was found in either. (The "absence of the line, not the
exit metadata" phrasing used in revision 3 was itself inaccurate and is corrected in
revision 4, below.)

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

## Revision 4 — final wording correction (§10.2)

Documentation only: one sentence in `ARCHITECTURE.md` §10.2, plus this note. No test, no
`server/src/` file, no manifest, no migration and no dependency is touched.

**Was:** "The Windows regression test in `service-process.test.ts` therefore asserts the
**absence of that line**, not the exit metadata …". That understated the test, which asserts
all three things:

```ts
assert.equal(exit.code, null, 'a killed child reports no exit code');
assert.equal(exit.signal, 'SIGTERM', 'Node reports the requested signal, not the mechanism');
assert.equal(
  service.lines().some((line) => line.msg === 'service.shutdown_complete'),
  false,
  'a forced termination must not be recorded as a shutdown',
);
```

**Now:** the document states that the test checks both the expected exit metadata and the
absence of that line, and that the **shutdown record — not exit metadata alone — is the
cleanliness discriminator**; the `db-close.test.ts` assertion still says nothing about
cleanliness, only that no shutdown code ran. The rule itself is unchanged from revision 3;
only the description of the evidence changed, so the two statements no longer contradict each
other.

The same phrasing appeared once in this document (§R5) and has been corrected there too.

---

## Revision 5 — a handled signal is not a signal death

Documentation plus one POSIX test assertion. No `server/src/` file, no manifest, no
migration and no dependency is touched, and the Windows test's assertions are unchanged
(only its comment).

### R8 · `ARCHITECTURE.md` §10.2 — "a genuinely graceful POSIX SIGTERM produces the first shape"

**Was:** the document said a graceful POSIX `SIGTERM` produces the Windows forced-termination
shape, `code: null, signal: 'SIGTERM'`. That is wrong. On POSIX, installing a listener
removes Node's default terminate-on-signal behaviour ("`SIGTERM` and `SIGINT` have default
handlers on non-Windows platforms … if one of these signals has a listener installed, its
default behavior will be removed"), so the handler runs, the process calls
`process.exit(...)`, and the kernel reports a **normal exit**: `signal: null` with the code
the handler chose.

The expected RHODES results are therefore:

| outcome | exit metadata |
| --- | --- |
| clean shutdown | `code: 0, signal: null` |
| shutdown ran but a stage failed | `code: 69, signal: null` |
| fatal fault | `code: 1, signal: null` |
| Windows `ChildProcess.kill('SIGTERM')` (forced) | `code: null, signal: 'SIGTERM'` |
| Windows `process.kill(process.pid, 'SIGKILL')` self-kill (forced) | non-zero `code`, `signal: null` |

§10.2 now says exactly that, and the §10.2 classification bullet for POSIX names the normal
exit.

### R9 · `ARCHITECTURE.md` §10 — the footnote under the trigger table

**Was:** "Neither Windows kill path is a shutdown, and the exit metadata cannot tell them
apart from a real one."

**Now:** neither Windows kill operation invokes the shutdown handler; the shape a kill
reports depends on the API (`code: null, signal: <name>` for `ChildProcess.kill()`;
`signal: null` with an ordinary non-zero code for `process.kill()` or `TerminateProcess`);
a POSIX `SIGTERM` that reaches the handler ends in a normal exit with `signal: null` and code
`0`/`69`/`1`; and exit metadata alone is not proof that the shutdown stages ran — the
`service.shutdown_complete` record is.

### R10 · `service-process.test.ts` — Windows comment and a POSIX assertion

- The Windows forced-termination test's comment no longer claims a killed Windows child
  "looks identical to a gracefully terminated POSIX one". It now records that the metadata
  **differs** — Windows reports a signal, a handled POSIX `SIGTERM` reports `signal: null`
  with the handler's code — and that the final `service.shutdown_complete` record is what
  proves the shutdown sequence ran.
- The POSIX test `SIGTERM is a graceful shutdown on POSIX` gains, immediately after the exit
  event:

  ```ts
  assert.equal(exit.signal, null, 'a handled SIGTERM completes through a normal process exit');
  ```

  The existing `exit.code === 0` assertion and every shutdown-record assertion
  (`reason: 'SIGTERM'`, `ok: true`, `exitCode: 0`) are retained. **This assertion runs on
  Linux and passes there** — it is the one part of this work that is not Windows-only.

---

## Revision 6 — §10.2 contradicted itself about Windows stop paths

Documentation only: `ARCHITECTURE.md`. No test, no `server/src/` file, no manifest, no
migration and no dependency is touched.

### R11 · §10.2 introduction misclassified the two graceful Windows paths

**Was:** "**On Windows, three different things are routinely confused.** Only the first is a
graceful stop, and it needs a human at a console:" — which flatly contradicted item 2, whose
whole point is that the stdin command is the supported graceful stop for a service host with
no console.

**Now:** "The first two are graceful stop paths for different contexts; the third is forced
termination:" The three numbered cases and their technical explanations are unchanged.

### R12 · §10.2's "no HTTP shutdown endpoint" paragraph omitted `Ctrl+C`

**Was:** "… the only ways to stop the service are the channel above, a POSIX signal, or the
host terminating the Job Object (which is recorded as unclean)." That list left out the
interactive `Ctrl+C` stop path documented in §10, and its "only ways" claimed completeness
while being incomplete.

**Now:** the paragraph enumerates all four supported stop paths in a table, with availability
and effect:

| path | availability | kind |
| --- | --- | --- |
| `Ctrl+C` at a console | wherever an operator has a console | graceful request |
| the stdin control channel | only when service mode is enabled | graceful request |
| an OS-delivered POSIX `SIGTERM` | POSIX only | graceful request |
| host termination of the Job Object | forced backstop | **not a shutdown**: no handler, no final line, unclean |

It states that the first three can initiate a graceful shutdown and the fourth cannot, that
the result is still decided by the shutdown itself (`0`/`69`/`1`), and that a Windows service
host with no console has only the stdin channel among them.

### R13 · two knock-on consistency edits in §10

Found by the contradiction scan required for this revision, and made because the §10 tables
now enumerate the same set of paths:

- §10's opening prose named only `Ctrl+C` and POSIX `SIGTERM`; it now also names the stdin
  control command, so the prose, the §10 trigger table and the §10.2 table agree.
- §10's trigger table gained the forced-backstop row it was missing (host terminating the Job
  Object: no handler, recorded as unclean), and the footnote under it now says explicitly
  that **no** Windows kill operation — `ChildProcess.kill()`, `process.kill()` or
  `TerminateJobObject` — invokes the handler.

### Contradiction scan performed

| check | result |
| --- | --- |
| claims that a single path is "the only way" to stop | none outside the corrected paragraph |
| "only the first is a graceful stop" | removed |
| §10 table vs §10.2 table vs §13 checklist | same four paths, same availability, same graceful/forced split |
| `Ctrl+C` described as unavailable on Windows | no — it is documented as the interactive-console path on both platforms |
| stdin command described as unavailable on POSIX | no — "available when enabled" on both |
| exit-code expectations (`0`/`69`/`1`) | consistent across §10, §10.2, §13 items 6, 12a and 18g |

---

## Revision 7 — stop-path precision

Documentation only: `ARCHITECTURE.md`. No test, no `server/src/` file, no manifest, no
migration and no dependency is touched.

### R14 · §10.2 — the Job Object backstop is available to the host as well

**Was:** "A Windows service host has no console, so for it only the stdin control channel
among these four is available." The Job Object backstop is available to the host too, so
"only … is available" was wrong about availability even though the graceful conclusion was
right.

**Now:** "A Windows service host has no console, so the stdin control channel is its only
graceful, handler-driven stop path. The Job Object remains available as a forced backstop,
but it cannot run the shutdown handler."

### R15 · §10 — `process.kill(pid, …)` promised too much on POSIX

**Was:** `| process.kill(pid, …) | delivered → handler → exits 0, or 69 | … |`. Not every
POSIX signal can be caught: `SIGKILL` and `SIGSTOP` cannot be handled by any Node.js
listener, so this row claimed a graceful outcome for signals that never reach the handler.

**Now:** the row is `process.kill(pid, 'SIGINT'/'SIGTERM')`, and the POSIX column says these
catchable signals reach their registered handlers, which run the shutdown sequence → exits
`0`, `69` or `1`. The Windows column keeps the existing forced-termination explanation
unchanged. A new sentence under the table states the other half explicitly:

> `SIGKILL` and `SIGSTOP` are not graceful on POSIX either: no Node.js listener can run for
> them, so `process.kill(pid, 'SIGKILL')` ends the process without the handler — the same
> unclean outcome as a Windows kill, which is exactly what the `db-close.test.ts` fixture
> relies on.

### R16 · §10 — "the three cases"

**Was:** "conflating the three cases". The table enumerates six triggers across four distinct
stop paths, so the count was stale.

**Now:** "conflating the different stop paths".

### R17 · §13 — the stdin stop path had no verification item

Found by the required consistency scan, and the only change here that is not one of the three
findings: §13 verified `Ctrl+C` (item 6) and the forced-kill exit shapes (item 12a) but never
the stdin control channel that §10.2 calls the host's only graceful stop path. New item 6a
records what to check on the host — `service.ready` reporting `"serviceMode":true`,
`service.control_received` after `{"cmd":"shutdown"}`, a final `service.shutdown_complete`
with `ok: true`, exit `0`, and an empty Job Object — and notes that stdin EOF is a different
(also shutting-down) path, not the graceful command. Nothing else in §13 was renumbered.

### R18 · §13 item 6a — the two stdin environments, and what EOF proves

Found on review of R17: item 6a allowed either a future service host or a plain shell with
piped stdin, then unconditionally required that the Job Object be empty — which a plain-shell
run cannot satisfy, because there is no Job Object in play. And its EOF sentence said only
"a different path", without saying what the existing test actually expects.

**Now** item 6a splits the environments:

- **Plain shell, no service host** — `RHODES_SERVICE_MODE=1` with piped stdin,
  `service.ready` reporting `"serviceMode":true`, then `{"cmd":"shutdown"}`; expect
  `service.control_received`, a final `service.shutdown_complete` with `ok: true` and
  `reason: "stdin"`, exit code `0`, and no orphaned child. No Job Object assertion.
- **Future .NET service host** — the same protocol test through the host, **plus** the empty
  Job Object, which applies to that environment only.

The EOF paragraph now states what it is and what the test expects: closing stdin without the
command is a separate automatic stop trigger, it requests shutdown with reason `stdin-eof`,
logs `service.stdin_eof`, and `service-process.test.ts` expects a final
`service.shutdown_complete` with `ok: true` and exit code `0`. It proves the orphan guard,
not the control command, and must not be recorded as a successful `{"cmd":"shutdown"}` test.

Both claims were checked against the code: `src/serviceMode.ts` requests `'stdin'` for the
command and `'stdin-eof'` from the `end` handler after logging `service.stdin_eof`, and
`service.control_received` is logged for either request. The four-path classification and
every other Revision 7 correction are unchanged.

### Consistency scan performed (§10, §10.2, §13)

| check | result |
| --- | --- |
| four stop paths named identically in both tables | `Ctrl+C` at a console; stdin control channel; OS-delivered POSIX `SIGTERM`; Job Object termination |
| graceful vs forced split | first three graceful (handler runs, result decided by `0`/`69`/`1`); Job Object forced and unclean |
| availability per platform | `Ctrl+C` needs a console on both platforms; `SIGTERM` POSIX only; stdin only in service mode; Job Object Windows only |
| host availability wording | corrected in R14 — graceful path is stdin only, forced backstop remains |
| any claim that a kill invokes the handler | none; `SIGKILL`/`SIGSTOP` now stated explicitly as uncatchable |
| exit-code expectations | `0` / `69` / `1` consistent across §10, §10.2, §13 items 6, 6a, 12a and 18g |

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
