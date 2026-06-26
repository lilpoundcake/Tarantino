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
  prepare / minimize / protonate / convert), outputs registered as child entries
- **Antibody Engineer**: takes any antibody-containing structure (full / Fab /
  Fc), classifies its chains (HC / LC κ / LC λ, IgG1–4), maps EU- or
  Kabat-numbered mutations from the Mutations DB onto every chain in each
  equivalent-chain group, runs the appropriate multi-step DVBFixer pipeline
  (`renumber → prepare --mutate → [convert → minimize --no-solvent →
  protonate → minimize --no-solvent → convert --to-charmm]` for glycan
  inputs, 5-step variant without convert for non-glycan), and streams live
  per-step progress to a `LinearProgress`. Dedup: same `(input, mutations,
  glycan, scheme)` combo skips re-running and loads the cached output.
- **Mutations**: PostgreSQL-backed editable DataGrid (igg_subclass / chain /
  mutation_name / mutations / properties) with multi-select IgG-subclass
  tagging, HC/LC chain dropdown, free-form Properties notes column, and
  drag-drop row reordering (persisted via `display_order`). Auto-mirrored
  to a git-tracked `mutations.json` backup at repo root.
- **Library**: hierarchical tree of pre-loaded structures with starring
- **Info**: stats summary at the top, single-field metadata (Name + Notes),
  and an **Equivalent chains** section that auto-groups multimeric copies
  via sequence identity (with optional manual override persisted in
  `index.json`)
- **Settings**: app-wide preferences (auto-orient-on-load toggle + Alignment
  source-label toggle [File / Name]; all persisted in `localStorage`)

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

`flexlayout-react` `Layout` + `Model` in `App.tsx`. Default layout (in the
same tabset, the first tab is the active one):
- Left column: Library, then (Info | **Settings**).
- Right column (main viewer): (3D Structure | **DVBFixer** | **Antibody
  Engineer** | **Mutations**), with (Sequence | **Alignment**) and
  (Elements | Interactions | Clashes) tabsets below.

Every tabset has a "+" button (`onRenderTabSet`) that opens a MUI Menu
listing: 3D Structure, 3D Structure (B), Sequence, Elements, Interactions,
Alignment, DVBFixer, Antibody Engineer, Mutations, Library, Info,
Settings. Sequence panels keep their own chain selection.

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

**Tab-close cleanup** — when the user closes a 3D Structure tab,
`MolstarViewer`'s effect-cleanup disposes the plugin AND clears, for that
slot, the store's plugin/chains/fileName. Without the `fileName` clear,
the Library's A/B chip would remain stuck on whichever structure was last
loaded into that viewer even though the viewer no longer exists.
Additionally, when the SECONDARY slot is torn down and
`loadTargetSlot === 'secondary'`, the cleanup snaps it back to
`'primary'` — otherwise the Library's A/B toggle would silently stay on
B (its UI is gated on `secondaryPlugin`, so it disappears with the
viewer), every subsequent Library click would bail out with *"Open a
'3D Structure (B)' tab first"*, and the user would be trapped unable to
load anything into A. `StructureLibrary` also runs a defensive
`useEffect` watchdog over `(secondaryPlugin, loadTargetSlot)` that
performs the same snap-back, as a belt-and-braces safety net for any
code path that disposes the secondary plugin without going through
`MolstarViewer`'s cleanup.

Post-load, each viewer (a) hides the water component, (b) swaps the **ion**
component's default ball-and-stick representation for `spacefill` so each ion
renders as a Van der Waals sphere — `createStructureRepresentationParams(plugin,
structure, { type: 'spacefill' })` is built once and `.update()`ed into every
ion-component repr cell, then `runTask(updateTree())`. The default `physical`
size theme uses each element's VdW radius. (c) **optionally** runs
`PluginCommands.Camera.OrientAxes` to face the principal axis — gated on
`useStructureStore.autoOrientOnLoad` (default OFF, toggled in the Settings
panel, persisted in `localStorage` under key `tarantino.autoOrientOnLoad`).
When ON, camera sync is temporarily disabled during the orient so the
snapshot doesn't get mirrored to the other viewer mid-orientation.

### Camera Sync (`src/hooks/useCameraSync.ts`)

Toggled via the link icon in the AppBar (only shown when both viewers exist).
Mechanism: subscribe to each plugin's `canvas3d.didDraw`, snapshot the camera,
mirror with `dst.canvas3d.camera.setState(snap, 0)` for instant zero-anim
mirroring.

**Anti-feedback uses pending-draw flags, NOT snapshot equality**. When subA
mirrors A → B, it sets `pendingFromAToB = true`. The next `B.didDraw` consumes
the flag and skips its mirror back to A. Critical: value-based equality
(`lastAppliedToB`) DOES NOT work during a focus animation — A's snap updates
every frame, so by the time B's echo-draw fires `subB`, `lastAppliedToB` has
already been overwritten by A's newer frame, the equality fails, and the echo
back to A interrupts A's in-flight animation. The pending-flag pattern is
value-independent and survives multi-frame animations.

**Skip-mirror-from-empty-viewer**. The mirror also returns early when
`src.managers.structure.hierarchy.current.structures.length === 0`. An
empty viewer has a meaningless default camera (tiny radiusMax, origin
target); mirroring it onto a viewer that DOES have a structure freezes
the destination at a useless zoom level. Common scenario it fixes:
user opens a structure on A while B is still empty — B's idle didDraw
events would otherwise push B's default state onto A.

### Camera ownership: `manualReset: true`

`MolstarViewer` post-init calls `PluginCommands.Canvas3D.SetSettings(plugin,
{ settings: { camera: { manualReset: true } } })`. This tells Mol*'s
`canvas3d.commitScene` to NEVER call `resolveCameraReset` on its own.
Without it, every state-tree update that grows the visible bounding sphere
(adding sticks, glycam representations, etc.) would queue an
auto-reset, which fires on the NEXT draw and overwrites any in-flight
`camera.focusSphere` animation — the user sees "camera tries to jump and
snap back".

Trade-off: with `manualReset: true`, Mol*'s built-in "fit camera to scene
on first structure load" is also suppressed. We compensate in
`MolstarViewer` post-load:
- `autoOrientOnLoad === true`  → `PluginCommands.Camera.OrientAxes(plugin)`
- `autoOrientOnLoad === false` → `plugin.managers.camera.reset(undefined, 0)`

Both branches suppress camera sync during the fit so the other viewer
doesn't mirror the fit motion.

### Structure Library (with hierarchy + starring)

`structures/` folder at project root is the local database. `vite.config.ts`
has a custom Vite plugin (`serve-structures`) that recursively scans
subfolders, **skips `.*` and `_*` directories**, and merges `index.json`
entries with auto-detected files. It also **auto-prunes** stale `index.json`
entries whose file no longer exists on disk and **strips orphan `parent`
references** — but only when the parent file is genuinely missing from
the filesystem (checked against `onDisk`, NOT against the subset of files
that happen to live in `index.json`). This matters when a user drops a
PDB into `structures/` without curating `index.json` and then runs
DVBFixer on it: the input is auto-detected, the DVBFixer output entry's
`parent` points at that auto-detected file, and the orphan-pruner must
NOT strip the link.

Auto-detected entries preserve the filename's actual case
(`mystructure.pdb` → `"mystructure"`, not `"MYSTRUCTURE"`). The same
rule applies to the `PUT /api/library/meta` and `POST /api/library/star`
auto-promote fallbacks server-side.

Entries in `structures/index.json` are a discriminated union:
- `kind: 'structure'` (default — missing `kind` implies structure) — has
  `file`, `name`, optional `parent` (lineage), `command`, `starred`, etc.
- `kind: 'folder'` — has `id` (`fld_*` or the synthetic `__root__`),
  `name`, `children: string[]` (ordered list of entry ids — folder ids
  OR structure file paths).

**Two nesting dimensions** in the Library tree:
1. **Folder containment** (user-controlled, drag-droppable). Each folder's
   `children` array is the authoritative ordering of *top-level* entries
   inside that folder. A synthetic `__root__` folder always exists; its
   `children` is the library's top-level layout.
2. **Lineage** (automatic, read-only by default). A structure with
   `parent: 'X.pdb'` is rendered nested under X.pdb. Lineage children
   CAN also be moved into folders by the user — when they are, the
   frontend computes `placedInFolder` (union of every `folder.children`)
   and suppresses default lineage rendering for any structure that's
   explicitly placed, so it shows ONLY in the folder it was moved to.
   `parent` is preserved as informative metadata regardless. DVBFixer
   / Antibody Engineer pipelines keep writing `parent` as before.

**Drag-drop** uses `@dnd-kit/core` + `@dnd-kit/sortable`. Every row
(folders, top-level structures, AND lineage children rendered under
their parent) is a `useSortable` item; each carries `data: { type:
'folder' | 'structure' }`. Drop semantics handled in `handleDragEnd`:
- Drop a STRUCTURE on a FOLDER → move INTO that folder (append).
- Drop on any sibling entry → insert BEFORE that sibling in its
  container. Lets you reorder folders alongside each other and
  structures within a folder.
- Cycle prevention: refuse to move a folder inside itself or any
  descendant.
Every drop fires `PATCH /api/library/move` then `bumpLibraryVersion()`.

**Active-viewer chip (A / B) bubbles up to lineage roots**. The chip
appears on the row whose `file` matches `fileName` AND on the lineage
root that contains that file in its lineage tree. So when the user
clicks a root with a starred descendant, the load redirects to the
descendant but BOTH the root and the descendant show the active-viewer
chip — the user sees a marker on the row they clicked. Walk is gated to
lineage roots only (`!structure.parent`); intermediate lineage entries
don't pick up the chip.

**Backend folder routes** (in `server/api-plugin.ts`):
- `POST /api/library/folder { name, parentFolderId? }` → creates folder,
  appends to parent's `children` (or `__root__` if omitted).
- `PATCH /api/library/folder/:id { name }` → rename.
- `DELETE /api/library/folder/:id` → remove folder; promote its
  `children` up into the parent at the folder's current position.
- `PATCH /api/library/move { entryId, toFolderId?, beforeId? }` →
  relocate / reorder. `toFolderId` defaults to `__root__`; omitting
  `beforeId` appends to end. Refuses to move a folder into itself or a
  descendant (cycle prevention).

**Scanner migration** (`vite.config.ts:scanStructuresDir`):
- Folder entries (no on-disk file) survive the `onDisk` prune.
- The synthetic `__root__` folder is auto-created on first scan if
  missing.
- Any entry not currently placed in any folder's `children` array gets
  appended to `__root__.children` (preserves legacy layouts on first
  run, auto-adopts newly-dropped on-disk files).
- Stale entry ids in `folder.children` are stripped (entry deleted or
  file removed from disk).

**Everything starts collapsed by default** except `__root__` itself
(implicit). Folders use `FolderIcon` (closed) / `FolderOpenIcon`
(expanded), tinted amber. Inline-rename on double-click on a folder
name. Delete-folder icon button on the right; promotes children up.

The `StructureLibrary` component renders the result as an expandable
tree. Users explicitly open folders / lineage parents via the chevron.

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
- `showSurroundingsAndFocus(plugin, residues, radius=5)` / `clearSurroundings(plugin)` — tag `tarantino-focus-surr`. Builds `MS.struct.modifier.includeSurroundings({ target: residues, radius, as-whole-residues })`, renders the combined region as sticks, AND calls `camera.focusSphere` ONCE. Order: camera FIRST, then fire-and-forget sticks (so the state-tree commit can't pre-empt the camera request). Used by the Sequence panel's Zoom button and the Alignment panel's Focus button. The deterministic single camera move (combined with `manualReset: true` on the canvas3d) prevents the "tries to jump, snaps back" bug previously caused by `focus.setFromLoci` triggering its own auto-pan.
- `buildResiduesLoci(plugin, residues)` — synchronously build a Loci from a residue list without any state-tree mutation. Use when you need the loci immediately (e.g. for `camera.focusLoci`) without round-tripping through `selection.getLoci` (which is async-lagged behind the most recent `lociSelects.select`).

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
and walking its `seqId.value(i)` / `compId.value(i)` columns. Each residue gets:
- `seqId: number` — the canonical `label_seq_id` (1-based sequential per entity).
  Used by every MolScript / selection / 3D-sync path in the codebase.
- `authSeqId?: number | null` — the PDB author residue number (`auth_seq_id`,
  what the structure file literally says, e.g. 250, 251, 252...). Null for
  SEQRES-only residues (no ATOM coordinates → no authored number available).
  Displayed in the Sequence panel's "Structure" numbering mode.
- `present: boolean` — `true` if the residue has coordinates, `false` if SEQRES-only.

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
or hovered. Tooltip reads `"<RES> PDB <auth> · #<order> (<class>) — declared in SEQRES, missing from structure"`.

**Numbering toggle.** A two-button `ToggleButtonGroup` in the toolbar (per-panel
state, default **Structure**) swaps between:
- **Structure** — show `authSeqId` (PDB author residue number, e.g. 250 …
  with insertion gaps preserved). Falls back to `seqId` for SEQRES-only residues.
- **Sequence** — show the 1-based ordinal position within the visible chain
  (1, 2, 3 …). Counts every residue including SEQRES-missing ones so the
  gutter aligns with rendered cells.
Tooltip always shows BOTH numbers (`PDB 322 · #205`) so users can cross-reference
without flipping the toggle. Selection / 3D sync continue to use the canonical
`seqId` (`label_seq_id`) regardless of toggle state.

### Info Panel + Equivalent Chains (`src/components/StructureInfo.tsx`, `src/lib/chain-grouping.ts`)

`StructureInfo.tsx` layout (top → bottom):

1. **Summary** — 4 stat cards (Chains / Residues / Atoms / Elements).
   The Chains and Residues counts are computed against
   `filterSequenceableChains(chains)` so glycan / water / ion-only chains
   don't inflate the numbers.
2. **File** — file path in a monospace `Paper` with
   `wordBreak: 'break-all'` so long DVBFixer output paths
   (`dvb_<cmd>_<ts>/<input>_<cmd>.pdb`) wrap instead of overflowing.
3. **Metadata** — three fields: `Name` (free text), **IgG Subtype**
   (singleSelect: `'' | IgG1 | IgG2 | IgG3 | IgG4 | IgA | IgM | IgE | IgD`),
   **Allotype** (free text, e.g. `G1m17,1` / `nG1m1`). The legacy fields
   (Organism / Method / Resolution) are still in `StructureMeta` +
   `index.json` for backwards compat, but their inputs are hidden.
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

  It also resolves `allotype` and `iggSubtype` through
  `inheritFromLineage(entries, entry, field)` — a small helper that
  returns the entry's own value when set, otherwise walks the `parent`
  chain (cycle-safe) until it finds the first non-empty value. This
  read-time fallback complements the write-time inheritance in
  `server/antibody-pipeline.ts` + the DVBFixer route: even older
  entries (created before the inherit-at-write rule landed) and entries
  produced by future tools that forget to propagate will still display
  the right identity tags in the Info panel, as long as some ancestor
  has them set.

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

### Clashes Panel (`src/components/ClashesPanel.tsx`, `src/lib/clash-detection.ts`)

Steric-clash detection. `computeClashes()` walks every atom pair within
`2 · maxVdW − minOverlap` Å via `structure.lookup3d.find`, computes VdW
overlap `(rA + rB) − distance` against a Bondi/Rowland-Taylor radius
table, and reports pairs above the threshold. Excludes: H/D, water,
1-2 and 1-3 neighbors across the **full** bond graph (`unit.bonds` PLUS
`structure.interUnitBonds`), and same-residue pairs (rotamer/ring
topology produces false-positives). The `gatherNeighbors(structure,
unit, atomIdx)` helper walks both intra and inter edges so that
glycosidic bonds between sugar non-polymer units (C1–O 1-2 and C1–C2
1-3 around the linkage angle would otherwise show as severe clashes)
and inter-chain disulfides are correctly excluded. Two tiers: `bad`
(0.4–0.9 Å), `severe` (>0.9 Å) — matches PyMOL / ChimeraX / MolProbity
convention.

Panel UI:
- Header: bad/severe count chips, severity filter (All / Bad / Severe),
  **Group** toggle (default OFF), min-overlap numeric input,
  Clear-highlight / Recompute icon buttons.
- **Flat mode** (default): one row per atom-pair clash, sorted worst-first.
- **Grouped mode**: rows collapsed by canonical `(chain,resId)` pair.
  Each group row shows worst severity (`bad × 3` when N > 1), worst
  overlap, residue endpoints, and atom count. Chevron expands the
  group into indented child rows for the per-atom-pair detail.
  Clicking a group row focuses the WORST atom-pair in the group;
  the group stays selected whenever any of its children is the active
  clash.

Row click → `showClashAndFocus(plugin, { a, b, severity })` in
`molstar-helpers.ts`:
- Renders both residues as sticks via `showSticksForLoci` under tag
  `CLASH_TAG = 'tarantino-clash'`.
- Calls `showClashLine(plugin, a, b, severity)` which uses
  `plugin.managers.structure.measurement.addDistance(lociA, lociB, …)`
  to draw a **dashed line + distance label** between the two specific
  clashing atoms — **amber** for `bad` (`0xe68a00`), **red** for
  `severe` (`0xc62828`). The returned `selection` + `representation`
  cell refs are tracked in a per-plugin `WeakMap<PluginUIContext,
  string[]>` so subsequent clicks (or `clearClashSticks`) delete them
  precisely without touching any other measurements the user might
  add through Mol*'s own UI.
- Camera focuses the residue-pair bounding sphere.

Atom-level loci is built by a new synchronous helper `buildAtomLoci`
(MolScript with `chain-test` + `residue-test` + `atom-test` on
`label_asym_id` / `label_seq_id` / `label_atom_id`), mirroring the
existing `buildResiduesLoci` pattern.

`clearClashSticks` deletes both the residue-stick cells (by
`CLASH_TAG`) and the tracked dashed-line cells. Wired into
`useMolstarSync.clearPlugin3DState` (empty-3D-click) and `App.tsx` Esc
handler.

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

**Model tab — per-chain FASTA input.** The `model` sub-tab renders a
custom section above the flag controls: one multi-line `TextField` per
polypeptide chain of the loaded primary structure (filtered via
`filterSequenceableChains`). A **Parse from PDB** button populates every
box via `chainToSequence(chain.residues)` from
`src/lib/alignment.ts` (SEQRES-aware — residues missing from ATOM coords
are still included). A **Clear** button empties all boxes. The standard
`--fasta` text field is hidden in this tab because the per-chain UI
synthesises it automatically.

On Run, `buildFastaContent()` assembles a valid FASTA string from the
non-empty chain boxes (60-char-wrapped lines, `>{inputBase}_{chainId}`
headers) and ships it as `fastaContent` in the request body. The
backend (`/api/dvbfixer/:command` route in `server/api-plugin.ts`)
writes the content to `<outDir>/<inputBase>.fasta` and injects
`--fasta <abspath>` into the CLI args — overriding any user-typed
`--fasta` value. The materialised FASTA stays beside the output PDB so
the user can inspect / reuse it.

The per-chain UI is only ENABLED when the picker's input matches the
primary viewer's `fileName` (we need the chain list). Otherwise an
Alert tells the user to load the structure first; they can still leave
the boxes empty and let DVBFixer fall back to SEQRES from the input
PDB.

**Backend** (`server/api-plugin.ts`, a Vite middleware plugin):
- `GET /api/dvbfixer-spec` — returns `COMMANDS` from `server/dvbfixer-spec.ts`.
- `POST /api/dvbfixer/:command` — body `{ inputFile, values, fastaContent? }`.
  Spawns the CLI (env `DVBFIXER_CMD`, default `'dvbfixer'`; can be a multi-token
  command like `'micromamba run -n tarantino dvbfixer'` — split on whitespace).
  Output: `structures/dvb_<command>_<timestamp>/<input>_<command>.pdb`. When
  `fastaContent` is non-empty (used by the model tab), it's written to
  `<outDir>/<inputBase>.fasta` and `--fasta <abspath>` is injected into the
  args (overriding any user-typed `--fasta` value).
  - **Success**: entry appended to `structures/index.json` with `parent`
    pointing to the input file → library renders parent → child. The
    new entry also inherits `allotype` and `iggSubtype` from the input
    entry when those tags are set (write-time propagation).
  - **Failure** (non-zero exit): output folder moved to
    `structures/_dvb_failed/<subdir>` (underscore prefix → scanner skips it).
    Response includes `movedTo`.
- `GET / POST / PUT / DELETE /api/mutations[/:id]` — CRUD for the
  `mutations` table; auto-creates the table on first connection. Returns 503
  if `DATABASE_URL` is unset.
- `POST /api/antibody-engineer/run` — **SSE** endpoint. Body `{ inputFile,
  mutationIds: number[], equivalentChainsMap?, manualChainsByMutationId?, hasGlycan: boolean, scheme:
  'EU'|'Kabat' }`. Streams `data: <JSON>\n\n` events. See the dedicated
  Antibody Engineer architecture section above.
- `POST /api/library/star { file }` — toggles `starred` flag in `index.json` (one starred per family).
- `POST /api/library/folder { name, parentFolderId? }` — create a new folder
  (appended to parent's children, or `__root__` if omitted).
- `PATCH /api/library/folder/:id { name }` — rename folder.
- `DELETE /api/library/folder/:id` — delete folder; children migrate up to parent.
- `PATCH /api/library/move { entryId, toFolderId?, beforeId? }` — move / reorder
  any entry (folder OR structure) by file path or folder id.
- `PUT /api/library/meta { file, name?, organism?, method?, resolution?, description?, iggSubtype?, allotype?, equivalentChains? }` — persists
  per-entry metadata edits into `index.json`. Promotes auto-detected files to manual entries on
  demand. Only patches the whitelisted fields — other entry fields (`id`, `parent`, `starred`, etc.) are
  preserved. **`null` is treated as "delete this key"** so the Info panel's `Reset` button can
  remove a manual `equivalentChains` override and fall back to auto-detection.
- `GET /api/status` — `{ dvbfixer, databaseConfigured, databaseConnected }`.

**Spec format** (`server/dvbfixer-spec.ts`):
- `FlagDef.type`: `'bool' | 'number' | 'text' | 'select'`
- `FlagDef.repeatable: true` — comma-split UI input becomes `--flag v1 --flag v2 --flag v3` (used by `--mutate`).
- `FlagDef.multi: true` — value is whitespace-split and emitted as a single `--flag v1 v2 v3` (argparse `nargs='+'`). Works with both `type: 'text'` and `type: 'select'`; the latter lets a dropdown preset like `"amber19/protein.ff19SB.xml amber19/tip3p.xml"` resolve to the right multi-arg CLI form. Used by `--ff` (minimize + protonate).
- Empty string in any `select`'s `options` is preserved as the "default" choice and the backend (`api-plugin.ts:202`) drops empty values before arg-building, so DVBFixer's built-in defaults apply.

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
- `properties` — free-form notes / annotations (effect, source paper, etc.)

Inline cell editing via `processRowUpdate` → `PUT /api/mutations/:id`. If
the API returns 503 the panel renders a config hint pointing at
`DATABASE_URL`. Rows are zebra-striped via `getRowClassName` +
`rgba(74,118,196,0.04)` for odd rows so values stay easy to track across
wide rows; hover bumps to `0.10` alpha. The pagination footer is
compressed (`MuiDataGrid-footerContainer`, `MuiTablePagination-toolbar`
`minHeight: 26`) so it doesn't take half the panel.

**Layout**. Outer Box: `height: 100%`, `display: flex`,
`flexDirection: 'column'`, **`overflow: 'hidden'`**, **`minHeight: 0`**.
Header bar: `flexShrink: 0` so it never collapses (it's static — no
`position: sticky` because there's no scrollable ancestor; the grid
scrolls internally and the header stays as a flex sibling above it).
DataGrid wrapper: `flex: 1`, **`minHeight: 0`** so the flex:1 child
doesn't default to content height and push the panel beyond its
parent. The combo of these is what makes both header-stays-visible AND
grid-scroll-works.

**Drag-drop row reordering** (`@dnd-kit/core` + `@dnd-kit/sortable`):
`DndContext` + `SortableContext` wrap the DataGrid. `slots.row` is
overridden by `SortableRow`, which wraps Mol*'s exported `GridRow` with
`useSortable` (setNodeRef + attributes + listeners on the row). The
sensors include `PointerSensor` only — **NOT `KeyboardSensor`**,
because dnd-kit's `useSortable.listeners` would otherwise attach an
`onKeyDown` Space/Enter handler to the row that intercepts space-bar
presses inside editable cells (e.g. Properties) and calls
`preventDefault`, so the user's space never reaches the input.
Activation distance `8px` so single clicks pass through to cell-edit.
`disableColumnSorting` on DataGrid: column-header sorts would fight
the persisted drag order. `cursor: 'grab' / 'grabbing'` on rows.

`handleDragEnd` does an optimistic `arrayMove` locally, then PATCHes
`/api/mutations/reorder` with the full id list; rolls back via
`refresh()` on failure.

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
- Schema migrations for older deployments run on every boot:
  - `ADD COLUMN IF NOT EXISTS igg_subclass TEXT NOT NULL DEFAULT ''`
  - `ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0`
    + `UPDATE mutations SET display_order = id WHERE display_order = 0`
    (preserves existing visible order)
  - `ADD COLUMN IF NOT EXISTS properties TEXT NOT NULL DEFAULT ''`

Routes:
- `GET /api/mutations` — `ORDER BY display_order ASC, id ASC`
- `POST /api/mutations` — new row gets `display_order = MAX + 1` (lands
  at the bottom)
- `PUT /api/mutations/:id` — patches whitelisted fields including
  `properties`
- `DELETE /api/mutations/:id`
- `PATCH /api/mutations/reorder { ids: number[] }` — atomic
  `UPDATE … FROM (VALUES …)` that rewrites every row's `display_order`
  in one transaction. Called by the DataGrid drag-drop handler.

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
- `expandMutations(rows, equivChainsMap, manualMap?)` parses each row's
  comma-separated `mutations` field and emits one `--mutate` arg per
  (target chain, token). Target chain resolution **precedence**:
  `manualMap[row.id]` (if non-empty) → `equivChainsMap[row.chain]` →
  `[row.chain]` (legacy fallback). The manual override bypasses
  equivalent-chain fan-out and lets the AE panel handle rows whose DB
  `chain` field is empty (user picks chains manually in the UI). 1-letter
  → 3-letter codes via the local `AA1_TO_AA3` map. `del` is forwarded
  verbatim.
- `validateNoDuplicateTargets(args)` — server-side defensive check; the
  frontend already blocks this case.
- `pipelineSteps(scheme, hasGlycan, mutateArgs)` produces the 7-step
  glycan pipeline or 5-step no-glycan pipeline. Scheme passed to
  DVBFixer is **lowercased** (`'eu'` / `'kabat'`) — the CLI's
  `--scheme` choices are `seqres / kabat / chothia / imgt / martin / eu / aho`.
  Protonate steps pass `--protassign` so PROTASSIGN (MolProbity Reduce)
  picks HIS tautomers + ASN/GLN flips from local H-bond geometry; works
  out of the box because DVBFixer's bundled env ships the `reduce` binary.
  Every step AFTER `prepare` passes `--no-infer-conect` — `prepare` runs
  CONECT inference once and that bond graph is the canonical one for the
  rest of the pipeline. Re-inferring (the default since DVBFixer commit
  aa52dbf, June 2026) on protonate's output produced drift that broke
  AMBER14+GLYCAM template matching on glycosylated NLN/OLS/OLT residues
  in the second `minimize` step; pinning to prepare's CONECTs fixes it.
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
  `"FcRn — YTE + LALA"`. Both intermediate and final entries also
  **inherit antibody-identity tags** (`allotype`, `iggSubtype`) from
  the entry referenced by the entry's `parent` field — these don't
  change as a result of renumber / prepare / minimize / convert /
  protonate, so carrying them forward by default saves the user from
  re-entering them in the Info panel on every variant.
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
  structure). Live validation `useMemo` tags each issue with a
  `severity: 'error' | 'warning'`:
  - `'no-target-chain'` — for empty-chain rows, message is *"Row has
    no chain set — pick one or more chains manually."*; for normal
    rows it's *"No HC chains detected …"*. **Error**, blocks Run.
  - `'conflict'` (two checked rows both target the same `(chainId,
    position)`) → **error**, blocks Run.
  - `'out-of-range'` (target EU position not in this fragment per
    `mapEuToAuthSeqId`) → **warning**, NON-blocking. DVBFixer's recent
    versions silently skip missing residues, so we let the user
    proceed and only flag it with an amber chip + tooltip.
  Only `severity === 'error'` issues disable the Run button
  (`hasBlockingIssues`).

  **Per-row manual chain picker for empty-chain DB rows**. When
  `row.chain` is empty / unset, the row UI shows a compact MUI
  `Select multiple` next to the checkbox; options are every detected
  antibody chain id (`detections.map(d => d.chainId)`). Picks are
  stored in component state as `manualChainsByMutationId: Record<id,
  string[]>`. The per-row chain resolver:
  ```
  resolveTargetChains(row):
    if manualChainsByMutationId[row.id]?.length > 0 → those chains
    else                                            → equivalentChainsMap[row.chain]
  ```
  Manual picks **bypass equivalent-chains fan-out** — the mutation
  goes only to the chains the user selected. Both `validationIssues`
  and `previewMutateArgs` go through `resolveTargetChains`. Submit
  body carries `manualChainsByMutationId` (filtered to checked rows
  with non-empty picks). Backend uses it via `expandMutations`'s
  `manualMap` arg (see pipeline orchestrator above).

  Below the list a row of chips shows the resolved chain expansion:
  one outlined chip per equivalent-chain bucket that's actually used
  by a non-overridden checked row, PLUS one warning-colored chip per
  manual-override row showing `mutation_name: <picked chains>`. The
  `previewMutateArgs` tooltip lists the literal `--mutate H:322:ALA …`
  strings.
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

### Settings (`src/components/SettingsPanel.tsx`)

App-wide preferences live in the structure store and are persisted in
`localStorage`. Two preferences today:

- **Viewer → Auto-orient on load** (`autoOrientOnLoad`, default **OFF**,
  key `tarantino.autoOrientOnLoad`). When ON, every loaded structure
  goes through `PluginCommands.Camera.OrientAxes` in `MolstarViewer`
  post-load (camera sync suppressed for the duration of the orient).
  When OFF, the structure keeps its authored orientation but is still
  fit to the viewport via `camera.reset(undefined, 0)` (necessary
  because `manualReset: true` suppresses Mol*'s built-in auto-fit).
- **Alignment → Source label** (`alignmentLabelMode`, default
  `'file'`, key `tarantino.alignmentLabelMode`). Toggles what the
  AlignmentPanel's source-labels block (above the alignment view)
  shows for each side: the **file** path (default — e.g.
  `FcRn.pdb`) or the entry's metadata **name** (the user-editable
  `name` field from the Info panel). When `'name'` and a non-empty
  name exists, falls back to the file path; otherwise displays the
  file path.

The panel renders one MUI control per preference (`Switch` for booleans,
`ToggleButtonGroup` for enums). Setters write through to `localStorage`
immediately via the matching `persistX` / `loadPersistedX` helpers at
the top of `structureStore.ts`.

`AlignmentPanel` fetches `/structures/index.json` on mount and on every
`libraryVersion` bump, builds a `Map<file, name>`, and exposes
`labelFor(filePath)` to render the right value per the mode. This
works for both primary (A) and secondary (B) viewer structures.

Discoverable in the default layout's left column (paired with Info) as
of the latest layout update; also accessible via the `+` menu.

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
    MolstarViewer.tsx           # Mol* init per slot, color theme registration, post-load (hide water, ions→spacefill, OrientAxes gated on autoOrientOnLoad). Cleanup on tab close: dispose plugin AND clear store's fileName/secondaryFileName + chains for that slot so the Library's A/B chip disappears.
    SequenceViewer.tsx          # Monospace residue grid, drag-select, missing-SEQRES gap rendering, validated chain init, Structure/Sequence numbering toggle
    StructureLibrary.tsx        # Tree of folders + structures, drag-drop reorder + cross-folder move (@dnd-kit), starring, A/B slot toggle, descendant-starred hint chip
    StructureInfo.tsx           # Stats summary at top, metadata (Name + IgG Subtype + Allotype) + Notes, EquivalentChainsSection (auto-detect via NW + trimmed identity, manual override persisted in index.json)
    ElementsTable.tsx           # Tree, visibility toggles, row-click camera focus (sync-suppressed), "Show Interface"
    InteractionsPanel.tsx       # Computed contacts, focused-chain banner
    ClashesPanel.tsx            # VdW-overlap clash table: severity filter, Group-by-residue toggle (expandable groups), row-click → residue sticks + severity-colored dashed clash line via measurement.addDistance
    AlignmentPanel.tsx          # Pairwise NW alignment, per-source plugin routing
    DVBFixerPanel.tsx           # MUI Tabs, form from /api/dvbfixer-spec, auto-pastes active fileName, auto-loads output on success
    MutationsPanel.tsx          # DataGrid backed by /api/mutations: multi-select IgG Subclass chips, HC/LC chain dropdown, free-form Properties column, drag-drop row reorder via @dnd-kit (SortableRow slot.row override, PointerSensor only, atomic PATCH /api/mutations/reorder), zebra rows, compressed pagination footer
    AntibodyEngineerPanel.tsx   # End-to-end mutate-by-DB-row tool: chain detection, severity-tagged validation (out-of-range = warning, non-blocking), SSE-driven progress, auto-load output
    SettingsPanel.tsx           # App-wide preferences (auto-orient-on-load, Alignment source-label mode); all localStorage-persisted
    FileLoader.tsx              # Upload button (honors loadTargetSlot)
    ChainSelector.tsx           # Chain dropdown (same filter+sort as SequenceViewer)

  hooks/
    useMolstarSync.ts           # 3D → sequence + empty-click cleanup on both viewers
    useSequenceSync.ts          # Sequence → 3D (cartoon halo + solid sticks)
    useCameraSync.ts            # Bidirectional camera mirror via canvas3d.didDraw

  stores/
    structureStore.ts           # plugin, secondaryPlugin, loadTargetSlot, chains+secondaryChains (each residue has seqId + optional authSeqId), elements, meta (incl. iggSubtype + allotype + optional equivalentChains override), focusedChainId+Category, cameraSyncEnabled, autoOrientOnLoad + alignmentLabelMode (both localStorage-persisted), clearAllSignal
    selectionStore.ts           # selected/hovered residues, _lock mechanism

  lib/
    molstar-helpers.ts          # MolScript builders, showSticksForLoci, extractChains (label_seq_id as seqId + auth_seq_id as authSeqId + SEQRES merge + present flag), buildAtomLoci + showClashLine (severity-colored dashed line via measurement.addDistance, per-plugin ref tracking)
    clash-detection.ts          # computeClashes: VdW-overlap pairs via structure.lookup3d.find + Bondi/R&T radii; gatherNeighbors walks both unit.bonds + structure.interUnitBonds so 1-2 / 1-3 exclusions cover glycosidic + interchain disulfide bonds; severity tiers bad (0.4–0.9 Å) / severe (>0.9 Å)
    alignment.ts                # Needleman-Wunsch + BLOSUM62 + chainToSequence + trimmedIdentity (terminal-gap-aware)
    chain-grouping.ts           # computeEquivalentChains (pairwise NW + union-find), validateGrouping, filterSequenceableChains
    antibody-references.ts      # Hardcoded UniProt CH/CL sequences (IgG1-4, κ, λ) + EU domain anchors + landmark self-check
    antibody-numbering.ts       # identifyAntibodyChain (NW vs refs → HC/LC + subclass + region), mapEuToAuthSeqId, parseMutation, mutateArgFor
    residue-codes.ts            # 3-to-1 letter code (incl. non-canonical)
    residue-color-theme.ts      # Mol* ColorTheme: carbons by residue class, others CPK

server/
  api-plugin.ts                 # Vite middleware: /api/dvbfixer/*, /api/mutations, /api/library/{star,meta,folder,move}, /api/antibody-engineer/run (SSE), /api/status. Exports runDvbfixer + getPg + writeSSEHeaders + sseSend for reuse.
  antibody-pipeline.ts          # Multi-step DVBFixer orchestrator: expandMutations, validateNoDuplicateTargets, pipelineSteps (glycan-7 vs no-glycan-5), engineerChecksum dedup, runEngineerPipeline (intermediate + final index.json entries, _engineer_failed/ rollback)
  dvbfixer-spec.ts              # CommandDef[] for split/renumber/model/prepare/minimize/protonate/convert (was `glycam` in older DVBFixer). renumber.--scheme options: seqres/kabat/chothia/imgt/martin/eu/aho. convert exposes --to-amber + --to-charmm + --no-roh. minimize + protonate `--ff` is a select-multi dropdown of OpenMM bundles (AMBER19/AMBER14/GLYCAM/CHARMM36 presets, empty = DVBFixer auto-pick). prepare exposes --no-infer-conect; protonate exposes --protassign (default ON). Removed from UI: model --keep-workdir, minimize --dat/--padding/--platform, protonate --cys-disulfide-pka (still valid on the CLI, just hidden from the panel).

scripts/
  dev.mjs                       # Smart launcher: auto docker postgres → vite
  fix-native-deps.mjs           # postinstall
  set-modeller-key.sh           # Writes Modeller license into config.py

structures/                     # Manifest (index.json with parent/starred/equivalentChains/mutationIds/_engineerChecksum), pdb files, dvb_<cmd>_<ts>/ outputs, _dvb_failed/ for single-command failures, _engineer_failed/ for Antibody Engineer pipeline failures
mutations.json                  # Git-tracked backup of the postgres `mutations` table. Auto-written after every CRUD, auto-seeded on empty table.
docker-compose.yml              # postgres:16-alpine, service `db`
vite.config.ts                  # apiPlugin + serve-structures (recursive scan, prune stale, strip orphan parents only when parent file is genuinely off-disk, preserve filename case, synthesise __root__ folder, auto-adopt new files into __root__.children, prune stale folder-children refs, skip `.*`/`_*`)
```
