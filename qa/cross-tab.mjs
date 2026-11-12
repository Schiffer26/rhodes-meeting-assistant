// RHODES 1.3.12 · P3-H1 correction — cross-tab lease QA (jsdom, isolated entry)
//
// Two stores, one storage cell, one lock manager. Checks the rule that matters:
// a window that does not hold the lease can never put its document on top of
// newer records — and that the window which does hold it still behaves exactly
// like the Phase 3 Task 1 implementation once it is alone.
//
// A second run without a Web Locks API checks the documented fallback: writes
// are allowed, but a window whose copy went stale refuses to publish it.
//
//   node qa/cross-tab.mjs   (run from the repository root; Linux, macOS or Windows)
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const entry = path.join(repoRoot, "qa", "cross-tab-entry.tsx");

// A private build directory under the platform's temporary directory. `os.tmpdir()`
// is /tmp on Linux, /var/folders/... on macOS and %LOCALAPPDATA%\Temp on Windows,
// where a literal "/tmp" does not exist. `mkdtemp` makes the name unique, so two
// runs — or two checkouts — never collide, and nothing is written into the repo.
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhodes-cross-tab-"));
const bundlePath = path.join(buildDir, "cross-tab.js");

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
  } catch {
    // Windows can still hold a handle to a just-written file. Best effort: the
    // directory is in the OS temp area and the next run uses a fresh one.
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// The bundling options, as values rather than shell words, so a checkout under
// "C:\Users\Jane Doe\..." needs no quoting anywhere.
const buildOptions = {
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  outfile: bundlePath,
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  alias: { "@": path.join(repoRoot, "src") },
  logLevel: "warning",
};

// The same options for esbuild's own CLI, used only by the fallback below.
const cliArgs = [
  entry,
  "--bundle",
  "--format=iife",
  `--outfile=${bundlePath}`,
  "--loader:.css=empty",
  "--loader:.woff2=empty",
  "--loader:.woff=empty",
  '--define:process.env.NODE_ENV="production"',
  "--jsx=automatic",
  `--alias:@=${path.join(repoRoot, "src")}`,
  "--log-level=warning",
];

/**
 * Bundle the QA entry with esbuild.
 *
 * esbuild's JavaScript API is tried first: paths are passed as values (no shell
 * to mangle backslashes or split on spaces) and it works identically on every
 * platform. If esbuild cannot be resolved as a module, the same options go to
 * esbuild's native binary through `execFileSync(binary, [...])` — an argument
 * array straight to the process, again with no shell in between.
 *
 * `RHODES_QA_ESBUILD=cli` forces the second route, which is how the fallback is
 * exercised here (`RHODES_QA_ESBUILD=cli node qa/cross-tab.mjs`); the default
 * needs no environment at all.
 */
const buildBundle = () => {
  const forceCli = process.env.RHODES_QA_ESBUILD === "cli";
  let esbuild = null;
  if (!forceCli) {
    try {
      esbuild = require("esbuild");
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (esbuild) {
    esbuild.buildSync(buildOptions);
    return;
  }
  // The native esbuild binary: the platform package first (that is where npm
  // puts it, as `esbuild.exe` on Windows), then the copy esbuild's own install
  // script leaves in bin/.
  const platformPkg = path.join(repoRoot, "node_modules", "@esbuild", `${process.platform}-${process.arch}`);
  const candidates = [
    path.join(platformPkg, "bin", "esbuild"),
    path.join(platformPkg, "esbuild.exe"),
    path.join(repoRoot, "node_modules", "esbuild", "bin", "esbuild"),
    path.join(repoRoot, "node_modules", "esbuild", "bin", "esbuild.exe"),
  ];
  const bin = candidates.find((candidate) => fs.existsSync(candidate));
  if (!bin) {
    throw new Error("esbuild is not installed — run `npm install` in the repository root first");
  }
  execFileSync(bin, cliArgs, { cwd: repoRoot, stdio: "inherit" });
};

let bundle;
try {
  buildBundle();
  bundle = fs.readFileSync(bundlePath, "utf8");
} finally {
  // The bundle is in memory now; the temporary directory is not needed again.
  cleanup();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} · ${name}${extra ? " — " + extra : ""}`);

async function boot({ locks, cell = null, manualLocks = false, settle = 600 }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("error", (m) => errors.push("CONSOLE: " + m));
  vc.on?.("jsdomError", (e) => errors.push("JSDOM: " + (e.message || String(e))));

  const dom = new JSDOM(
    `<!doctype html><html data-theme="terminal" data-motion="off"><body><div id="root"></div></body></html>`,
    { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/", virtualConsole: vc },
  );
  const { window } = dom;
  window.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.Element.prototype.scrollTo = function () {};
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 8);
  window.URL.createObjectURL = () => "blob:fixture";
  window.URL.revokeObjectURL = () => {};
  window.__qa = { cell: { raw: cell }, locks, manualLocks, tabs: [], unmountTab: () => {}, actions: [] };

  const script = window.document.createElement("script");
  script.textContent = bundle;
  window.document.body.appendChild(script);
  script.remove();
  await wait(settle);

  const qa = window.__qa;
  const act = (index, name, ...args) => qa.actions[index][name](...args);
  const tabState = async (index) => (await act(index, "tab"));
  const raw = () => qa.cell.raw;
  const doc = () => JSON.parse(qa.cell.raw ?? "{}");
  const noteText = () => (doc().notes || []).find((n) => n.meetingId === "m_a")?.content ?? "";
  return { window, qa, act, tabState, raw, doc, noteText, errors, dom };
}

// ── 1 · with a lock manager: exactly one writer ────────────────────────────
{
  const { window, qa, act, tabState, raw, doc, noteText, errors } = await boot({ locks: true });

  const tab0 = await tabState(0);
  const tab1 = await tabState(1);
  check("A1 the first window becomes the writer", tab0.writeLease === "owner" && tab0.readOnly === false, JSON.stringify({ lease: tab0.writeLease }));
  check("A2 the second window is read-only", tab1.writeLease === "waiting" && tab1.readOnly === true, JSON.stringify({ lease: tab1.writeLease }));

  const before = raw();
  const refused = await act(1, "saveNote", "<p>READ-ONLY-EDIT</p>");
  const afterRefused = raw();
  check("A3 an edit in the read-only window is refused", refused.accepted === false, JSON.stringify(refused));
  check("A4 the refused edit never reaches storage", afterRefused === before, `${before.length} chars`);
  check("A5 the read-only window never called the adapter", (tab1.saveCalls ?? 0) === 0, `saveCalls=${tab1.saveCalls ?? 0}`);

  // its lifecycle flush must not write either, and must keep the draft
  qa.tabs[1].draft = "<p>DRAFT-IN-READ-ONLY-WINDOW</p>";
  const flushRefused = await act(1, "flushSync");
  check("A6 the lifecycle flush is refused in the read-only window",
    flushRefused.ok === false && /read-only|Another RHODES window/i.test(flushRefused.error || ""), JSON.stringify(flushRefused));
  check("A7 … and it reports that a draft is at stake", flushRefused.pending === true);
  check("A8 … and it wrote nothing", raw() === before, `${before.length} chars`);
  check("A9 … and the draft was not taken out of the editor",
    (qa.tabs[1].last?.handover ?? null) === null, JSON.stringify(qa.tabs[1].last ?? {}));
  qa.tabs[1].draft = null;

  // the writer works normally
  await act(0, "saveNote", "<p>OWNER-CHANGE</p>");
  const ownerFlush = await act(0, "flushSync");
  check("B1 the writing window still saves", ownerFlush.ok === true && noteText() === "<p>OWNER-CHANGE</p>", JSON.stringify(ownerFlush));

  // ★ the defect: the stale read-only window is hidden and flushed
  qa.tabs[1].draft = "<p>STALE-TAB-DRAFT</p>";
  const staleFlush = await act(1, "flushSync");
  check("B2 the stale window's flush is refused", staleFlush.ok === false, JSON.stringify(staleFlush));
  check("B3 ★ the newer record survives the stale window's flush",
    noteText() === "<p>OWNER-CHANGE</p>", noteText());
  check("B4 the stale draft was not written anywhere",
    !String(raw()).includes("STALE-TAB-DRAFT"), `${raw().length} chars`);
  qa.tabs[1].draft = null;

  const meetingsBefore = doc().meetings.length;
  await act(1, "addMeeting", "READ-ONLY-MEETING");
  check("B5 a record created in the read-only window is not stored",
    doc().meetings.length === meetingsBefore && !String(raw()).includes("READ-ONLY-MEETING"), `${meetingsBefore} → ${doc().meetings.length}`);

  // ── hand-over ─────────────────────────────────────────────────────────
  qa.unmountTab(0);
  await wait(400);
  const tab1After = await tabState(1);
  check("C1 the remaining window is granted the lease", tab1After.writeLease === "owner" && tab1After.readOnly === false,
    JSON.stringify({ lease: tab1After.writeLease }));
  check("C2 it adopted what the owner wrote", noteText() === "<p>OWNER-CHANGE</p>", noteText());

  await act(1, "saveNote", "<p>AFTER-HANDOVER</p>");
  const handoverFlush = await act(1, "flushSync");
  check("C3 it can write once it owns the lease",
    handoverFlush.ok === true && noteText() === "<p>AFTER-HANDOVER</p>", JSON.stringify(handoverFlush));

  // ── the best-effort staleness check ───────────────────────────────────
  const tampered = JSON.stringify({ ...JSON.parse(raw()), decisions: [{ id: "d_x" }] });
  qa.cell.raw = tampered;                       // a write this window never made
  await act(1, "saveNote", "<p>AFTER-EXTERNAL-WRITE</p>");
  const guardFlush = await act(1, "flushSync");
  check("D1 a window whose copy went stale refuses to publish it",
    guardFlush.ok === false && /changed by another RHODES window/i.test(guardFlush.error || ""), JSON.stringify(guardFlush));
  check("D2 … and storage keeps the newer bytes", raw() === tampered && !String(raw()).includes("AFTER-EXTERNAL-WRITE"));

  check("E1 no console errors or unhandled rejections", errors.length === 0, errors.join(" | "));
}

// ── 2 · no Web Locks: documented fallback, stale writes still refused ─────
{
  const { qa, act, tabState, raw, noteText, errors } = await boot({ locks: false });

  const tab0 = await tabState(0);
  const tab1 = await tabState(1);
  check("F1 without Web Locks the state is reported honestly",
    tab0.writeLease === "unsupported" && tab1.writeLease === "unsupported",
    JSON.stringify({ a: tab0.writeLease, b: tab1.writeLease }));
  check("F2 neither window is put into read-only mode", tab0.readOnly === false && tab1.readOnly === false);

  await act(0, "saveNote", "<p>NO-LOCKS-OWNER</p>");
  await act(0, "flushSync");
  check("F3 the first window writes normally", noteText() === "<p>NO-LOCKS-OWNER</p>", noteText());

  await act(1, "saveNote", "<p>NO-LOCKS-STALE</p>");
  const stale = await act(1, "flushSync");
  check("F4 a window whose copy is stale still refuses to overwrite newer records",
    stale.ok === false && /changed by another RHODES window/i.test(stale.error || ""), JSON.stringify(stale));
  check("F5 … and the newer record is intact", noteText() === "<p>NO-LOCKS-OWNER</p>", noteText());
  void raw; void qa;
  // Documented limitation, asserted so a future change cannot claim protection
  // that does not exist: without a lease, an ordinary debounced edit is not
  // compared against storage at all. Only the lifecycle flush is guarded, which
  // is what the single-window notice tells the operator.
  const debounced = await act(1, "saveNote", "<p>NO-LOCKS-DEBOUNCED-STALE</p>");
  await wait(500);
  check("F7 (documented limitation) without Web Locks an ordinary debounced edit is not compared against storage",
    debounced.accepted === true && String(raw()).includes("NO-LOCKS-DEBOUNCED-STALE"), JSON.stringify(debounced));
  qa.cell.raw = JSON.stringify({ ...JSON.parse(raw()), decisions: [{ id: "d_y" }] });   // a newer write again
  const guardAgain = await act(1, "flushSync");
  check("F8 … while the lifecycle flush still refuses to publish the older document",
    guardAgain.ok === false, JSON.stringify(guardAgain));
  check("F6 no console errors or unhandled rejections", errors.length === 0, errors.join(" | "));
}

// ── 3 · the lease request has not been answered yet (startup "pending") ───
{
  const booted = await boot({ locks: true, manualLocks: true, settle: 20 });
  const { qa, act, tabState, raw, errors } = booted;
  const early = await tabState(0);
  check("G1 before the grant arrives the window reports that it cannot write",
    early.writeLease === "pending" && early.canWrite === false && early.readOnly === false,
    JSON.stringify({ lease: early.writeLease, canWrite: early.canWrite, readOnly: early.readOnly }));
  const refused = await act(0, "saveNote", "<p>PENDING-EDIT</p>");
  check("G2 an edit made while the request is queued is refused, not deferred",
    refused.accepted === false, JSON.stringify(refused));
  check("G3 … and nothing reaches storage", !String(raw()).includes("PENDING-EDIT"));

  // A grant that never comes must not leave the window looking normal.
  await wait(600);
  const queued = await tabState(0);
  check("G4 a window whose request is still queued switches to the read-only notice",
    queued.writeLease === "waiting" && queued.readOnly === true && queued.canWrite === false,
    JSON.stringify({ lease: queued.writeLease, readOnly: queued.readOnly }));

  qa.releaseLocks();
  await wait(120);
  const granted = await tabState(0);
  check("G5 the grant makes the same window writable",
    granted.writeLease === "owner" && granted.canWrite === true, JSON.stringify({ lease: granted.writeLease }));
  const written = await act(0, "saveNote", "<p>AFTER-GRANT</p>");
  await wait(500);                                   // the store's 280 ms debounce
  check("G6 its edit is then stored", written.accepted === true && String(raw()).includes("AFTER-GRANT"));
  check("G7 no console errors or unhandled rejections", errors.length === 0, errors.join(" | "));
}

const failures = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
