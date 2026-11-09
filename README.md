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
│   └── Insignia.tsx            ← Original RHODES geometric insignia (SVG)
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
  load(): Promise<AppData>;
  save(data: AppData): Promise<{ bytes: number }>;
  clear(): Promise<void>;
  usageInfo(): Promise<{ bytes: number; keys: number }>;
}
```

The prototype adapter (`LocalStorageAdapter`) persists the single `AppData`
document under `rhodes.prototype.db.v1`. React components **never** touch
storage directly — everything flows through `useAppData()` in
`hooks/store.tsx`, which debounces writes (280 ms) and drives the truthful
SAVING… / SAVED / SAVE FAILED indicator shown in the top bar and the notes
editor. JSON backup/restore and demo reset are store-level operations.

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
