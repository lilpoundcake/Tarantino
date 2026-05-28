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
- **Antibody Engineer**: takes any antibody-containing structure (full / Fab /
  Fc), classifies its chains (HC / LC κ / LC λ, IgG1–4), maps EU- or
  Kabat-numbered mutations from the Mutations DB onto every chain in each
  equivalent-chain group, runs the appropriate multi-step DVBFixer pipeline
  (`renumber → prepare --mutate → [glycam → minimize --no-solvent →
  protonate → minimize --no-solvent → glycam --to-charmm]` for glycan
  inputs, 5-step variant without glycam for non-glycan), and streams live
  per-step progress to a `LinearProgress`. Dedup: same `(input, mutations,
  glycan, scheme)` combo skips re-running and loads the cached output.
- **Mutations**: PostgreSQL-backed editable DataGrid (igg_subclass / chain /
  mutation_name / mutations) with multi-select IgG-subclass tagging and
  HC/LC chain dropdown; auto-mirrored to a git-tracked `mutations.json`
  backup at repo root
- **Library**: hierarchical tree of pre-loaded structures with starring
- **Info**: stats summary at the top, single-field metadata (Name + Notes),
  and an **Equivalent chains** section that auto-groups multimeric copies
  via sequence identity (with optional manual override persisted in
  `index.json`)

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

Post-load, each viewer (a) hides the water component, (b) swaps the **ion**
component's default ball-and-stick representation for `spacefill` so each ion
renders as a Van der Waals sphere — `createStructureRepresentationParams(plugin,
structure, { type: 'spacefill' })` is built once and `.update()`ed into every
ion-component repr cell, then `runTask(updateTree())`. The default `physical`
size theme uses each element's VdW radius. (c) auto-runs
`PluginCommands.Camera.OrientAxes` to face the principal axis; camera sync is
temporarily disabled during this orient.

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

`SequenceViewer`, `ChainSelector`, **and** `AlignmentPanel`'s chain picker all
apply the same filter pipeline to the store's `chains`:
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

### Info Panel + Equivalent Chains (`src/components/StructureInfo.tsx`, `src/lib/chain-grouping.ts`)

`StructureInfo.tsx` layout (top → bottom):

1. **Summary** — 4 stat cards (Chains / Residues / Atoms / Elements).
   The Chains and Residues counts are computed against
   `filterSequenceableChains(chains)` so glycan / water / ion-only chains
   don't inflate the numbers.
2. **File** — file path in a monospace `Paper` with
   `wordBreak: 'break-all'` so long DVBFixer output paths
   (`dvb_<cmd>_<ts>/<input>_<cmd>.pdb`) wrap instead of overflowing.
3. **Metadata** — single `Name` TextField. (Organism / Method /
   Resolution are still in `StructureMeta` + `index.json` for backwards
   compat, but the inputs are hidden.)
4. **Notes** — multi-line `description` TextField.
5. **Equivalent chains** — see below.

**Equivalent chains section** (`EquivalentChainsSection` inside
`StructureInfo.tsx`, helper in `src/lib/chain-grouping.ts`):

- **Auto-detect.** `computeEquivalentChains(chains, threshold=0.95)`
  builds a sequence per chain via `chainToSequence` (from
  `src/lib/alignment.ts`), runs `alignSequences` pairwise + computes
  `trimmedIdentity` (also from `lib/alignment.ts`). Pairs with
  trimmed-identity ≥ threshold are merged via union-find (single-linkage
  clustering). Result is sorted: multi-member groups first by smallest
  chain id, singletons last.
- **Trimmed identity.** `trimmedIdentity(result)` walks the alignment,
  finds the first and last columns where **neither** sequence is a gap,
  counts `annotation === '|'` matches in that window. Internal gaps stay
  in the window and count as mismatches. This handles the FcRn case
  where chains H and I are the same protein but I has a truncated
  N-terminus — without trimming, the global identity would be much
  lower than 95% and the pair would never group.
- **Chain filter.** `filterSequenceableChains` is the same pipeline used
  by `SequenceViewer`, `ChainSelector`, and `AlignmentPanel`: strip
  water/ion residues, drop chains with ≤ 1 residue left, drop chains
  whose every residue maps to `'X'` (glycans). Re-used here so the
  groups match the chain set the user sees elsewhere.
- **Display mode.** Multi-member groups render as Paper rows with one
  filled Chip per chain id + a subtle `97.0 % over 218 aa` annotation.
  Singletons collapse into one de-emphasised `Unique: B, F, K` row.
  Footer toolbar: `[Edit groups]` + (when override exists) a `manual`
  Chip + `[Reset]` button.
- **Edit mode.** One TextField per group (comma-separated chain ids) +
  `[+ Add group]`. `[Save]` runs `validateGrouping(parsed, availableIds)`
  which canonicalises (sort + dedupe), reports `duplicates` (chain id in
  multiple groups → error) and `unknown` (chain id not present → error).
  Chains left out become implicit singletons. `[Cancel]` discards local
  edits.
- **Persistence.** `StructureMeta.equivalentChains?: string[][]` is part
  of the existing META_FIELDS debounced-PUT pipeline. `undefined` means
  "auto-detect, don't persist"; an array (incl. `[]`) is a manual
  override. The PUT body sends `null` when the field is undefined; the
  backend honors `null` as "delete this key from `index.json`" so the
  Reset button actually removes the persisted override rather than
  leaving an empty array.
- **Load path.** `StructureLibrary.loadStructureRaw` reads
  `entry.equivalentChains` into `setMeta(...)` so manual overrides
  survive structure switches and page reloads.

### Alignment Panel (`src/components/AlignmentPanel.tsx`, `src/lib/alignment.ts`)

`alignment.ts` is pure-TS Needleman-Wunsch with BLOSUM62 (alphabet
`ARNDCQEGHILKMFPSTWYVBZX*`, affine gap penalty open -11, extend -1). Returns
aligned strings + `|` / `:` / `.` / ` ` annotation + identity / similarity /
score / length. Also exports `chainToSequence(residues)` (1-letter
sequence from a residue list — used by `AlignmentPanel` and
`chain-grouping`) and `trimmedIdentity(result)` (identity computed after
trimming leading / trailing gap columns — used by `chain-grouping` and
elsewhere when truncated termini shouldn't penalise the score).

`AlignmentPanel.tsx`: two chain pickers (A / B) grouped by source ('A' =
primary viewer chains, 'B' = secondary viewer chains); each source's chains
go through the all-X / length / alphabetic-sort filter described in the
Sequence Panel section. Drag-select per side;
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
- `POST /api/antibody-engineer/run` — **SSE** endpoint. Body `{ inputFile,
  mutationIds: number[], equivalentChainsMap?, hasGlycan: boolean, scheme:
  'EU'|'Kabat' }`. Streams `data: <JSON>\n\n` events. See the dedicated
  Antibody Engineer architecture section above.
- `POST /api/library/star { file }` — toggles `starred` flag in `index.json` (one starred per family).
- `PUT /api/library/meta { file, name?, organism?, method?, resolution?, description?, equivalentChains? }` — persists
  per-entry metadata edits into `index.json`. Promotes auto-detected files to manual entries on
  demand. Only patches the whitelisted fields — other entry fields (`id`, `parent`, `starred`, etc.) are
  preserved. **`null` is treated as "delete this key"** so the Info panel's `Reset` button can
  remove a manual `equivalentChains` override and fall back to auto-detection.
- `GET /api/status` — `{ dvbfixer, databaseConfigured, databaseConnected }`.

**Spec format** (`server/dvbfixer-spec.ts`):
- `FlagDef.type`: `'bool' | 'number' | 'text' | 'select'`
- `FlagDef.repeatable: true` — comma-split UI input becomes `--flag v1 --flag v2 --flag v3` (used by `--mutate`).
- `FlagDef.multi: true` — whitespace-split UI input becomes a single `--flag v1 v2 v3` (argparse `nargs='+'`, used by `--ff`).
- `--platform` choices: `['', 'CPU', 'CUDA', 'OpenCL', 'Reference']`. Empty string is omitted entirely so DVBFixer auto-picks.

### Mutations Panel + PostgreSQL

`MutationsPanel.tsx` — `@mui/x-data-grid` with columns:
- `id` (number)
- `igg_subclass` — **multi-select** with checkbox dropdown (options
  `IgG1`/`IgG2`/`IgG3`/`IgG4`). Stored as a comma-joined string in the
  single TEXT column (e.g. `"IgG1,IgG4"`). Display renders each pick as a
  small Chip via a custom `renderCell`. Edit uses a custom
  `renderEditCell` (`SubclassEditCell`) with a `<Select multiple>` +
  Checkboxes. The dropdown uses **`defaultOpen`** (NOT controlled
  `open={true}` — that races with Popover anchor-rect read on mount and
  crashes the cell as "Error rendering component"). On close,
  `apiRef.current.stopCellEditMode({ id, field })` is wrapped in
  `setTimeout(..., 0)` so MUI's popover close transition finishes before
  DataGrid unmounts the edit cell.
- `chain` — `singleSelect` with options `['', 'HC', 'LC']` for heavy /
  light chain. Legacy free-form values render as-is but new edits pick
  from the dropdown.
- `mutation_name` — free-form text
- `mutations` — comma-separated list of point mutations, e.g.
  `'M252Y,S254T,T256E'`

Inline cell editing via `processRowUpdate` → `PUT /api/mutations/:id`. If
the API returns 503 the panel renders a config hint pointing at
`DATABASE_URL`. Rows are zebra-striped via `getRowClassName` +
`rgba(74,118,196,0.04)` for odd rows so values stay easy to track across
wide rows; hover bumps to `0.10` alpha.

Backend uses a lazy `pg.Pool` keyed off `DATABASE_URL`. `docker-compose.yml`
ships `postgres:16-alpine` as service `db` (port 5432, volume
`tarantino-pg-data`, `pg_isready` healthcheck). `npm run dev` auto-sets
`DATABASE_URL` to this container.

**`mutations.json` git-tracked backup** — the table is auto-mirrored to
`mutations.json` at repo root so the team's mutation library is checked
into git:
- After every successful POST / PUT / DELETE on `/api/mutations`,
  `dumpMutationsToBackup(pg)` writes the full table (sorted by id) as
  JSON to `<projectRoot>/mutations.json`.
- On the first DB connection per process, `seedMutationsFromBackup(pg)`
  runs immediately after `CREATE TABLE IF NOT EXISTS`. If the table is
  empty and `mutations.json` exists, every row is inserted **preserving
  its `id`**, and `mutations_id_seq` is bumped past the max id so
  future auto-ids don't collide. Subsequent runs find the table
  non-empty and skip.
- Schema migration for older deployments: `ALTER TABLE mutations ADD
  COLUMN IF NOT EXISTS igg_subclass TEXT NOT NULL DEFAULT ''` runs
  alongside the `CREATE TABLE IF NOT EXISTS` on every boot.

`scripts/set-modeller-key.sh` finds `<env>/lib/modeller-*/modlib/modeller/config.py`
inside the active conda/micromamba env (or the prefix passed as `$1`) and writes
`license = r'<key>'` (reads from `KEY=`).

### Antibody Engineer (`src/components/AntibodyEngineerPanel.tsx`, `src/lib/antibody-numbering.ts`, `src/lib/antibody-references.ts`, `server/antibody-pipeline.ts`)

End-to-end "select mutations from the DB → produce a mutant structure"
tool. Spans the frontend (chain detection + validation + SSE consumer)
and the backend (multi-step DVBFixer orchestrator + dedup cache).

**Reference library** (`src/lib/antibody-references.ts`) — hardcoded
UniProt constant-region sequences for IgG1/2/3/4 heavy + κ / λ light
(P01857, P01859, P01860, P01861, P01834, P0CG04). EU domain windows are
captured per subclass. A `verifyReferences()` self-check runs on module
load and throws on any landmark mismatch — guarantees a typo in the
hardcoded sequence is caught at startup. Only IgG1 + κ + λ have full
landmark assertions; IgG2/3/4 are best-effort (NW alignment still works
for soft classification) since EU numbering preserves homology across
subclasses with hinge-length gaps that can't be indexed by simple offset.

**Chain identification** (`src/lib/antibody-numbering.ts`):
- `identifyAntibodyChain(residues)` runs NW (reusing `alignSequences`)
  against every reference, picks the winner by `trimmedIdentity ≥ 0.70`
  and a within-class margin `≥ 0.05`. Returns `{ type: HC|LC, subclass,
  region, identity, alignmentLength, margin, domainsObserved, warnings }`.
  Region inference: `domainsObserved` (CH1/hinge/CH2/CH3 from per-window
  coverage) + leading unmatched chain length (≥ 80 aa → VH) →
  full / Fab-HC / Fc / VH-only / scFv / VHH / LC / partial.
- `mapEuToAuthSeqId(residues, eu, classification)` — walks the
  alignment against the winning reference, returns the chain's
  `auth_seq_id` for EU position `n` (or null if outside coverage). Used
  ONLY for frontend pre-flight validation ("does position 322 exist in
  this Fc-only fragment?"). The actual mutation pipeline relies on
  `dvbfixer renumber --scheme eu` doing the renumbering on disk.
- `parseMutation('K322A' | 'G446del')` and `mutateArgFor(chain, parsed)`
  emit `'H:322:ALA'` / `'H:446:del'` formatted CLI args.

**Pipeline orchestrator** (`server/antibody-pipeline.ts`):
- `expandMutations(rows, equivChainsMap)` parses each row's
  comma-separated `mutations` field, fans every token out across all
  chains in the matching equivalent-chain bucket (`HC: ['H','I']` →
  emits both `H:322:ALA` and `I:322:ALA`). 1-letter → 3-letter codes via
  the local `AA1_TO_AA3` map. `del` is forwarded verbatim.
- `validateNoDuplicateTargets(args)` — server-side defensive check; the
  frontend already blocks this case.
- `pipelineSteps(scheme, hasGlycan, mutateArgs)` produces the 7-step
  glycan pipeline or 5-step no-glycan pipeline. Scheme passed to
  DVBFixer is **lowercased** (`'eu'` / `'kabat'`) — the CLI's
  `--scheme` choices are `seqres / kabat / chothia / imgt / martin / eu / aho`.
- `runEngineerPipeline(p)` is the main loop. Each step gets its own
  `structures/dvb_<command>_<ts>_s<N>/` directory (the `_s<N>` suffix
  prevents collisions when the same command appears twice, e.g. two
  `minimize` steps in the glycan pipeline). Intermediate outputs are
  registered as plain `index.json` entries with `parent` set to the
  previous step's output. The FINAL step writes a rich entry with
  `parent` = original input file (not the previous step), plus
  `mutationIds: number[]`, `mutationsResolved: string`,
  `_engineerChecksum: string`, `hasGlycan: boolean`, `scheme: 'EU'|'Kabat'`,
  `command: 'antibody-engineer'`, and a generated `name` like
  `"FcRn — YTE + LALA"`.
- Failure: any non-zero exit code → emit error SSE event, move EVERY
  created output dir into `structures/_engineer_failed/<subdir>` (scanner
  ignores underscore-prefixed dirs), close stream without writing an
  index.json entry.
- Dedup checksum (`engineerChecksum`): SHA-256 over
  `JSON.stringify({ inputFile, sortedMutationIds, hasGlycan, scheme })`.
  `equivalentChainsMap` is intentionally NOT included — fixing the
  equiv map should re-run, not cache-hit.
- `findCachedEntry(structuresDir, inputFile, checksum)` scans
  `index.json` for `parent === inputFile && _engineerChecksum === checksum &&
  file-on-disk`. Hit → emit `step: 0, status: 'done', name: 'cached'` + a
  final `status: 'complete'` event and close.

**SSE route** (`POST /api/antibody-engineer/run`, in
`server/api-plugin.ts`). Body: `{ inputFile, mutationIds, equivalentChainsMap,
hasGlycan, scheme }`. Headers: `Content-Type: text/event-stream` +
`Cache-Control: no-cache` + `X-Accel-Buffering: no` (via the exported
`writeSSEHeaders` helper). Each event is one `data: <JSON>\n\n` chunk
(via `sseSend`) with a single channel — the client switches on
`payload.status` (`'running' | 'done' | 'error' | 'complete'`). Aborts
are observed via `req.on('close')`. The route also queries postgres for
the requested mutation rows (rejects missing IDs) and runs the dedup
lookup before dispatching to `runEngineerPipeline`.

**DVBFixer spec** (`server/dvbfixer-spec.ts`): the `renumber` command's
`--scheme` flag exposes `['', 'seqres', 'kabat', 'chothia', 'imgt',
'martin', 'eu', 'aho']` — full match against the actual CLI.

**Frontend panel** (`src/components/AntibodyEngineerPanel.tsx`). Three
`Paper` cards:
- **Input + detection** — Select for input file (auto-mirrors
  `useStructureStore.fileName`, identical pattern to DVBFixerPanel).
  Detection only runs when the picked file equals the primary plugin's
  current file. Chip row groups detected chains by `type/subclass` (e.g.
  `[HC IgG1 — H, I]`); a `Glycans present` / `No glycans` chip is
  derived from `useStructureStore(s => s.elements)` (`entityType ===
  'branched'` OR any of `NAG/BMA/MAN/FUC/GAL/SIA/GLC/XYL`).
- **Mutations** — fetches `/api/mutations`, filters rows by detected IgG
  subclass (empty `igg_subclass` = universal, applies to every
  structure). Live validation `useMemo` over `(checked, allRows,
  equivalentChainsMap, detections, chains)` produces error chips per
  row: `'no-target-chain'` (no detected HC/LC for the row's chain type),
  `'out-of-range'` (target EU position not in this fragment per
  `mapEuToAuthSeqId`), `'conflict'` (two checked rows both target the
  same `(chainId, position)`). Below the list, a row of chips shows
  `equivalentChainsMap` (e.g. `HC: H, I` / `LC: A, C`) and the
  `previewMutateArgs` count with a tooltip listing the literal
  `--mutate H:322:ALA …` args.
- **Pipeline** — numbering-scheme `ToggleButtonGroup` (EU / Kabat,
  pinned at the top of the section), glycan-handling `RadioGroup`
  (auto / force-with / force-without), monospace preview of the step
  sequence, then the Run button and progress / cached / error states.

**`equivalentChainsMap` resolution** — frontend constructs it by
bucketing detected chains by classification type (`HC` or `LC`), then
expands each bucket using the user's `meta.equivalentChains` override
(from the Info panel). If a manual group contains an already-typed
chain, every other chain in the group gets promoted to the same type.
Backend receives the resolved map and trusts it.

**Library integration** — the rich final entry's `parent` set to the
ORIGINAL input means the Library tree shows `FcRn.pdb → "FcRn — YTE"`
as a direct child, regardless of how many intermediate steps the
pipeline ran. Intermediate outputs become children of the previous
step's output (deep but discoverable). `bumpLibraryVersion()` is called
on completion to force a re-fetch.

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
    MolstarViewer.tsx           # Mol* init per slot, color theme registration, post-load (hide water, ions→spacefill, OrientAxes)
    SequenceViewer.tsx          # Monospace residue grid, drag-select, missing-SEQRES gap rendering, validated chain init
    StructureLibrary.tsx        # Tree of structures, starring, A/B slot toggle, hint chip (gated on depth+!starred only)
    StructureInfo.tsx           # Stats summary at top, single-field metadata + Notes, EquivalentChainsSection (auto-detect via NW + trimmed identity, manual override persisted in index.json)
    ElementsTable.tsx           # Tree, visibility toggles, row-click camera focus (sync-suppressed), "Show Interface"
    InteractionsPanel.tsx       # Computed contacts, focused-chain banner
    AlignmentPanel.tsx          # Pairwise NW alignment, per-source plugin routing
    DVBFixerPanel.tsx           # MUI Tabs, form from /api/dvbfixer-spec, auto-pastes active fileName, auto-loads output on success
    MutationsPanel.tsx          # DataGrid backed by /api/mutations: multi-select IgG Subclass chips, HC/LC chain dropdown, zebra rows
    AntibodyEngineerPanel.tsx   # End-to-end mutate-by-DB-row tool: chain detection, validation, SSE-driven progress, auto-load output
    FileLoader.tsx              # Upload button (honors loadTargetSlot)
    ChainSelector.tsx           # Chain dropdown (same filter+sort as SequenceViewer)

  hooks/
    useMolstarSync.ts           # 3D → sequence + empty-click cleanup on both viewers
    useSequenceSync.ts          # Sequence → 3D (cartoon halo + solid sticks)
    useCameraSync.ts            # Bidirectional camera mirror via canvas3d.didDraw

  stores/
    structureStore.ts           # plugin, secondaryPlugin, loadTargetSlot, chains+secondaryChains, elements, meta (incl. optional equivalentChains override), focusedChainId+Category, cameraSyncEnabled, clearAllSignal
    selectionStore.ts           # selected/hovered residues, _lock mechanism

  lib/
    molstar-helpers.ts          # MolScript builders, showSticksForLoci, extractChains (with SEQRES merge + present flag)
    alignment.ts                # Needleman-Wunsch + BLOSUM62 + chainToSequence + trimmedIdentity (terminal-gap-aware)
    chain-grouping.ts           # computeEquivalentChains (pairwise NW + union-find), validateGrouping, filterSequenceableChains
    antibody-references.ts      # Hardcoded UniProt CH/CL sequences (IgG1-4, κ, λ) + EU domain anchors + landmark self-check
    antibody-numbering.ts       # identifyAntibodyChain (NW vs refs → HC/LC + subclass + region), mapEuToAuthSeqId, parseMutation, mutateArgFor
    residue-codes.ts            # 3-to-1 letter code (incl. non-canonical)
    residue-color-theme.ts      # Mol* ColorTheme: carbons by residue class, others CPK

server/
  api-plugin.ts                 # Vite middleware: /api/dvbfixer/*, /api/mutations, /api/library/star, /api/library/meta, /api/antibody-engineer/run (SSE), /api/status. Exports runDvbfixer + getPg + writeSSEHeaders + sseSend for reuse.
  antibody-pipeline.ts          # Multi-step DVBFixer orchestrator: expandMutations, validateNoDuplicateTargets, pipelineSteps (glycan-7 vs no-glycan-5), engineerChecksum dedup, runEngineerPipeline (intermediate + final index.json entries, _engineer_failed/ rollback)
  dvbfixer-spec.ts              # CommandDef[] for split/renumber/model/prepare/minimize/protonate/glycam. renumber.--scheme options: seqres/kabat/chothia/imgt/martin/eu/aho

scripts/
  dev.mjs                       # Smart launcher: auto docker postgres → vite
  fix-native-deps.mjs           # postinstall
  set-modeller-key.sh           # Writes Modeller license into config.py

structures/                     # Manifest (index.json with parent/starred/equivalentChains/mutationIds/_engineerChecksum), pdb files, dvb_<cmd>_<ts>/ outputs, _dvb_failed/ for single-command failures, _engineer_failed/ for Antibody Engineer pipeline failures
mutations.json                  # Git-tracked backup of the postgres `mutations` table. Auto-written after every CRUD, auto-seeded on empty table.
docker-compose.yml              # postgres:16-alpine, service `db`
vite.config.ts                  # apiPlugin + serve-structures (recursive scan, prune stale, strip orphan parents, skip `.*`/`_*`)
```
