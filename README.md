# RHODES — Local Meeting Assistant

**Version 1.0 · Frontend Prototype · Local-first**

RHODES is a personal desktop meeting assistant: prepare meetings, build agendas,
document discussions, record decisions, organize participants, track
responsibilities, and generate meeting minutes — entirely offline.

The visual identity draws on the *original Arknights* interface language:
monochromatic industrial panels, geometric corner indicators, restrained cyan
accents, technical micro-labels, and purposeful, controlled motion. All artwork
(the RHODES diamond-mast insignia) is original.

---

## 1 · Running the project

```bash
npm install      # one time — installs dependencies
npm run dev      # local development server (localhost only)
npm run build    # production build → dist/
npm run preview  # serve the production build (localhost only)
```

The dev and preview servers bind to `localhost` and keep Vite's default host
validation. Hosted preview containers sit behind a proxy that forwards a public
hostname, so that case is opt-in and explicit:

```bash
RHODES_SANDBOX_PREVIEW=1 npm run dev   # bind 0.0.0.0, allow the *.e2b.app proxy host
```

Nothing is exposed unless that variable is set; unrestricted host access is
never enabled by the default configuration.

After the dependencies are installed and the project is built, RHODES runs with
**zero network dependencies** — fonts (Oswald, Noto Sans, JetBrains Mono) are
bundled locally via `@fontsource/*`, and no remote scripts, images, or APIs are
requested during operation.

---

## 2 · Folder structure

```
public/
├── RHODES.png                  ← Official RHODES branding asset (1536 × 1024): HUD chip,
│                                 favicon and touch icon. Rendered only through
│                                 `src/components/RhodesLogo.tsx`, the single source of
│                                 truth for the brand mark.
├── Boot_Center_logo.png        ← Boot sequence + Command Center centrepiece (1965 × 1965,
│                                 RGBA). Rendered only through `src/components/BootCenterLogo.tsx`.
├── Meeting_operations_bg.png   ← Meeting Operations screen backdrop (1536 × 1024),
│                                 painted by `src/components/PageBackdrop.tsx`.
└── Personnel_bg.png            ← Personnel Registry screen backdrop (1536 × 1024),
                                  also painted by `src/components/PageBackdrop.tsx`.

src/
├── types/index.ts              ← Full TypeScript data model (Meeting, AgendaItem,
│                                 Person, MeetingNote, Decision, ActionItem, AppSettings)
├── data/seed.ts                ← Demonstration dataset (dates generated relative to today)
├── services/storage/index.ts   ← StorageAdapter interface + localStorage adapter
├── hooks/
│   ├── store.tsx               ← DataProvider — single source of truth, CRUD actions,
│   │                             persistence + SAVING/SAVED state machine, derived stats
│   └── ui.tsx                  ← Cross-section UI actions (shared modal triggers)
├── utils/helpers.ts            ← Date formatting, labels, minutes builder, exports
├── components/
│   ├── ui.tsx                  ← Design-system primitives (Panel, Button, Modal, Badge…)
│   ├── toast.tsx               ← Activity notifications
│   ├── RhodesLogo.tsx          ← Official RHODES.png mark — HUD chip, favicon, touch icon
│   ├── BootCenterLogo.tsx      ← Boot_Center_logo.png — boot + Command Center centrepiece
│   └── PageBackdrop.tsx        ← Per-screen backdrop layer for the two operations screens;
│                                 its PAGE_ARTWORK table also feeds the Command Center
│                                 navigation previews
├── layout/AppShell.tsx         ← Sidebar, top information bar, global search, clock
├── features/
│   ├── dashboard/CommandCenter.tsx
│   ├── meetings/MeetingOperations.tsx      ← directory, filters, calendar
│   ├── meetings/MeetingForm.tsx            ← create/edit + templates
│   ├── meetings/MeetingWorkspace.tsx       ← SCREEN 3 shell (header, tabs)
│   ├── meetings/WorkspacePanels.tsx        ← overview/agenda/notes/decisions/
│   │                                         actions/minutes/attendees/quick capture
│   ├── personnel/PersonnelRegistry.tsx
│   ├── tasks/TaskOperations.tsx            ← list + board views
│   ├── tasks/ActionItemForm.tsx
│   ├── archive/RecordsArchive.tsx          ← docs, markdown/print/JSON export
│   └── settings/SystemConfiguration.tsx
├── App.tsx                     ← boot sequence, router, global modals, theme attributes
└── main.tsx                    ← entry, local font imports
```

Global navigation state lives in `App.tsx` (`route: { section, meetingId? }`);
deep views (meeting workspace) open by setting `route.meetingId`.

---

## 3 · Theme colors

All colors are CSS custom properties in `src/index.css`:

- `:root` defines **Theme A — TERMINAL** (dark, default).
- `html[data-theme="archive"]` overrides the same variables for **Theme B — ARCHIVE** (light).

Components reference only variables (`var(--accent)`, `var(--surface)`, …).
Never hardcode a hex value in a component — extend the variable set instead.
Status tones (`--ok`, `--warn`, `--crit`, `--amber`) keep identical meaning in
both themes.

### ARCHIVE palette (cool pearl-steel)

ARCHIVE is a bright technical archive, not a generic light mode: a pearl-steel
workspace, near-white plates, a distinct raised/inset series behind them, and
graphite type on manganese-cyan accents.

| role | token | value |
| --- | --- | --- |
| workspace ground | `--bg` | `#E8EEF1` |
| recessed ground | `--bg-deep` | `#D9E2E7` |
| primary plate | `--surface` / `--panel-white` | `#F8FBFC` / `#FFFFFF` |
| raised plate | `--surface-2` | `#E3EDF3` |
| sunken band | `--surface-3` | `#D3DFE6` |
| input well | `--field-bg` | `#F1F6F9` |
| structure | `--border` / `--border-soft` | `#9CADB8` / `#CBD6DD` |
| type | `--text` / `--text-2` / `--text-3` | `#1A2730` / `#43535D` / `#5A6A74` |
| accent | `--accent` / `--accent-hover` | `#00708F` / `#005C77` |
| on accent | `--on-accent` / `--on-accent-dim` | `#FFFFFF` / `rgba(255,255,255,.88)` |

Rules that keep the two themes honest:

- `--on-accent` / `--on-accent-dim` are the only colours allowed on an accent
  fill: graphite ink in TERMINAL (dark on cyan), white in ARCHIVE (white on
  deep cyan). A cyan label on a cyan chip is a bug in both themes.
- The HUD stays graphite in ARCHIVE. `--hud-*` is not remapped by the light
  theme, so `.hud-brand`, `.hud-btn` and their hover washes stay dark; hover
  uses `--hud-hover` instead of a theme-neutral white overlay.
- Every ARCHIVE-only correction is scoped with `html[data-theme="archive"] …`
  next to the shared rule, never by editing the shared rule alone — that is
  what keeps TERMINAL pixel-identical.

Density and font scale are also variable-driven:
`html[data-density="compact"]` and `html[data-font="small|large"]` adjust
`--pad-*` and `--fs-*` tokens for the whole interface.

---

## 4 · Animations

- **Framer Motion** drives page transitions, the sidebar indicator
  (`layoutId="nav-ind"`), tab indicators, modals, toasts, staggered workspace
  entrances, and the boot sequence (`App.tsx → BootSequence`).
- Simple interactions (hover, focus, presses) are CSS transitions
  (100–160 ms, linear or restrained ease-out — no springs/bounce).
- The scanline wipe on section changes is the `ScanWipe` component plus the
  top-of-page `.scan-line` sweep in `App.tsx`.
- Motion preferences: `immersive | reduced | off` are stored in settings and
  resolved by `useMotionScale()` in `hooks/store.tsx` (which also respects the
  OS `prefers-reduced-motion` flag). `reduced` shortens durations and stops
  ambient motion; `off` disables animation globally via `html[data-motion="off"]`.
- Ambient effects (`.ambient-grid`, `.ambient-sweep`) are decorative CSS loops;
  they pause under `reduced`/`off`. The startup cinematic can be disabled in
  **System Configuration → Motion**.

---

## 5 · Typography

| Role | Font | Import |
|---|---|---|
| Interface | Noto Sans (Source Han Sans design family) | `@fontsource/noto-sans` |
| Display headings | Oswald | `@fontsource/oswald` |
| Technical labels/data | JetBrains Mono | `@fontsource/jetbrains-mono` |

Fonts are registered in `src/main.tsx` and assigned through
`--font-ui / --font-display / --font-mono` in `index.css`.
To change a face: install another `@fontsource/*` package, import it in
`main.tsx`, and update the variable. Sizes use the `--fs-*` tokens.

---

## 6 · Adding a new navigation section

1. Create `src/features/<name>/<YourScreen>.tsx` (follow an existing screen).
2. Add an entry to `SECTIONS` in `src/layout/AppShell.tsx`:
   `{ id, code: "R·07", label, icon: <lucide icon> }` and extend `SectionId`.
3. Add the case to `renderSection()` in `src/App.tsx`.

The sidebar, top bar, keyboard flow, and transitions pick it up automatically.

## 7 · Adding a new meeting feature

1. Extend the model in `src/types/index.ts` (and `deepValidate` in
   `services/storage/index.ts` if you add a collection).
2. Update the seed in `src/data/seed.ts` for realistic demo data.
3. Add CRUD actions to `hooks/store.tsx` (keep them ID-based; update via new
   objects — the store persists immutably).
4. Surface it in the workspace: a new tab entry in `TABS` inside
   `MeetingWorkspace.tsx`, implemented as a panel in `WorkspacePanels.tsx`.
5. If it belongs in the minutes, extend `buildMinutesMarkdown()` in
   `utils/helpers.ts` so documentation stays truthful.

---

## 8 · Prototype storage

`src/services/storage/index.ts` defines:

```ts
interface StorageAdapter {
  label: string;
  load(): Promise<LoadOutcome | AppData>;
  loadSync?(): LoadOutcome | AppData | null;
  save(data: AppData): Promise<{ bytes: number }>;
  clear(): Promise<void>;
  usageInfo(): Promise<{ bytes: number; keys: number }>;
  // optional — required only by operations that must preserve a copy first
  readRaw?(): string | null;
  snapshot?(raw: string, reason: string): { key: string } | { error: string };
  snapshots?(): { key: string; bytes: number; createdAt: string; reason: string }[];
  readSnapshot?(key: string): string | null;
}
```

The prototype adapter (`LocalStorageAdapter`) persists the single `AppData`
document under `rhodes.prototype.db.v1`. React components **never** touch
storage directly — everything flows through `useAppData()` in
`hooks/store.tsx`, which debounces writes (280 ms) and drives the truthful
SAVING… / SAVED / SAVE FAILED indicator shown in the top bar and the notes
editor. JSON backup/restore and demo reset are store-level operations.

### Data integrity (1.3.11 Phase 1)

- **The loader never destroys anything.** A payload that cannot be parsed or
  validated is copied to `rhodes.prototype.db.v1.snapshot.<stamp>.<reason>`,
  left untouched under the live key, and the app opens on empty records with a
  recovery screen. Demonstration data is only ever written by an explicit
  choice on that screen.
- **Validation is real.** `src/services/validation.ts` checks every record
  (types, enums, ids, arrays/maps) and stamps `meta.schemaVersion`. Version 1
  payloads migrate in memory; the new generation is written by the next normal
  save. Three failure classes are distinguished: *fatal* (the document is not a
  RHODES record set), *structural* (one of the six collections is missing, the
  `meta` block is absent/invalid, or a field holds an invalid value) and
  *dropped* (a record that cannot be represented). Only harmless cosmetic gaps
  (an absent optional string, an absent default) are repaired. Loading may
  repair structural gaps **after** the original has been preserved; an import
  never does — a backup missing a collection would otherwise wipe it.
- **A screen fault cannot blank the app.** `components/ErrorBoundary.tsx`
  keeps the HUD and navigation alive and offers retry, download of the stored
  records, and reload.
- **Imports are safe.** `previewImport()` inspects a file read-only, the UI
  demands an explicit confirmation that shows incoming vs current counts, and
  `importJSON()` then validates → snapshots the live payload → writes → and
  only then commits to React state. Any failure leaves the existing records
  exactly as they were, and the rejection names the missing collection, invalid
  value or metadata problem.
- **"Nothing stored" and "could not read" are different answers.**
  `StorageAdapter.readRaw()` returns `{ ok: true, raw } | { ok: false, error }`
  rather than a bare `string | null`, so an import can tell an absent key from a
  failed read. A failed read cancels the import — a store that could not be read
  is never treated as an empty one. When the key exists its exact bytes are
  snapshotted (`pre-import`); when it is genuinely absent but records are loaded
  in memory, those are snapshotted instead (`pre-import-memory`). If either copy
  cannot be written the import is refused.
- **Demo reset reports what actually happened.** `resetToDemo()` is async: it
  persists the demonstration dataset first and only then commits it to React
  state, returning `{ ok, error }`. The settings screen awaits it, so a failed
  write leaves the previous records in place and shows the real error instead of
  a success message.
- **A failed preservation locks writing.** If the loader had to preserve the
  stored payload (records set aside or values repaired) and that preserved copy
  cannot be written, the only copy of the records is the live key — so the
  store refuses every write path (`mutate`, `persist`, `flush`, import, demo
  reset, "continue" and dismiss) until the operator downloads the preserved
  copy, or a later snapshot succeeds. The notice shows *WRITES LOCKED* and
  cannot be dismissed while the lock is active. The lock is not lifted by the
  download itself — a browser download cannot be verified — only by the
  operator's explicit "I have saved the preserved backup" confirmation, which is
  offered after the download is started. The confirmation is session-scoped: a
  reload re-evaluates preservation from storage.
- **An unreadable store is never a licence to write.** If the adapter cannot
  read storage at all (blocked profile, IPC failure, rejecting `load()`), the
  payload may still exist, so `preservedRaw` being empty proves nothing. The app
  opens on the recovery screen with every write path refused, no demo reset, no
  dismissal and no download (there is nothing readable to hand over) — plus a
  non-destructive **Retry storage read** and **Reload application**. Only a
  successful re-read (which snapshots the payload) lifts the lock.

### Destructive operations (1.3.12 Phase 1)

Everything that removes records now runs through one path in `hooks/store.tsx`:
`runDestructive(reason, transform)` → `preserveBeforeDestructive(reason)` →
write → commit.

- **Protected operations:** demo reset (`pre-reset`), delete meeting
  (`pre-delete-meeting`, which also cascades agenda, notes, decisions and action
  items), delete personnel (`pre-delete-person`), delete agenda item
  (`pre-delete-agenda`), delete decision (`pre-delete-decision`) and delete
  action item (`pre-delete-task`).
- **Order is fixed and every step can refuse:** the adapter must expose both
  `readRaw` and `snapshot`; storage must be readable (a failed read is never
  read as "nothing stored"); the debounced queue is written down first so the
  copy includes changes the operator can already see (only when storage and
  memory actually differ); the copy is written under its reason label; and it is
  **read back and compared** through `readSnapshot` (or checked against
  `snapshots()` when read-back is unavailable) before anything is removed.
- **A failure changes nothing.** If the new document cannot be written, React
  state keeps the previous records, the operation reports the real storage error,
  and the recovery copy stays in storage. The result type
  (`DestructiveResult`) carries `{ ok, error?, snapshotKey?, dropped? }`, and every call
  site awaits it, so a success toast only appears after the write landed.
- **No stale write can undo it.** A pending debounced write is accounted for by
  preservation *before* its timer is cancelled (see Phase 1b below), `opCount` is
  bumped so an in-flight save cannot report over the new document, and
  record-removing operations are serialised: a second confirmation while one is
  running is refused (`…still running`), as are ordinary mutations (`mutate`) for
  the duration of the operation.
- **The write lock still wins.** While a preserved copy has not been verified
  (unreadable store, failed snapshot), reset and every delete refuse with the
  existing write-lock message and touch nothing.
- **`mutate()` no longer persists from inside a state updater.** The next
  document is computed from a synchronous mirror (`dataRef`) outside React's
  updater; a no-op transform writes nothing.

#### Serialized writes and pending saves (1.3.12 Phase 1a)

- **One write queue.** Every call the adapter receives for `save()` goes through
  a single promise chain (`enqueueWrite`), so writes reach storage in the order
  they were requested even when an adapter resolves slowly. A destructive write
  therefore cannot be overtaken by a save that started earlier.
  `opCount` is kept only for the save indicator — it reports, it does not order.
- **One exclusive operation at a time.** Deletes, demo reset, import and
  "start from demo" all take the same lock (`beginExclusive`/`endExclusive`), so
  they cannot overlap each other or run under the recovery write lock.
- **Edits are queued, not dropped.** An edit made while an exclusive operation
  runs is applied to the document that operation leaves behind and written
  through the same chain. The notes editor keeps its draft and its dirty state
  unless `saveNote()` returns `true`, and drafts the store refused (write lock)
  survive an unmount.
- **A failed read costs nothing.** Preservation reads storage *before* touching
  the pending autosave. If the read fails the operation is refused and the
  debounced write stays armed, so queued edits still reach storage when it can be
  read again. If the preservation write itself fails, the refusal says the changes
  are still queued and the document is re-armed for retry; the indicator settles
  on `error` instead of staying on `saving`.
- **Timers are honest.** `persistTimer` is cleared when its callback actually
  fires, so "a write is still waiting" and "the write has been sent" are
  distinguishable by the store.

> **Snapshot identity:** keys are
> `rhodes.prototype.db.v1.snapshot.<stamp>.<reason>.<unique>`. The suffix is a
> per-session counter plus a random tail, so two copies with the same reason and
> the same millisecond never overwrite each other. `snapshots()` still parses the
> reason from the key.

> **Retention limitation:** the history stays at four copies (`MAX_SNAPSHOTS`).
> The newest copy is always kept — pruning happens after the write and keeps the
> most recent four keys — but five record-removing operations in a row evict the
> oldest copy, so an operator who wants to keep an older recovery point must
> download it. Keys are timestamped to the millisecond *and* carry the unique
> suffix above, so two copies taken in the same millisecond never collide.
>
> A destructive operation holds the document for its duration; a keystroke that
> arrives in that window is queued and replayed when the operation finishes. With
> the localStorage adapter the window is a few milliseconds.

#### Import and deferred-edit safety (1.3.12 Phase 1b)

- **An import preserves through the same path a delete uses.** `importJSON()`
  validates, takes the exclusive lock, then calls `preserveBeforeDestructive`
  (`pre-import`, or `pre-import-memory` when the live key is absent). The copy is
  read back and compared exactly as it is for a delete; there is no second,
  weaker verification path.
- **A pending autosave is never silently discarded.** The copy includes the
  latest records: a debounced document that has not reached storage is written
  down first, and when nothing is waiting the stored bytes are copied verbatim
  (a migrated or repaired in-memory view never overwrites them). The queued timer
  is cancelled **only after** its document is accounted for, so an import cannot
  snapshot stale bytes and then drop the newer ones. A failed read refuses the
  import and leaves the timer armed; a failed preservation write refuses it and
  re-arms the document for retry; a failed import write leaves the existing
  records and the queued changes exactly as they were.
- **Every Notes writer reports the truth.** `saveNote()` returns a boolean and
  the Quick Note modal, Quick Capture and the notes editor only claim success on
  `true`. On `false` they show an error and keep the text — the modal stays open,
  the capture input is not cleared, and the editor keeps its draft and stays
  visibly unsaved. `createDecision()` and `createActionItem()` report the same
  way.
- **Restored drafts stay unsaved.** A draft kept from a refused save is shown
  again on remount and retried; if it is refused again it is kept, and the editor
  reads *SAVE FAILED — RETRY* rather than *SAVED*.
- **A deferred edit cannot orphan a record.** An edit queued while an operation
  runs is replayed against the document that operation leaves behind. Any child
  record the replay *adds* for a meeting that no longer exists — agenda item,
  decision, action item, note — is discarded instead of stored, and the number
  discarded is returned in `DestructiveResult.dropped` so the confirmation can
  say so. Drafts for records that still exist are kept, and records that were
  already stored are never filtered by this check.

#### Relationship integrity and agenda deletion (1.3.12 Phase 2)

The records are a small graph — meetings own agenda items, notes, decisions and
action items — so the store now checks the edges as well as the fields.

- **One place for the rules.** `checkRelationships(data)` in
  `services/validation.ts` walks every collection once and returns
  `{ errors, warnings }`. `validateAppData()` folds it into the usual result
  (`relationships`, `relationshipWarnings`), so `clean` is only true when the
  references hold together too. **No field was added**; a missing optional link
  is `null`, which is already what the model means by "not filed under an agenda
  item".
- **What blocks (errors):** the same id twice in `meetings`, `agendaItems`,
  `personnel`, `notes`, `decisions` or `actionItems`; an agenda item, note,
  decision or action item whose `meetingId` is not in the file; a decision or
  action item whose `agendaItemId` is not in the file; and one whose agenda item
  belongs to a *different* meeting (the model requires same-meeting); plus a
  second discussion note for the same meeting.
- **What only warns:** personnel references (`organizerId`, `presenterId`,
  `approvedBy`, `assigneeId`, `attendeeIds`, `attendance` keys). The interface
  already renders an unknown person as unassigned, so such a file is still
  importable — the *Replace All Records* dialog lists every warning verbatim
  above the recovery-copy note, says the file will still import, and says the
  missing person will show as **Unassigned**. No warnings, no section.
- **Two kinds of notice, kept apart.** `previewImport()` returns
  `adjustments` (what the reader did to a *complete* file: a schema migration,
  defaults for an unsupplied settings block) separately from `warnings` (people
  the file names but does not contain). The dialog shows them in that order,
  each with its own heading and count, and neither suggests the other: a v1
  backup with no missing people reports only the migration, and never mentions
  *Unassigned*.
- **A relationship error refuses the whole file.** Nothing is dropped, repaired
  or partially imported: the preview reports it before the confirmation, and the
  import returns `Import refused — …; No records were changed.` The message names
  the collection, the record and the reference, e.g. `decisions[0] "d_1".agendaItemId
  points at agenda item "a_9", which belongs to meeting "m_b", not to its own
  meeting "m_a"`. The Phase 1 order (validate → snapshot → write → commit) is
  untouched, so a refused file never replaces the database and never spends a
  recovery copy.
- **Deleting an agenda item detaches, and says so.** Its decisions and action
  items are kept, with `agendaItemId` set to `null` and every other field —
  including `meetingId` — intact; only the link is cleared, so no dangling
  reference can be stored. The confirmation warns beforehand and the success
  toast reports the number detached (`DestructiveResult.detached`). The recovery
  copy still holds the agenda entry *with* its links. An operation that cannot be
  preserved is refused as before and changes nothing.
- **Creating and editing check the same rule.** A decision or action item that
  would point at a missing or another meeting's agenda item is refused at the
  form and again in the store; the store returns `false`, the modal keeps its
  input and shows the reason. Agenda-less decisions and tasks remain normal
  (the field is optional), and a deferred edit queued during a deletion has its
  stale link cleared on replay instead of being written dangling.

> The configuration screen labels this adapter accurately as provisional:
> it is *not* the final SQLite database.

## 9 · Path to Electron + SQLite

The target architecture is:

```
React Renderer ──(contextBridge / typed IPC)──▶ Electron Main ──▶ better-sqlite3
```

Because of the adapter boundary, migration is:

1. Scaffold Electron (`main.ts`, `preload.ts`); expose a narrow API such as
   `window.rhodes.invoke('db:load') / ('db:save', data)` on a `contextBridge`.
   Keep `contextIsolation: true`, `nodeIntegration: false`.
2. Implement a new `SqliteIpcAdapter` satisfying `StorageAdapter`
   (`load/save/clear/usageInfo` → IPC calls; SQL lives only in the main process).
3. Swap one line in `services/storage/index.ts`: `export const storage = new SqliteIpcAdapter()`.
   No React code changes.

For a relational layout, split `AppData` into per-entity tables mirroring the
interfaces in `types/index.ts` (`meetings`, `agenda_items`, `personnel`,
`notes`, `decisions`, `action_items`) and expose row-level IPC methods.

---

## 10 · Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + N` | Register a new meeting |
| `Ctrl + K` | Global local search |
| `Ctrl + S` | Force-save current information to local storage |
| `Alt + Shift + N` | Quick note into a meeting record |
| `Esc` | Close the active modal |

Shortcuts avoid hijacking typing contexts except where conventional. Quick Note is
also a labelled button in the top navigation, beside Notifications and Keyboard
Controls: the previous chord (`Ctrl + Shift + N`) is a browser window command and
never reached the page, so it is no longer bound or advertised.

## 11 · Honest limitations of this prototype

- Minutes generation is deterministic templating from real records — **no AI**.
- No audio capture, transcription, cloud sync, accounts, or network features
  exist, by design.
- Content areas (notes editor) rely on the browser's `contenteditable`
  machinery; a production release should evaluate a dedicated editor library.
- Browser localStorage has a ~5 MB quota; the Electron phase replaces it with
  SQLite before that becomes meaningful.
