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
- **A failed preservation locks writing.** If the loader had to preserve the
  stored payload (records set aside or values repaired) and that preserved copy
  cannot be written, the only copy of the records is the live key — so the
  store refuses every write path (`mutate`, `persist`, `flush`, import, demo
  reset, "continue" and dismiss) until the operator downloads the preserved
  copy, or a later snapshot succeeds. The notice shows *WRITES LOCKED* and
  cannot be dismissed while the lock is active.

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
| `Ctrl + Shift + N` | Quick note into a meeting record |
| `Esc` | Close the active modal |

Shortcuts avoid hijacking typing contexts except where conventional.

## 11 · Honest limitations of this prototype

- Minutes generation is deterministic templating from real records — **no AI**.
- No audio capture, transcription, cloud sync, accounts, or network features
  exist, by design.
- Content areas (notes editor) rely on the browser's `contenteditable`
  machinery; a production release should evaluate a dedicated editor library.
- Browser localStorage has a ~5 MB quota; the Electron phase replaces it with
  SQLite before that becomes meaningful.
