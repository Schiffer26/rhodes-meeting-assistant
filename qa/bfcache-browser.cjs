// RHODES 1.3.12 · P3-H1 follow-up — BFCache writer-lease regression.
//
// Two genuine tabs of one origin in one isolated browser profile, sharing one
// storage area. The back/forward-cache transition is delivered as the real
// `PageTransitionEvent` the browser fires (`pagehide` / `pageshow` with
// `persisted: true`) to the application's own listeners, because the Chromium
// available in this sandbox cannot enter the back/forward cache at all — a
// control experiment with two plain static pages, no handlers of any kind, shows
// `pagehide.persisted === false` and no restore. See qa/README.md.
//
// A second scenario (R) uses a *real* navigation, so the release-on-hide
// ordering and the fresh-boot path are exercised by the browser itself.
//
//   NODE_PATH=$PWD/node_modules node qa/bfcache-browser.cjs
//   QA_PORT=5193 CHROME_PATH=/path/to/chrome node qa/bfcache-browser.cjs
const puppeteer = require("puppeteer-core");

const PORT = process.env.QA_PORT || "5193";
const BASE = `http://localhost:${PORT}/`;
const KEY = "rhodes.prototype.db.v1";
const LOCK = "rhodes.prototype.writer.v1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${name}${extra ? " — " + extra : ""}`);
};

const describe = (raw) => {
  if (raw == null) return { present: false, meetings: -1, titles: [], chars: 0 };
  const d = JSON.parse(raw);
  return { present: true, chars: raw.length, meetings: d.meetings.length, titles: d.meetings.map((m) => m.title) };
};

async function launchOptions() {
  const args = ["--no-sandbox", "--disable-gpu"];
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath) {
    try {
      const chromium = require("@sparticuz/chromium");
      const c = chromium.default || chromium;
      args.push(...c.args);
      executablePath = await c.executablePath();
    } catch {
      executablePath = puppeteer.executablePath();
    }
  }
  return { args, executablePath, headless: true, defaultViewport: { width: 1400, height: 950 } };
}

(async () => {
  const opts = await launchOptions();
  const browser = await puppeteer.launch({
    ...opts,
    userDataDir: `/tmp/qa-bfcache-profile-${Date.now()}`,
  });

  const waitFor = async (p, fn, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { if (await p.evaluate(fn)) return true; } catch { /* navigating */ }
      await wait(200);
    }
    return false;
  };
  const openTab = async (query = "") => {
    const p = await browser.newPage();
    p.on("dialog", async (d) => { await d.accept(); });
    p.on("pageerror", (e) => console.log("   pageerror:", e.message));
    await p.goto(`${BASE}${query}`, { waitUntil: "networkidle2", timeout: 60000 });
    // Boot sequence finished and the shell is mounted.
    await waitFor(p, () => !document.querySelector(".boot-overlay") && !!document.querySelector('.nav-tile[aria-label="Meeting Operations"]'));
    await wait(600);
    return p;
  };
  /** Wait until this window is the writer (the grant is asynchronous). */
  const waitOwner = async (p, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if ((await leaseState(p)) === "owner") return true;
      await wait(200);
    }
    return false;
  };

  const storage = (p) => p.evaluate(([k]) => window.localStorage.getItem(k), [KEY]);
  const leaseState = (p) => p.evaluate(() => document.querySelector("[data-lease-state]")?.getAttribute("data-lease-state") ?? "owner");
  const noticeMode = (p) => p.evaluate(() => document.querySelector("[data-lease-mode]")?.getAttribute("data-lease-mode") ?? "none");
  const locksOf = (p) => p.evaluate(async ([name]) => {
    if (!navigator.locks) return { supported: false, held: [], pending: [] };
    const q = await navigator.locks.query();
    return {
      supported: true,
      held: q.held.filter((l) => l.name === name).length,
      pending: q.pending.filter((l) => l.name === name).length,
    };
  }, [LOCK]);
  const bodyText = (p) => p.evaluate(() => document.body.innerText);
  const notices = async (p) => (await bodyText(p)).split("\n").filter((t) => /RHODES window|read-only|editing access|cannot reserve/i.test(t));

  const openMeetings = async (p) => {
    await p.bringToFront();
    for (let i = 0; i < 3; i++) {
      if (await waitFor(p, () => !!document.querySelector('.nav-tile[aria-label="Meeting Operations"]'), 8000)) break;
      await p.goto(BASE, { waitUntil: "networkidle2" });
      await waitFor(p, () => !document.querySelector(".boot-overlay"));
    }
    await p.click('button[aria-label="Meeting Operations"]');
    await wait(900);
  };
  const attemptMeetingOnce = async (p, title) => {
    await openMeetings(p);
    let btn = null;
    for (let i = 0; i < 12 && !btn; i++) {
      btn = await p.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Meeting"));
      if (!btn.asElement()) { btn = null; await wait(300); }
    }
    if (!btn) throw new Error("New Meeting button not found");
    await btn.asElement().click();
    await wait(600);
    const input = await p.$('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])');
    await input.click();
    await p.keyboard.type(title, { delay: 8 });
    const create = await p.evaluateHandle(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "Create Meeting"));
    await create.asElement().click();
    await wait(1500);
  };
  const attemptMeeting = async (p, title) => {
    for (const attempt of [0, 1]) {
      if (attempt === 1) await waitOwner(p);
      await attemptMeetingOnce(p, title);
      if ((await storage(p)).includes(title)) return true;
    }
    return false;
  };
  const openNotesOfFirstRecord = async (p) => {
    await openMeetings(p);
    const opener = await p.evaluateHandle(() => [...document.querySelectorAll("button")].find((x) => /Open .* workspace/.test(x.getAttribute("aria-label") || "")));
    await opener.asElement()?.click();
    await wait(900);
    const notesTab = await p.evaluateHandle(() => [...document.querySelectorAll('[role="tab"]')].find((t) => /^Notes/.test((t.textContent || "").trim())));
    await notesTab.asElement()?.click();
    for (let i = 0; i < 12; i++) {
      if (await p.$('.editor-area[aria-label="Meeting notes editor"]')) return true;
      await wait(250);
    }
    return false;
  };

  /** Records the meeting list is currently showing (one open-button per record). */
  const countMeetings = (p) => p.evaluate(
    () => document.querySelectorAll('[aria-label^="Open "][aria-label$=" workspace"]').length,
  );

  /**
   * Open the meeting form **without navigating**, fill it and submit it, and
   * report exactly what happened.
   *
   * Two things make this evidence rather than decoration. It never navigates:
   * the window under test must stay the same (restored) document, which the
   * caller verifies with a marker set before the attempt — a reload would reset
   * the very state the test is about. And it reports `opened`, `typed` and
   * `submitted` separately, so "storage did not change" cannot be mistaken for
   * "the refusal happened".
   */
  const submitMeetingFormInPlace = async (p, title) => {
    const report = {
      via: null, opened: false, typed: false, submitted: false, dialogOpenAfter: false,
      feedback: "", meetingsBefore: 0, meetingsAfter: 0, titleOnScreen: false, sameDocument: false,
    };

    // Nothing modal in the way.
    if (await p.evaluate(() => !!document.querySelector('[role="dialog"]'))) {
      await p.keyboard.press("Escape");
      await wait(400);
    }
    // Back to the record list with the workspace's own control — still the same
    // document, which is the whole point.
    const back = await p.$('button[aria-label="Back to Meeting Operations"]');
    if (back) { await back.click(); await wait(900); }
    report.meetingsBefore = await countMeetings(p);

    // Preferred: the record list on this screen. Fallback: the same form opened
    // by the shell's "new meeting" command (Ctrl+N) — still no navigation.
    const tile = await p.$('button[aria-label="Meeting Operations"]');
    if (tile) {
      await tile.click();
      await wait(800);
      report.meetingsBefore = await countMeetings(p);
      const openBtn = await p.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Meeting"));
      if (openBtn.asElement()) { await openBtn.asElement().click(); report.via = "nav"; }
    }
    if (report.via === null) {
      await p.evaluate(() => window.dispatchEvent(new CustomEvent("rhodes:new-meeting")));
      report.via = "event";
    }
    for (let j = 0; j < 12 && !report.opened; j++) {
      report.opened = await p.evaluate(() => !!document.querySelector('[role="dialog"]'));
      if (!report.opened) await wait(250);
    }
    if (!report.opened) return report;

    const input = await p.$('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])');
    if (!input) return report;
    await input.click();
    await p.keyboard.type(title, { delay: 8 });
    report.typed = await p.evaluate(
      ([t]) => (document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')?.value ?? "") === t,
      [title],
    );
    const create = await p.evaluateHandle(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "Create Meeting"));
    if (!report.typed || !create.asElement()) return report;

    await create.asElement().click();
    report.submitted = true;
    await wait(1300);                                  // toasts live 3.4 s
    report.dialogOpenAfter = await p.evaluate(() => !!document.querySelector('[role="dialog"]'));
    // Every toast is a panel with a Dismiss control; its message is that text.
    report.feedback = await p.evaluate(
      () => [...document.querySelectorAll('button[aria-label="Dismiss"]')].map((b) => b.parentElement?.innerText ?? "").join(" | "),
    );
    report.meetingsAfter = await countMeetings(p);
    report.titleOnScreen = await p.evaluate(([t]) => !!document.querySelector(`[aria-label="Open ${t} workspace"]`), [title]);
    report.sameDocument = await p.evaluate(() => window.__qa?.mark === "restored-document");
    return report;
  };

  const typeDraft = async (p, text) => {
    const editor = await p.$('.editor-area[aria-label="Meeting notes editor"]');
    await editor.click();
    await wait(80);
    await p.keyboard.type(text, { delay: 10 });
    await wait(120);           // well inside the 800 ms editor debounce
  };

  /** Record lifecycle events and storage writes inside the page. */
  const instrument = (p) => p.evaluate(() => {
    window.__qa = { events: [] };
    const push = (o) => window.__qa.events.push({ ...o, t: Date.now() });
    addEventListener("pagehide", (e) => push({ ev: "pagehide", persisted: e.persisted }));
    addEventListener("pageshow", (e) => push({ ev: "pageshow", persisted: e.persisted }));
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      push({ ev: "setItem", storage: this === localStorage ? "local" : "session", key: String(k), len: String(v).length });
      return setItem.call(this, k, v);
    };
  });
  const events = (p) => p.evaluate(() => window.__qa?.events ?? []);

  // ── Scenario BF · a restored page must not write ───────────────────────
  console.log("\n=== Scenario BF · back/forward-cache restore ===");
  const A = await openTab();
  const bootRaw = await storage(A);
  await instrument(A);
  check("BF1 the first window owns the lease", (await leaseState(A)) === "owner", `state=${await leaseState(A)}`);

  await openMeetings(A);
  await attemptMeeting(A, "MT-BEFORE-BFCACHE");
  const afterOwn = describe(await storage(A));
  check("BF2 the owning window's meeting is stored", afterOwn.titles.includes("MT-BEFORE-BFCACHE"),
    `${afterOwn.meetings} meetings, ${afterOwn.chars} chars`);

  // A draft that has not reached storage yet: it must be written by the
  // lifecycle flush *while this window still owns the lease*, before the lease
  // is handed back.
  await openNotesOfFirstRecord(A);
  await typeDraft(A, "DRAFT-BEFORE-HIDE");
  const beforeHide = describe(await storage(A));

  // The browser freezes the page into the back/forward cache: pagehide, persisted.
  await instrument(A);
  await A.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await wait(300);
  const hiddenEvents = await events(A);
  check("BF3 the pagehide is delivered with persisted === true",
    hiddenEvents.some((e) => e.ev === "pagehide" && e.persisted === true),
    JSON.stringify(hiddenEvents.filter((e) => e.ev.startsWith("page")).slice(-2)));

  const afterHide = describe(await storage(A));
  check("BF4 the pending draft was flushed before the lease was given back",
    afterHide.chars > beforeHide.chars && (await storage(A)).includes("DRAFT-BEFORE-HIDE"),
    `${beforeHide.chars} → ${afterHide.chars} chars`);

  check("BF5 the window is non-writable while it is away", (await leaseState(A)) === "waiting", `state=${await leaseState(A)}`);
  const locksAfterHide = await locksOf(A);
  check("BF6 it holds no lease while frozen", locksAfterHide.held === 0,
    `held=${locksAfterHide.held} pending=${locksAfterHide.pending}`);

  // ── Tab B takes the lease while A is away ──────────────────────────────
  const B = await openTab("?second=1");
  check("BF7 a window opened while the other is away owns the lease", (await leaseState(B)) === "owner", `state=${await leaseState(B)}`);
  await openMeetings(B);
  await attemptMeeting(B, "MT-TAB-B-BFCACHE");
  await wait(700);
  const afterB = describe(await storage(B));
  check("BF8 its meeting is stored", afterB.titles.includes("MT-TAB-B-BFCACHE"),
    `${afterB.meetings} meetings, ${afterB.chars} chars`);
  const rawWithB = await storage(B);
  check("BF9 the draft written by the frozen window survived B's write",
    rawWithB.includes("DRAFT-BEFORE-HIDE") && rawWithB.includes("MT-BEFORE-BFCACHE"),
    `titles=${JSON.stringify(afterB.titles)}`);

  // ── Restore A from the back/forward cache ──────────────────────────────
  await A.bringToFront();
  await A.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await wait(900);
  const restoredEvents = await events(A);
  check("BF10 the pageshow is delivered with persisted === true",
    restoredEvents.some((e) => e.ev === "pageshow" && e.persisted === true),
    JSON.stringify(restoredEvents.filter((e) => e.ev.startsWith("page")).slice(-2)));

  check("BF11 the restored window is non-writable while its request is queued",
    (await leaseState(A)) === "waiting" && (await noticeMode(A)) === "readonly",
    `state=${await leaseState(A)} notice=${await noticeMode(A)}`);
  const locksRestored = await locksOf(A);
  check("BF12 its lease request is queued behind the owning window",
    locksRestored.held === 1 && locksRestored.pending >= 1,
    `held=${locksRestored.held} (the other window) pending=${locksRestored.pending} (this one)`);

  const staleTitles = describe(await storage(A)).titles;
  const domText = await bodyText(A);
  check("BF13 it is still showing its own (older) document", !domText.includes("MT-TAB-B-BFCACHE") && staleTitles.includes("MT-TAB-B-BFCACHE"),
    `storage has B's meeting, the restored window does not show it`);

  const timeline = (await events(A)).filter((e) => ["pagehide", "pageshow", "setItem"].includes(e.ev));
  console.log("   timeline (A):", JSON.stringify(timeline.map((e) => (e.ev === "setItem" ? `setItem:${e.len}` : `${e.ev}:persisted=${e.persisted}`))));

  // A save attempted from the restored window: not merely "storage did not
  // change afterwards", but the *same restored document* really opening the
  // form, really filling it in and really submitting it, with the refusal
  // visible on screen. The marker proves the attempt did not run in a reloaded
  // page, where every protection would trivially hold.
  await A.evaluate(() => { window.__qa.mark = "restored-document"; });
  const beforeAttempt = await storage(A);
  const attempt = await submitMeetingFormInPlace(A, "MT-FROM-RESTORED-WINDOW");
  await wait(500);
  const afterAttempt = await storage(A);
  check("BF14a the restored document's meeting form was opened",
    attempt.opened === true && attempt.sameDocument === true,
    JSON.stringify({ via: attempt.via, opened: attempt.opened, sameDocument: attempt.sameDocument }));
  check("BF14b the meeting title was entered and the submission attempted",
    attempt.typed === true && attempt.submitted === true, JSON.stringify({ typed: attempt.typed, submitted: attempt.submitted }));
  check("BF14c the attempted meeting was not added to the document",
    attempt.titleOnScreen === false &&
      (attempt.meetingsBefore === 0 || attempt.meetingsAfter === attempt.meetingsBefore),
    `${attempt.meetingsBefore} → ${attempt.meetingsAfter} records on screen, on screen=${attempt.titleOnScreen}`);
  check("BF14d it never reached storage", afterAttempt === beforeAttempt && !afterAttempt.includes("MT-FROM-RESTORED-WINDOW"),
    `${describe(beforeAttempt).meetings} → ${describe(afterAttempt).meetings} meetings, ${describe(afterAttempt).chars} chars`);
  check("BF14e the restored window is still read-only",
    (await leaseState(A)) === "waiting" && (await noticeMode(A)) === "readonly",
    `state=${await leaseState(A)} notice=${await noticeMode(A)}`);
  check("BF14f it kept the form open and said the meeting was not saved",
    attempt.dialogOpenAfter === true && /not saved/i.test(attempt.feedback),
    JSON.stringify({ dialogOpen: attempt.dialogOpenAfter, feedback: attempt.feedback.slice(0, 160) }));
  // Leave the refused form so the remaining steps start from the record list.
  if (attempt.dialogOpenAfter) { await A.keyboard.press("Escape"); await wait(500); }
  check("BF15 it says why nothing was written",
    (await notices(A)).some((t) => /Another RHODES window|editing access|READ-ONLY/i.test(t)),
    JSON.stringify(await notices(A)).slice(0, 160));

  // ── B goes away: A is granted the lease ───────────────────────────────
  await B.close();
  await wait(2500);
  check("BF16 the restored window becomes the writer once the other one leaves",
    (await leaseState(A)) === "owner", `state=${await leaseState(A)}`);
  // What it adopted, read from the same document (the workspace's own "back to
  // the record list" control — no reload, which would prove nothing about the
  // reload the grant performed).
  await A.evaluate(() => { window.__qa.markAdopted = "same-document"; });
  const backTo = await A.$('button[aria-label="Back to Meeting Operations"]');
  if (backTo) { await backTo.click(); await wait(900); }
  const adoptedText = await bodyText(A);
  const sameDoc = await A.evaluate(() => window.__qa?.markAdopted === "same-document");
  check("BF17 it re-read the stored records before enabling writes",
    adoptedText.includes("MT-TAB-B-BFCACHE") && sameDoc === true,
    `sameDocument=${sameDoc} shown=${adoptedText.includes("MT-TAB-B-BFCACHE")}`);

  await openMeetings(A);
  await attemptMeeting(A, "MT-AFTER-RESTORE");
  await wait(800);
  const finalRaw = await storage(A);
  const final = describe(finalRaw);
  check("BF18 a change made after taking over is stored", final.titles.includes("MT-AFTER-RESTORE"), JSON.stringify(final.titles));
  check("BF19 the other window's meeting is still there",
    final.titles.includes("MT-TAB-B-BFCACHE") && final.titles.includes("MT-BEFORE-BFCACHE"), JSON.stringify(final.titles));
  check("BF20 nothing from the frozen window was lost",
    finalRaw.includes("DRAFT-BEFORE-HIDE"));

  console.log("   storage counts:", JSON.stringify({
    boot: describe(bootRaw).meetings,
    afterOwnerSave: afterOwn.meetings,
    afterHiddenFlush: afterHide.meetings,
    afterB: afterB.meetings,
    final: final.meetings,
    finalChars: final.chars,
  }));

  // The first window is done: scenario R needs to start as the only window, so
  // the lease is free rather than held by the window the BF scenario left open.
  await A.close();
  await wait(1500);

  // ── Scenario R · a real navigation away and back ───────────────────────
  console.log("\n=== Scenario R · real navigation (no back/forward cache) ===");
  const R = await openTab("?nav=1");
  check("R1 the window owns the lease", (await leaseState(R)) === "owner", `state=${await leaseState(R)}`);
  await R.evaluate(() => {
    sessionStorage.setItem("__qa_pagehide", "pending");
    addEventListener("pagehide", (e) => sessionStorage.setItem("__qa_pagehide", String(e.persisted)));
  });
  await R.goto(`${BASE}README.md`, { waitUntil: "domcontentloaded" });
  await wait(400);
  const R2 = await openTab("?nav-owner=1");
  const r2Owner = await waitOwner(R2);
  check("R2 the lease was handed back on the way out", r2Owner, `state=${await leaseState(R2)}`);
  await openMeetings(R2);
  await attemptMeeting(R2, "MT-REAL-NAV-OWNER");
  await wait(700);
  const navRaw = await storage(R2);
  check("R3 the new owner's meeting is stored", describe(navRaw).titles.includes("MT-REAL-NAV-OWNER"),
    `${describe(navRaw).meetings} meetings, ${describe(navRaw).chars} chars, state=${await leaseState(R2)}`);

  await R2.bringToFront();
  const stillOwner = await waitOwner(R2);
  check("R3b the other window still owns the lease when this one comes back", stillOwner, `state=${await leaseState(R2)}`);
  console.log("   before return: R2 state =", await leaseState(R2), "locks =", JSON.stringify(await locksOf(R2)));
  await R.bringToFront();
  await R.goBack({ waitUntil: "networkidle2" });
  await waitFor(R, () => !document.querySelector(".boot-overlay") && !!document.querySelector('.nav-tile[aria-label="Meeting Operations"]'));
  await wait(700);
  console.log("   after return: R2 state =", await leaseState(R2), "locks =", JSON.stringify(await locksOf(R2)), "R state =", await leaseState(R));
  const sawPersisted = await R.evaluate(() => sessionStorage.getItem("__qa_pagehide"));
  console.log("   real pagehide.persisted =", sawPersisted, "(false = this Chromium has no back/forward cache)");
  await waitFor(R, () => !!document.querySelector("[data-lease-state]"), 8000);
  check("R4 the returning window is read-only while the other one owns the lease",
    (await leaseState(R)) === "waiting", `state=${await leaseState(R)}`);
  check("R5 it loaded the records the owner saved", (await bodyText(R)).includes("MT-REAL-NAV-OWNER") || describe(await storage(R)).titles.includes("MT-REAL-NAV-OWNER"));
  await R2.close();
  await wait(2500);
  check("R6 it becomes the writer once the other window leaves", (await leaseState(R)) === "owner", `state=${await leaseState(R)}`);

  console.log(`\n${pass}/${pass + fail} passed`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error("HARNESS ERROR:", error);
  process.exit(1);
});
