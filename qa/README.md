# RHODES · reproduction harnesses for the multi-window protections

These are the two harnesses that prove the 1.3.12 Phase 3 follow-up (one writer
at a time, and a back/forward-cache-restored window that must ask for the lease
again). They live in the repository so the result can be re-run instead of
taken on trust. They are not part of the build: Vite only bundles `src/`, and
nothing here is imported by the application.

Everything runs against a **dedicated dev origin in an isolated browser
profile** (a fresh temporary profile per launch). No harness can reach, reset or
overwrite the records of a real RHODES installation.

## 1 · Cross-tab lease, two stores over one storage cell (`cross-tab.mjs`)

jsdom, no browser needed, ~5 s. Mounts two independent `DataProvider`s over one
shared storage cell and one Web Locks stand-in, then checks that a window
without the lease can never publish its document, that the hand-over works, and
that the no-Web-Locks fallback is honest.

```bash
node qa/cross-tab.mjs
```

Uses `esbuild` (already available through Vite's dependency tree) with the `@`
alias pointing at `./src`, so run it from the repository root.

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

## 3 · Back/forward cache: a restored window must not write (`bfcache-browser.cjs`)

Two genuine tabs, one profile, and the writer-lease lifecycle across a cache
freeze and restore. Covers the ordering on the way out (flush while the window
still owns the lease, then hand it back), the restore (non-writable before the
new request, and not writable until the grant), the reload on grant, and the
stale-document refusal in between.

```bash
node qa/bfcache-browser.cjs            # QA_PORT=5193 is the default
```

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

## Chromium

`CHROME_PATH` selects a browser binary. Without it the harnesses use the Lambda
build (`@sparticuz/chromium`) if it is installed, then `puppeteer.executablePath()`:

```bash
CHROME_PATH=/usr/bin/google-chrome node qa/bfcache-browser.cjs
```

`puppeteer-core` and `puppeteer` are already dependencies of this project;
`@sparticuz/chromium` is only present in the environment these were written in
(`npm i -D @sparticuz/chromium` if you want that path).
