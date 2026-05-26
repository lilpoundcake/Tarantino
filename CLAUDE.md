# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies (runs postinstall: rollup native bindings)
npm run dev          # Smart launcher: auto-starts bundled postgres via docker-compose, then vite
npm run dev:no-db    # Skip docker postgres; just run vite (Mutations tab will show config notice)
npm run db:up        # Start the postgres container (docker compose up -d db)
npm run db:down      # Stop & remove the container (postgres volume persists)
npm run db:logs      # Tail postgres container logs
npm run build        # Type-check (tsc -b) then build static dist/ (includes structures/)
npm run typecheck    # Type-check only
npm run lint         # ESLint
npm run preview      # Serve the built dist/ locally
```

`scripts/dev.mjs` is the smart launcher: if `DATABASE_URL` is set it skips
docker; otherwise it starts `docker compose up -d db`, waits on port 5432,
sets `DATABASE_URL=postgres://tarantino:tarantino@localhost:5432/tarantino`,
then spawns vite. No tests are configured.

## What This Is

Tarantino is a mostly-local browser-based protein structure viewer with an
optional Node-side dev backend (Vite middleware) for DVBFixer pipeline runs
and a PostgreSQL-backed Mutations DB. It loads PDB/mmCIF files and provides
a dockable multi-panel workspace:

- **3D Structure (primary + optional secondary)**: two independent Mol*
  viewers with optional camera sync between them
- **Sequence**: amino acid sequence with residue-type coloring, drag-to-select,
  per-panel chain selection; SEQRES residues missing from ATOM coords are
  rendered greyed-out + dashed-border + italic and are not interactive
- **Alignment**: pairwise Needleman-Wunsch (BLOSUM62) alignment between any
  two chains, including across two different loaded structures
- **Elements**: tree of polymers / ligands / ions / water with per-component
  visibility + per-chain **Show Interface**; clicking a row focuses the
  camera on that element
- **Interactions**: computed H-bonds, ionic, cation-pi, pi-stacking, halogen,
  hydrophobic, metal coordination, disulfide, covalent
- **DVBFixer**: form-driven UI for the DVBFixer CLI (split / renumber / model /
  prepare / minimize / protonate / glycam), outputs registered as child entries
- **Mutations**: PostgreSQL-backed editable DataGrid (chain / mutation_name /
  mutations) for antibody mutation sets
- **Library**: hierarchical tree of pre-loaded structures with starring
- **Info**: editable metadata and stats

Selecting / hovering residues in 3D highlights them in Sequence and Alignment
(bidirectional sync). The Alignment panel routes selection per-side to whichever
viewer (primary or secondary) holds that chain.

## Tech Stack

- **React 19** with **TypeScript 6**, bundled by **Vite 6**
- **MUI (Material UI v9)** for all UI components, plus **`@mui/x-data-grid`**
  for the Mutations panel — no Tailwind, no shadcn
- **flexlayout-react** for dockable panels
- **Mol\*** (`molstar` npm package, used directly — not `pdbe-molstar`)
- **Zustand** for state management
- **Sass** for Mol* SCSS skin
- **`pg`** for PostgreSQL (loaded lazily server-side; missing pg / DB doesn't break the app)

## Architecture

### Panel System

`flexlayout-react` `Layout` + `Model` in `App.tsx`. Default layout: Library +
Info on the left; 3D Structure / Sequence / Elements / Interactions on the
right. Every tabset has a "+" button (`onRenderTabSet`) that opens a MUI Menu
listing: 3D Structure, 3D Structure (B), Sequence, Elements, Interactions,
Alignment, DVBFixer, Mutations, Library, Info. Sequence panels keep their own
chain selection.

### Data Flow

```
Library / FileLoader ─┐
                      ├─→ primary plugin   → extractChains/Elements/Meta → structureStore (chains, elements, meta)
                      └─→ secondary plugin → extractChains              → structureStore (secondaryChains)
                                                ↓
            structureStore + selectionStore ────┼────────────────────────────────────┐
                                                │                                    │
                       SequenceViewer  ElementsTable  InteractionsPanel  Info        │
                                                ↑                                    │
                       AlignmentPanel  ←  primaryChains + secondaryChains            │
                                                ↑                                    │
                              MolstarViewer (primary + secondary slots)  ←  helpers ─┘
```

### Dual 3D Viewers

`MolstarViewer` takes `slot: 'primary' | 'secondary'` and each renders its own
independent `PluginUIContext`. Both plugins are kept in `structureStore`
(`plugin`, `secondaryPlugin`). Library and FileLoader honor `loadTargetSlot`
('primary' | 'secondary') to choose where to load. The secondary viewer
publishes only its chains (for cross-structure Alignment) — it doesn't touch
elements / meta / Interactions.

Post-load, each viewer auto-runs `PluginCommands.Camera.OrientAxes` to face
the principal axis; camera sync is temporarily disabled during this orient.

### Camera Sync (`src/hooks/useCameraSync.ts`)

Toggled via the link icon in the AppBar (only shown when both viewers exist).
Mechanism: subscribe to each plugin's `canvas3d.didDraw`, snapshot the camera,
mirror to the other viewer if (a) the snapshot actually changed and (b) we
aren't the source of that change (per-direction `applying` flags + last
snapshot equality check). Mirror with `setState(snap, 0)` for instant zero-anim
mirroring.

### Structure Library (with hierarchy + starring)

`structures/` folder at project root is the local database. `vite.config.ts`
has a custom Vite plugin (`serve-structures`) that recursively scans
subfolders, **skips `.*` and `_*` directories**, and merges `index.json`
entries with auto-detected files. It also **auto-prunes** stale `index.json`
entries whose file no longer exists on disk and **strips orphan `parent`
references** (parent file deleted but child still alive) so orphaned children
become roots and can display the starred-descendant hint chip.

Entries can have a `parent` field pointing to another entry's `file`. The
`StructureLibrary` component renders the result as an expandable tree
(parent → child → grandchild). **Everything starts collapsed by default** —
users explicitly open parents via the chevron icon. No auto-expand.

Starring: each row has a star icon.
- `POST /api/library/star { file }` flips the `starred` flag in `index.json`.
- Only one starred entry per family (root + descendants). Starring unstars siblings.
- The tree structure is NOT modified by starring — it's just a flag.
- When the user clicks a **family root** that has no `starred` itself but a
  descendant is starred, the library loads the starred descendant instead.
- The family root row shows an orange `⭐ → <name>` hint chip in that case.
  The hint chip is gated on `depth === 0 && !entry.starred` only — `entry.parent`
  is NOT checked, so even an entry that *was* a child but became a root via
  orphan-parent cleanup still gets the chip.

**Per-entry metadata** — each library entry's `name`, `organism`, `method`,
`resolution`, `description` are persisted in `index.json` and edited via
the Info panel:
- `StructureLibrary.loadStructureRaw` populates the store's `meta` from the
  loaded entry's fields, so switching structures swaps the Info display.
- `MolstarViewer` post-load extracts `name` / `method` from the PDB header
  ONLY as a fallback — if the entry already has these set, they're kept.
- `StructureInfo` debounces edits 500 ms and PUTs to `/api/library/meta`,
  then bumps `libraryVersion` so the Library row re-renders with the
  updated name/description.

**Reactive refresh** — `structureStore.libraryVersion` is a monotonic
counter. Any mutation (star toggle, meta edit, DVBFixer Run, etc.) calls
`bumpLibraryVersion()`. `StructureLibrary`'s fetch effect depends on this
counter, so the library re-fetches `index.json` automatically. No manual
refresh needed.

### Mol* Integration

Initialized via `createPluginUI` + `renderReact18` in `MolstarViewer.tsx`.
Key API patterns:

- **Load**: `plugin.builders.data.rawData()` → `parseTrajectory()` → `hierarchy.applyPreset()`
- **Query residues**: `MolScriptBuilder` → `compile()` + `QueryContext` → `StructureSelection.toLociWithSourceUnits()`
- **Select / highlight**: `plugin.managers.interactivity.lociSelects.select/deselectAll()` / `lociHighlights.highlight/clearHighlights()`
- **Read selection**: `plugin.managers.structure.selection.entries`; iterate atoms via `OrderedSet.getAt()` / `OrderedSet.size()`; read props via `StructureProperties.*(location)` on a `StructureElement.Location`
- **Custom-tagged repr** (NOT `focus.setFromLoci`): `StateTransforms.Model.StructureSelectionFromBundle` + `StateTransforms.Representation.StructureRepresentation3D` with explicit tags. See `showSticksForLoci()` in `molstar-helpers.ts`.
- **Visibility**: `setSubtreeVisibility()` from `molstar/lib/mol-plugin/behavior/static/state`
- **Interactions**: `computeInteractions()` from `molstar/lib/mol-model-props/computed/interactions`
- **Camera**: `plugin.managers.camera.focusSphere(Loci.getBoundingSphere(loci))` / `focusLoci(loci)` / `reset(undefined, 0)`

**Why we avoid `focus.setFromLoci()`**: `StructureFocusRepresentation`'s
`focus.clear()` is guarded by `if (this.state.current)` and short-circuits
when undefined; `ensureShape` unconditionally creates a `SurrSel` sub-tree
with `expandRadius` (default 5 Å, can't be 0). Workaround: push `undefined`
directly onto `plugin.managers.structure.focus.behaviors.current` and use
our own tagged repr nodes.

### Custom Tagged Representations + Color Theme

`src/lib/molstar-helpers.ts`:
- `showSticksForLoci(plugin, loci, tag, label)` — tagged `StructureSelectionFromBundle` + `StructureRepresentation3D` (ball-and-stick, **`xrayShaded: false`** for solid sticks). Replaces existing nodes with that tag.
- `deleteCellsByTag(plugin, tag)` — `StateSelection.Generators.root.subtree().withTag(tag)` → delete.
- `focusInterfaceForChain(plugin, chainId, category, radius=5)` — entity-type-aware contact MolScript (chain X residues within 5 Å of any non-self atom ∪ partner-side residues within 5 Å of chain X). Uses tag `tarantino-interface`, then `camera.focusSphere`. The `category` arg maps to a MolScript `entity.type` test so a polymer chain "A" and a ligand with chain id "A" are distinct selves.
- `showSelectionSticks(plugin, residues)` / `clearSelectionSticks(plugin)` — tag `tarantino-selection`. Called by `useSequenceSync` and `AlignmentPanel`.

`src/lib/residue-color-theme.ts` registers `tarantino-residue-type`: carbons
by residue class (hydrophobic green, positive blue, negative red, polar orange,
cysteine yellow, aromatic teal, special pink), other atoms CPK. Applied to
the default focus representation (via subscription that retags
`structure-focus-target-repr` / `-surr-repr` cells) and our custom-tagged sticks.

`src/molstar-theme.scss` overrides the Mol* SCSS skin to match the app palette.
`src/lib/residue-codes.ts` has `THREE_TO_ONE` for non-canonical codes (CYX/CYM/CSO → C,
HID/HIE/HIP → H, SEP → S, MSE → M, etc.); `toCanonicalThree()` maps back.

### Sync Hooks

- `useMolstarSync` (3D → sequence): registers a `LociMarkProvider` on primary
  plugin's `lociSelects` (wrapped in try/catch, **zero re-entrant side-effects**
  so a throw can't break the next provider in the chain). Subscribes to primary
  `interaction.hover` (debounced 50 ms). **Empty-click cleanup is attached to
  BOTH viewers' `interaction.click`** — on `Loci.isEmpty` it wipes 3D state in
  both viewers (deselect / clearHighlights / focus.next(undefined) + clear /
  clearInterfaceFocus / clearSelectionSticks / `camera.reset(undefined, 0)`),
  then `setFocusedChain(null)`, `selectionStore.clearSelection()`, and
  `fireClearAll()` so the Alignment panel resets its local sel sets.
- `useSequenceSync` (sequence → primary 3D): on `_lock === 'sequence'`, async
  clearSelection → push `undefined` to focus → `await clearInterfaceFocus` →
  if non-empty `selectResiduesInViewer('select')` + `await showSelectionSticks`;
  else `clearSelectionSticks`.
- `useCameraSync` (primary ↔ secondary): see above.

`selectionStore._lock` (expires after 200 ms) prevents infinite update loops.

### Sequence Panel (`src/components/SequenceViewer.tsx`, `src/components/ChainSelector.tsx`)

`extractChains` in `molstar-helpers.ts` walks ATOM records to collect residues
per chain, then merges in **SEQRES residues missing from ATOM** by looking up
`model.sequence.byEntityKey[entityIndex]` (via `model.entities.getEntityIndex(entityId)`)
and walking its `seqId.value(i)` / `compId.value(i)` columns. Each residue gets
a `present: boolean` — `true` if it has coordinates, `false` if SEQRES-only.

Both `SequenceViewer` and `ChainSelector` filter the store's `chains` through
the same pipeline:
1. Strip water/ion residues (HOH/ZN/MG/...) from each chain's residue list.
2. Drop chains with ≤ 1 residue left.
3. Drop chains where **every** residue's `threeToOne()` is `'X'` — typically
   glycans (NAG / BMA / MAN) or other non-polypeptide chains that got assigned
   a chain id by Mol*'s polymer-classifier. Without this filter the dropdown
   shows chains whose "sequence" is just a row of X's.
4. Sort chains alphabetically via `localeCompare(..., { numeric: true, sensitivity: 'base' })`.

`SequenceViewer`'s chain-init effect **validates every fallback candidate** against
its filtered `chains` list. The store's `activeChainId` is set to `chains[0].id` of
the *unfiltered* chains, which can be a glycan filtered out by step 3 — using it
blindly would silently leave `activeChain` undefined and render a blank pane.
Fix: try `[initialChainId, globalChainId]` in order, accept the first that exists
in the filtered list, otherwise fall back to filtered `chains[0].id`.

Missing residues render with greyed text (`#b5bfcc`), dashed border, italic font,
and `cursor: not-allowed`; mouse handlers are nulled out so they can't be selected
or hovered. Tooltip reads `"<RES> <seqId> (<class>) — declared in SEQRES, missing
from structure"`.

### Alignment Panel (`src/components/AlignmentPanel.tsx`, `src/lib/alignment.ts`)

`alignment.ts` is pure-TS Needleman-Wunsch with BLOSUM62 (alphabet
`ARNDCQEGHILKMFPSTWYVBZX*`, affine gap penalty open -11, extend -1). Returns
aligned strings + `|` / `:` / `.` / ` ` annotation + identity / similarity /
score / length.

`AlignmentPanel.tsx`: two chain pickers (A / B) grouped by source ('A' =
primary viewer chains, 'B' = secondary viewer chains). Drag-select per side;
mouseup commits and pushes to the corresponding plugin via
`selectResiduesInViewer` + `showSelectionSticks`. The number row above/below
each sequence is clickable — picking any column toggles residues on BOTH
sides (bilateral pick). `Focus` zooms each viewer to its selection; if
camera sync is on and viewers differ, sync is suppressed during focus.
Subscribes to `structureStore.clearAllSignal` to reset its local sel sets.

### Interactions Panel

`InteractionsPanel.tsx` uses `computeInteractions()` + `structure.interUnitBonds` /
intra-unit bond scans for disulfides and inter-chain covalents. Filterable
table with chain pair dropdowns (water excluded). Clicking a row focuses the
3D view. When `structureStore.focusedChainId` is set (via Elements'
"Show Interface"), table auto-filters and shows a banner:
`Interface: polymer chain A · 24 contacts · ↔ B (12) ↔ C (3) · [Clear]`.

### DVBFixer Panel + Backend

**Frontend** (`src/components/DVBFixerPanel.tsx`): MUI Tabs (one per
sub-command), input file picker filtered from `structures/index.json`, flag
form auto-generated from the spec fetched at runtime from `GET /api/dvbfixer-spec`.
Per-flag controls map by `type`: bool → Checkbox, select → Select,
number/text → TextField.

**Auto-paste input** — the input picker tracks `structureStore.fileName`
(currently-loaded primary structure). Whenever the user hasn't manually picked
an input yet (`userPickedInputRef.current === false`) OR the current selection
is empty, the picker mirrors the active structure. Selecting from the dropdown
sets `userPickedInputRef.current = true` and stops the auto-mirror.

**Auto-open output** — on successful run, the panel `await plugin.clear()`s the
primary viewer and loads the output file directly (`rawData` → `parseTrajectory`
→ `applyPreset('default')`), bumps `libraryVersion`, sets `fileName` to the
output, and resets `userPickedInputRef` so the next run's input mirrors the new
active structure. Failures leave the viewer untouched.

**Backend** (`server/api-plugin.ts`, a Vite middleware plugin):
- `GET /api/dvbfixer-spec` — returns `COMMANDS` from `server/dvbfixer-spec.ts`.
- `POST /api/dvbfixer/:command` — body `{ inputFile, values }`. Spawns the
  CLI (env `DVBFIXER_CMD`, default `'dvbfixer'`; can be a multi-token command
  like `'micromamba run -n tarantino dvbfixer'` — split on whitespace).
  Output: `structures/dvb_<command>_<timestamp>/<input>_<command>.pdb`.
  - **Success**: entry appended to `structures/index.json` with `parent`
    pointing to the input file → library renders parent → child.
  - **Failure** (non-zero exit): output folder moved to
    `structures/_dvb_failed/<subdir>` (underscore prefix → scanner skips it).
    Response includes `movedTo`.
- `GET / POST / PUT / DELETE /api/mutations[/:id]` — CRUD for the
  `mutations` table; auto-creates the table on first connection. Returns 503
  if `DATABASE_URL` is unset.
- `POST /api/library/star { file }` — toggles `starred` flag in `index.json` (one starred per family).
- `PUT /api/library/meta { file, name?, organism?, method?, resolution?, description? }` — persists
  per-entry metadata edits into `index.json`. Promotes auto-detected files to manual entries on
  demand. Only patches the named fields — other entry fields (`id`, `parent`, `starred`, etc.) are
  preserved.
- `GET /api/status` — `{ dvbfixer, databaseConfigured, databaseConnected }`.

**Spec format** (`server/dvbfixer-spec.ts`):
- `FlagDef.type`: `'bool' | 'number' | 'text' | 'select'`
- `FlagDef.repeatable: true` — comma-split UI input becomes `--flag v1 --flag v2 --flag v3` (used by `--mutate`).
- `FlagDef.multi: true` — whitespace-split UI input becomes a single `--flag v1 v2 v3` (argparse `nargs='+'`, used by `--ff`).
- `--platform` choices: `['', 'CPU', 'CUDA', 'OpenCL', 'Reference']`. Empty string is omitted entirely so DVBFixer auto-picks.

### Mutations Panel + PostgreSQL

`MutationsPanel.tsx` — `@mui/x-data-grid` with columns
`id` / `chain` / `mutation_name` / `mutations` (the last is a comma-separated
list of point mutations, e.g. `'M252Y,S254T,T256E'`). Inline cell editing via
`processRowUpdate` → `PUT /api/mutations/:id`. If the API returns 503 the
panel renders a config hint pointing at `DATABASE_URL`.

Backend uses a lazy `pg.Pool` keyed off `DATABASE_URL`. `docker-compose.yml`
ships `postgres:16-alpine` as service `db` (port 5432, volume
`tarantino-pg-data`, `pg_isready` healthcheck). `npm run dev` auto-sets
`DATABASE_URL` to this container.

`scripts/set-modeller-key.sh` finds `<env>/lib/modeller-*/modlib/modeller/config.py`
inside the active conda/micromamba env (or the prefix passed as `$1`) and writes
`license = r'<key>'` (reads from `KEY=`).

### Empty 3D Click Behavior

`useMolstarSync.attachEmptyClickCleanup` is a single unified handler attached
to both viewers' `interaction.click`. Default Mol* `clickDeselectAllOnEmpty`
requires `selectionMode === true` (default false), so Mol* doesn't auto-clear;
we check `Loci.isEmpty(event.current.loci)` ourselves (NOT `isEmptyLoci(loci)`
— Mol* fires a `StructureElement.Loci` with empty `elements`, not the
`EmptyLoci` singleton).

## Key Constraints

- **Mol* imports use deep paths** (`molstar/lib/mol-model/structure`) — no barrel export.
- **MUI v9 only**: `@mui/material`, `@mui/icons-material`, `@mui/x-data-grid`. No Tailwind, no shadcn.
- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly` all on.
- **`@` alias** → `src/` (in `vite.config.ts`).
- **structures/** is auto-scanned recursively, skipping `.*` and `_*` directories. `index.json` is auto-pruned on every scan.
- **The frontend never imports from `server/`** — it talks to the backend over HTTP. The DVBFixer spec is fetched at runtime from `/api/dvbfixer-spec`.
- **`pg` is loaded lazily** server-side via dynamic import; missing pg or unset `DATABASE_URL` doesn't break the app.
- **postinstall** `scripts/fix-native-deps.mjs` installs the right platform-specific `@rollup/rollup-*` binding.

## File Map

```
src/
  App.tsx                       # Layout, panel factory, "+" menu, camera sync icon, Esc handler
  main.tsx                      # MUI ThemeProvider, CssBaseline, ErrorBoundary
  theme.ts                      # MUI createTheme
  index.css, molstar-theme.scss # FlexLayout vars + Mol* SCSS skin

  components/
    MolstarViewer.tsx           # Mol* init per slot, color theme registration, OrientAxes post-load
    SequenceViewer.tsx          # Monospace residue grid, drag-select, missing-SEQRES gap rendering, validated chain init
    StructureLibrary.tsx        # Tree of structures, starring, A/B slot toggle, hint chip (gated on depth+!starred only)
    StructureInfo.tsx           # Editable metadata + stats
    ElementsTable.tsx           # Tree, visibility toggles, row-click camera focus (sync-suppressed), "Show Interface"
    InteractionsPanel.tsx       # Computed contacts, focused-chain banner
    AlignmentPanel.tsx          # Pairwise NW alignment, per-source plugin routing
    DVBFixerPanel.tsx           # MUI Tabs, form from /api/dvbfixer-spec, auto-pastes active fileName, auto-loads output on success
    MutationsPanel.tsx          # DataGrid backed by /api/mutations
    FileLoader.tsx              # Upload button (honors loadTargetSlot)
    ChainSelector.tsx           # Chain dropdown (same filter+sort as SequenceViewer)

  hooks/
    useMolstarSync.ts           # 3D → sequence + empty-click cleanup on both viewers
    useSequenceSync.ts          # Sequence → 3D (cartoon halo + solid sticks)
    useCameraSync.ts            # Bidirectional camera mirror via canvas3d.didDraw

  stores/
    structureStore.ts           # plugin, secondaryPlugin, loadTargetSlot, chains+secondaryChains, elements, meta, focusedChainId+Category, cameraSyncEnabled, clearAllSignal
    selectionStore.ts           # selected/hovered residues, _lock mechanism

  lib/
    molstar-helpers.ts          # MolScript builders, showSticksForLoci, extractChains (with SEQRES merge + present flag)
    alignment.ts                # Needleman-Wunsch + BLOSUM62 (pure TS)
    residue-codes.ts            # 3-to-1 letter code (incl. non-canonical)
    residue-color-theme.ts      # Mol* ColorTheme: carbons by residue class, others CPK

server/
  api-plugin.ts                 # Vite middleware: /api/dvbfixer/*, /api/mutations, /api/library/star, /api/library/meta, /api/status
  dvbfixer-spec.ts              # CommandDef[] for split/renumber/model/prepare/minimize/protonate/glycam

scripts/
  dev.mjs                       # Smart launcher: auto docker postgres → vite
  fix-native-deps.mjs           # postinstall
  set-modeller-key.sh           # Writes Modeller license into config.py

structures/                     # Manifest (index.json with parent/starred), pdb files, dvb_<cmd>_<ts>/ outputs, _dvb_failed/ for failures
docker-compose.yml              # postgres:16-alpine, service `db`
vite.config.ts                  # apiPlugin + serve-structures (recursive scan, prune stale, strip orphan parents, skip `.*`/`_*`)
```
