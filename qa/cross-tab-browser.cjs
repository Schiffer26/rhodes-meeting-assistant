// RHODES 1.3.12 · P3-H1 correction — cross-tab protection, real two-tab browser test.
//
// Genuine interactions only (real clicks, real keyboard). Two tabs of the same
// origin in one browser profile, sharing one storage area — the situation that
// used to lose records.
//
//   node qa/cross-tab-browser.cjs        (a dev server must be listening; QA_PORT, default 5193)
const puppeteer = require("puppeteer-core");

/** Chromium: $CHROME_PATH, else the bundled Lambda build, else puppeteer's own. */
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

const PORT = process.env.QA_PORT || "5193";
const BASE = `http://localhost:${PORT}/`;
const KEY = "rhodes.prototype.db.v1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} · ${name}${extra ? " — " + extra : ""}`);
  console.log(results[results.length - 1]);
};

const describe = (raw) => {
  if (raw == null) return { present: false, meetings: -1, titles: [], chars: 0 };
  const d = JSON.parse(raw);
  return { present: true, chars: raw.length, meetings: d.meetings.length, titles: d.meetings.map((m) => m.title) };
};

(async () => {
  const browser = await puppeteer.launch({
    ...(await launchOptions()),
    userDataDir: `/tmp/qa-crosstab-profile-${Date.now()}`,
  });

  const openTab = async (query = "") => {
    const p = await browser.newPage();
    p.on("dialog", async (d) => { await d.accept(); });
    p.on("pageerror", (e) => console.log("   pageerror:", e.message));
    await p.goto(`${BASE}${query}`, { waitUntil: "networkidle2", timeout: 60000 });
    await wait(2800);
    return p;
  };
  const storage = (p) => p.evaluate(([k]) => window.localStorage.getItem(k), [KEY]);
  const bannerVisible = (p) => p.evaluate(() => !!document.querySelector("[data-lease-state]"));
  const bodyText = (p) => p.evaluate(() => document.body.innerText);
  const editorText = (p) => p.evaluate(() => document.querySelector('.editor-area[aria-label="Meeting notes editor"]')?.innerHTML || "");
  const notices = async (p) => (await bodyText(p)).split("\n").filter((t) => /RHODES window|read-only|owns editing/i.test(t));

  const openMeetings = async (p, { reset = false } = {}) => {
    await p.bringToFront();
    if (reset || !(await p.$('button[aria-label="Meeting Operations"]'))) {
      await p.goto(BASE, { waitUntil: "networkidle2" });
      await wait(2600);
    }
    await p.click('button[aria-label="Meeting Operations"]');
    await wait(800);
  };
  const editorHandle = async (p) => {
    for (let i = 0; i < 12; i++) {
      const el = await p.$('.editor-area[aria-label="Meeting notes editor"]');
      if (el) return el;
      await wait(250);
    }
    return null;
  };
  const openNotesOfFirstRecord = async (p, { reset = false } = {}) => {
    for (const attempt of [0, 1]) {
      await openMeetings(p, { reset: reset || attempt === 1 });
      const opener = await p.evaluateHandle(() => [...document.querySelectorAll("button")].find((x) => /Open .* workspace/.test(x.getAttribute("aria-label") || "")));
      await opener.asElement()?.click();
      await wait(900);
      const notesTab = await p.evaluateHandle(() => [...document.querySelectorAll('[role="tab"]')].find((t) => /^Notes/.test((t.textContent || "").trim())));
      await notesTab.asElement()?.click();
      if (await editorHandle(p)) return;
    }
  };
  const typeDraft = async (p, text) => {
    const editor = await p.$('.editor-area[aria-label="Meeting notes editor"]');
    await editor.click();
    await wait(80);
    await p.keyboard.type(text, { delay: 10 });
    await wait(120);
  };
  /**
   * Open the meeting form, fill it and submit it.
   *
   * Every control is waited for, and the way there is retried: after a hand-over
   * the tab may still be sitting on a workspace screen, and a missing button is a
   * *harness* failure — so it raises a clear error instead of a null dereference,
   * and the whole routine is retried once from a fresh load first.
   */
  const attemptMeeting = async (p, title) => {
    const findNewMeeting = async () => {
      for (let i = 0; i < 20; i++) {
        const h = await p.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Meeting"));
        if (h.asElement()) return h;
        await wait(300);
      }
      return null;
    };
    const dialogOpen = () => p.evaluate(() => !!document.querySelector('[role="dialog"]'));
    const waitFor = async (fn, ms) => {
      for (let spent = 0; spent < ms; spent += 250) {
        if (await fn()) return true;
        await wait(250);
      }
      return false;
    };

    let btn = null;
    for (let round = 0; round < 3 && !btn; round++) {
      await openMeetings(p, { reset: round > 0 });
      btn = await findNewMeeting();
    }
    if (!btn) throw new Error(`"New Meeting" is not on the Meeting Operations screen (wanted ${title})`);

    await btn.asElement().click();
    if (!(await waitFor(dialogOpen, 4000))) {
      // A leftover overlay can swallow the click; clear it and press the button
      // directly, which still goes through the app's own handler.
      await p.keyboard.press("Escape");
      await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Meeting")?.click());
    }
    if (!(await waitFor(dialogOpen, 6000))) throw new Error(`the meeting form did not open (wanted ${title})`);

    const input = await p.$('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])');
    if (!input) throw new Error(`the meeting form has no title field (wanted ${title})`);
    await input.click();
    await p.keyboard.type(title, { delay: 8 });
    let create = null;
    for (let i = 0; i < 12 && !create; i++) {
      create = await p.evaluateHandle(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "Create Meeting"));
      if (!create.asElement()) { create = null; await wait(250); }
    }
    if (!create) throw new Error(`the meeting form has no submit control (wanted ${title})`);
    await create.asElement().click();
    await wait(1400);
  };

  // ── Test B · only one window may write ────────────────────────────────
  console.log("\n=== Test B · single writable window ===");
  const A = await openTab();
  const B = await openTab("?second=1");
  check("B1 the first window owns the lease", !(await bannerVisible(A)), `banner=${await bannerVisible(A)}`);
  check("B2 the second window is told it is read-only", await bannerVisible(B), `banner=${await bannerVisible(B)}`);
  check("B3 the read-only state is announced (role=status)",
    (await B.evaluate(() => document.querySelector("[data-lease-state]")?.getAttribute("role"))) === "status");

  const storageAtBoot = await storage(B);
  await attemptMeeting(B, "MT-TAB-WRITE-ATTEMPT");
  await wait(600);
  const afterAttempt = describe(await storage(B));
  check("B4 a meeting created in the read-only window never reaches storage",
    !afterAttempt.titles.includes("MT-TAB-WRITE-ATTEMPT") && afterAttempt.meetings === describe(storageAtBoot).meetings,
    `${describe(storageAtBoot).meetings} → ${afterAttempt.meetings}`);
  check("B5 the read-only window says why nothing was written",
    (await notices(B)).some((t) => /Another RHODES window|READ-ONLY/i.test(t)), JSON.stringify(await notices(B)).slice(0, 140));

  // A draft in the read-only window is not written either.
  await openNotesOfFirstRecord(B, { reset: true });
  await typeDraft(B, "TAB-B-STALE-DRAFT");
  await wait(1600);                                   // past the 800 ms editor debounce
  check("B6 a draft typed in the read-only window never reaches storage",
    (await storage(B)) === storageAtBoot, `${storageAtBoot.length} chars`);

  // ── Test A · stale background window cannot overwrite newer records ───
  console.log("\n=== Test A · stale background window ===");
  await attemptMeeting(A, "MT-TAB-OWNER-MEETING");
  const afterOwner = describe(await storage(A));
  check("A1 the owning window's meeting is in storage",
    afterOwner.titles.includes("MT-TAB-OWNER-MEETING"), JSON.stringify(afterOwner.titles.slice(-2)));

  await A.bringToFront();                             // B becomes hidden → its lifecycle flush runs
  await wait(1600);
  const afterHide = describe(await storage(A));
  check("A2 hiding the stale window leaves the owning window's meeting in place",
    afterHide.titles.includes("MT-TAB-OWNER-MEETING"), JSON.stringify(afterHide.titles.slice(-2)));
  check("A3 the stale window's flush wrote nothing at all",
    afterHide.chars === afterOwner.chars && afterHide.meetings === afterOwner.meetings,
    `${afterOwner.meetings} → ${afterHide.meetings} meetings, ${afterOwner.chars} → ${afterHide.chars} chars`);
  check("A4 the stale window still holds its draft (not discarded)",
    /TAB-B-STALE-DRAFT/.test(await editorText(B)), (await editorText(B)).slice(0, 50));

  // ── Test C · draft protection ─────────────────────────────────────────
  console.log("\n=== Test C · draft protection ===");
  await B.close();                                    // the owner is now the only window
  await wait(1200);
  check("C0 the remaining window owns the lease again", !(await bannerVisible(A)));

  await openNotesOfFirstRecord(A);
  await typeDraft(A, "-OWNER-DRAFT");
  const beforeOwnerFlush = (await storage(A)).length;
  const ownerUnload = await A.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return { prevented: event.defaultPrevented };
  });
  await wait(400);
  const afterOwnerFlush = await storage(A);
  check("C1 the owner's draft is written by the lifecycle flush",
    afterOwnerFlush.length > beforeOwnerFlush && /OWNER-DRAFT/.test(afterOwnerFlush),
    `${beforeOwnerFlush} → ${afterOwnerFlush.length} chars`);
  check("C2 a successful flush raises no unload warning", ownerUnload.prevented === false, JSON.stringify(ownerUnload));

  const B2 = await openTab("?second=2");              // read-only again
  check("C3 the reopened window is read-only", await bannerVisible(B2));
  const beforeRefused = await storage(B2);
  await openNotesOfFirstRecord(B2);
  await typeDraft(B2, "TAB-B2-REFUSED-DRAFT");
  const refusedUnload = await B2.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return { prevented: event.defaultPrevented };
  });
  await wait(500);
  check("C4 a refused draft is never written over the records",
    (await storage(B2)) === beforeRefused, `${beforeRefused.length} chars`);
  check("C5 the read-only window asks before closing with an unsaved draft",
    refusedUnload.prevented === true, JSON.stringify(refusedUnload));
  check("C6 the refused draft is still recoverable in the editor",
    /TAB-B2-REFUSED-DRAFT/.test(await editorText(B2)), (await editorText(B2)).slice(0, 50));

  // ── Hand-over ─────────────────────────────────────────────────────────
  console.log("\n=== Test B2 · hand-over when the owner goes away ===");
  await A.close();
  await wait(2500);
  check("H1 the remaining window takes the lease", !(await bannerVisible(B2)));
  const adopted = describe(await storage(B2));
  check("H2 it adopts the records the owner left behind",
    adopted.titles.includes("MT-TAB-OWNER-MEETING"), JSON.stringify(adopted.titles.slice(-2)));
  await openMeetings(B2, { reset: true });
  check("H2b those are the records it now shows",
    (await bodyText(B2)).includes("MT-TAB-OWNER-MEETING"), "meetings screen");
  await attemptMeeting(B2, "MT-AFTER-HANDOVER");
  await wait(1000);
  const afterHandover = describe(await storage(B2));
  check("H3 it can write once it owns the lease",
    afterHandover.titles.includes("MT-AFTER-HANDOVER"), JSON.stringify(afterHandover.titles.slice(-2)));
  check("H4 the owner's records survived the hand-over",
    afterHandover.titles.includes("MT-TAB-OWNER-MEETING"), JSON.stringify(afterHandover.titles.slice(-2)));

  const C = await openTab("?third=1");
  check("H5 a newly opened window is read-only while another owns the lease", await bannerVisible(C));
  check("H6 the owner stays writable", !(await bannerVisible(B2)));

  await browser.close();
  const failures = results.filter((r) => r.startsWith("FAIL"));
  console.log(`\n${results.length - failures.length}/${results.length} passed`);
  process.exit(failures.length ? 1 : 0);
})();
