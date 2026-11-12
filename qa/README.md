# RHODES · reproduction harnesses for the multi-window protections

These are the harnesses that prove the 1.3.12 Phase 3 follow-up (one writer
at a time, and a back/forward-cache-restored window that must ask for the lease
again). They live in the repository so the result can be re-run instead of
taken on trust. They are not part of the build: Vite only bundles `src/`, and
nothing here is imported by the application.

Everything runs against a **dedicated dev origin in an isolated browser
profile** (a fresh temporary profile per launch). No harness can reach, reset or
overwrite the records of a real RHODES installation.

The harnesses run on Linux, macOS and Windows. They never use a fixed `/tmp`:
build output and browser profiles go to the operating system's temporary
directory (`os.tmpdir()` — `/tmp` on Linux, `/var/folders/...` on macOS,
`%LOCALAPPDATA%\Temp` on Windows), in a directory whose name is unique per run,
and it is deleted when the process exits. Paths are passed as values, never as
shell-quoted strings, so a checkout under `C:\Users\Jane Doe\rhodes` works.

## 1 · Cross-tab lease, two stores over one storage cell (`cross-tab.mjs`)

jsdom, no browser needed, ~5 s. Mounts two independent `DataProvider`s over one
shared storage cell and one Web Locks stand-in, then checks that a window
without the lease can never publish its document, that the hand-over works, and
that the no-Web-Locks fallback is honest.

```bash
node qa/cross-tab.mjs
```

The entry is bundled with `esbuild` (already available through Vite's
dependency tree) and the `@` alias pointing at `src/`. esbuild's JavaScript API
is used first, so no shell is involved and paths with spaces or backslashes need
no quoting; if esbuild cannot be resolved as a module, the harness falls back to
the native binary via `execFileSync` with an argument array.
`RHODES_QA_ESBUILD=cli node qa/cross-tab.mjs` forces that fallback. The bundle is
written to a private directory under `os.tmpdir()` and removed before the tests
start — nothing is left behind, in the repository or elsewhere.

## 2 · Cross-tab lease in a real browser (`cross-tab-browser.cjs`)

Two genuine tabs of one origin in one browser profile, real clicks and real
keyboard, one headless Chromium. Covers: a read-only window's meeting and draft
never reach storage; the writer's records survive a stale window being hidden;
the hand-over on close and the adoption of what the other window saved.

```bash
# in one terminal
npx vite --port 5193 --host 127.0.0.1 --strictPort
# in another
node qa/cross-tab-browser.cjs          # QA_PORT=5193 is the default
```

On Windows, the PowerShell equivalent of this and of the other suites is in
*Running all three*, below.

## 3 · Back/forward cache: a restored window must not write (`bfcache-browser.cjs`)

Two genuine tabs, one profile, and the writer-lease lifecycle across a cache
freeze and restore. Covers the ordering on the way out (flush while the window
still owns the lease, then hand it back), the restore (non-writable before the
new request, and not writable until the grant), the reload on grant, and the
stale-document refusal in between.

The refusal checks (BF14a-f) are evidence rather than decoration: they require
the *same restored document* to open the meeting form, enter a title and press
the submit button, and they fail if any of that could not be done. A marker set
in the page before the attempt proves it did not run in a reloaded page, where
every protection would hold trivially; the refusal must also be visible on
screen (the form stays open and says the meeting was not saved). Removing the
protection makes these checks fail with a *success* toast and a changed
document — exactly the lie they exist to catch.

```bash
node qa/bfcache-browser.cjs            # QA_PORT=5193 is the default
```

On Windows, use the PowerShell form in *Running all three* (`$env:QA_PORT`,
`$env:CHROME_PATH`).

### The one thing that is simulated, and why

The Chromium available in this environment cannot enter the back/forward cache:
a control experiment with two plain static pages and **no** event handlers of any
kind shows `pagehide.persisted === false` and a fresh document on Back. So the
transition is delivered as the **real** `PageTransitionEvent` the browser would
fire — `new PageTransitionEvent("pagehide", { persisted: true })` and the matching
`pageshow` — dispatched to the application's own listeners in a live document.
Everything else is genuine: two browser tabs, one profile, one storage area, real
`navigator.locks` arbitration, real clicks and typing. The harness prints the
recorded lifecycle timeline and the raw storage counts it asserts on, and
scenario R exercises a *real* navigation (where the browser fires its own
`pagehide`) so the release-on-hide ordering and the fresh-boot path are covered
without any simulation.

## Running all three

Every suite reads `QA_PORT` (default `5193`). The two browser suites need a dev
server on that port serving the repository; `cross-tab.mjs` needs only Node.

### Linux / macOS (bash or zsh)

```bash
node qa/cross-tab.mjs                       # 35 checks, no browser, ~5 s

npx vite --port 5193 --host 127.0.0.1 --strictPort   # in its own terminal
node qa/cross-tab-browser.cjs               # 24 checks
node qa/bfcache-browser.cjs                 # 32 checks

# a different port, if 5193 is taken
QA_PORT=5200 node qa/bfcache-browser.cjs

# an explicit browser
CHROME_PATH=/usr/bin/google-chrome node qa/bfcache-browser.cjs
```

### Windows (PowerShell)

Run these from the repository root; `\` or `/` both work in the paths.

```powershell
node qa/cross-tab.mjs

# in its own PowerShell window
npx vite --port 5193 --host 127.0.0.1 --strictPort

# in a second PowerShell window
node qa/cross-tab-browser.cjs
node qa/bfcache-browser.cjs

# a different port, and an explicit browser
$env:QA_PORT = "5200"
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node qa/bfcache-browser.cjs
```

`$env:NAME = "value"` sets a variable for that PowerShell session
(`Remove-Item Env:QA_PORT` clears it); in `cmd.exe` the equivalent is
`set QA_PORT=5200`. If the browser cannot be found, the suites stop with
puppeteer's `Could not find Chrome` — set `CHROME_PATH` as above.

### Chromium

Both browser suites drive `puppeteer-core`, which ships no browser of its own.
The executable is resolved in this order:

1. **`CHROME_PATH`** — any Chrome, Chromium or Edge binary you point at.
2. **`@sparticuz/chromium`**, if it is installed (it is only present in the
   Linux environment these were written in; `npm i -D @sparticuz/chromium`).
3. **`puppeteer.executablePath()`** — the browser downloaded by the `puppeteer`
   package, after `npx puppeteer browsers install chrome`.

On Windows the usual locations are
`C:\Program Files\Google\Chrome\Application\chrome.exe` and
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`; Edge is
Chromium and works. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Both suites launch headless with `--no-sandbox`, which is what makes them work
in containers; on a desktop Windows machine that flag is harmless.
