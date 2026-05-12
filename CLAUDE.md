# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies (runs postinstall script for rollup native bindings)
npm run dev        # Start Vite dev server with HMR
npm run build      # Type-check (tsc -b) then build static dist/ (includes structures/)
npm run typecheck  # Type-check only
npm run lint       # ESLint
npm run preview    # Serve the built dist/ locally
```

No tests are configured yet.

## What This Is

Tarantino is a fully local browser-based protein structure viewer. It loads PDB/mmCIF files client-side (no backend) and provides a dockable multi-panel workspace:

- **3D Structure**: Mol* molecular visualization with custom residue-type color theme
- **Sequence**: amino acid sequence with color-coded residue types, drag-to-select, per-panel chain selection
- **Elements**: tree view of structure components (polymers, ligands, ions, water) with visibility toggles + per-chain **Show Interface** action
- **Interactions**: computed table of H-bonds, ionic, cation-pi, pi-stacking, halogen, hydrophobic, metal coordination, disulfide, and covalent bonds with chain pair filter
- **Library**: clickable list of pre-loaded structures from `structures/` folder
- **Info**: editable metadata and structure summary stats

Selecting or hovering residues in the 3D view highlights them in the sequence view and vice versa (bidirectional sync).

## Tech Stack

- **React 19** with **TypeScript 6**, bundled by **Vite 6**
- **MUI (Material UI v9)** for all UI components -- no Tailwind, no shadcn
- **flexlayout-react** for the dockable/movable panel system
- **Mol\*** (`molstar` npm package, used directly -- not a wrapper like `pdbe-molstar`)
- **Zustand** for state management
- **Sass** for Mol* SCSS skin compilation

## Architecture

### Panel System

The app uses `flexlayout-react` with a `Layout` + `Model` in `App.tsx`. The layout JSON defines the default arrangement: Library and Info on the left; 3D Structure, Sequence, Elements, and Interactions on the right. Every tabset has a "+" button (`onRenderTabSet`) that opens a MUI Menu to duplicate any panel type into that tabset. Each Sequence panel maintains its own independent chain selection via local state.

### Data Flow

```
StructureLibrary ─┐
FileLoader ───────┤→ Mol* plugin → extractChains/extractElements/extractMeta
                  │       ↓                    ↓
                  │  structureStore ──→ SequenceViewer, ElementsTable, InteractionsPanel
                  │       ↕                    ↑
                  │  selectionStore         focusedChainId/Category
                  │       ↕                    │
                  └── MolstarViewer ← molstar-helpers (queries, custom-tagged repr nodes)
```

### Structure Library

`structures/` folder at project root is the local database. Contains PDB/mmCIF files and an `index.json` manifest. During dev, a custom Vite plugin (`serve-structures` in `vite.config.ts`) scans the folder and merges `index.json` entries with auto-detected files not in the manifest. On build, everything is copied to `dist/structures/` with a merged index.

### Mol* Integration

Mol* is initialized via `createPluginUI` with `renderReact18` in `MolstarViewer.tsx`. The `PluginUIContext` instance is stored in `structureStore` and shared across the app. Key Mol* API patterns used:

- **Loading files**: `plugin.builders.data.rawData()` → `parseTrajectory()` → `hierarchy.applyPreset()`
- **Querying residues**: `MolScriptBuilder` to build queries, `compile()` + `QueryContext` to execute, `StructureSelection.toLociWithSourceUnits()` to get Loci
- **Selection**: `plugin.managers.interactivity.lociSelects.select/deselectAll()`
- **Highlighting**: `plugin.managers.interactivity.lociHighlights.highlight/clearHighlights()`
- **Reading selection**: `plugin.managers.structure.selection.entries` (Map of `SelectionEntry` with `.selection` loci)
- **Iterating atoms**: `OrderedSet.getAt()` / `OrderedSet.size()` (not array indexing -- Mol* uses custom ordered sets)
- **Reading properties**: `StructureProperties.chain.label_asym_id(location)`, `.residue.label_seq_id(location)`, etc. -- all take a `StructureElement.Location`
- **Custom-tagged representations** (NOT `focus.setFromLoci`): for "Show Interface" and Sequence-selection sticks, build state-tree nodes via `StateTransforms.Model.StructureSelectionFromBundle` + `StateTransforms.Representation.StructureRepresentation3D` with explicit tags. See `showSticksForLoci()` in `molstar-helpers.ts`.
- **Visibility**: `setSubtreeVisibility()` from `molstar/lib/mol-plugin/behavior/static/state`
- **Interactions computation**: `computeInteractions()` from `molstar/lib/mol-model-props/computed/interactions`
- **Camera**: `plugin.managers.camera.focusSphere(Loci.getBoundingSphere(loci))`

#### Why we avoid `focus.setFromLoci()` for our custom features

Mol*'s `StructureFocusRepresentation` plugin behavior has two issues that make it unusable for arbitrary loci:

1. **`focus.clear()` guard** — `focus.js` guards with `if (this.state.current)` and short-circuits if `state.current` is undefined. When `setFromLoci(loci)` is given a `combinator.merge` loci that fails Mol*'s `Loci.normalize`, `state.current` is never set, but the state-tree nodes still render. Subsequent `focus.clear()` calls become no-ops → green halo persists. The workaround is to push `undefined` directly onto `plugin.managers.structure.focus.behaviors.current` (used in `useMolstarSync` click handler and `useSequenceSync`).
2. **`ensureShape` always creates surroundings** — the behavior unconditionally constructs a `SurrSel` sub-tree with `expandRadius` (default 5 Å, min 1 — `expandRadius: 0` is silently clamped). For "Show Interface" this rendered sticks for the whole chain interior since it's all within 5 Å of the surface.

Our solution: bypass the focus manager. Build our own ball-and-stick representation state nodes tagged `tarantino-interface` or `tarantino-selection`, and delete by tag in `clearInterfaceFocus` / `clearSelectionSticks`.

### Custom Tagged Representations (Show Interface + Selection Sticks)

`src/lib/molstar-helpers.ts` exports:
- `showSticksForLoci(plugin, loci, tag, label)` — shared builder. Adds `StructureSelectionFromBundle` + `StructureRepresentation3D` (ball-and-stick, **`xrayShaded: false`** for solid, not translucent) tagged with the given tag. Replaces any prior nodes carrying that tag.
- `deleteCellsByTag(plugin, tag)` — selects via `StateSelection.Generators.root.subtree().withTag(tag)` and deletes.
- `focusInterfaceForChain(plugin, chainId, category, radius=5)` — uses the contact MolScript (chain X residues within 5 Å of any non-self atom, ∪ partner-side residues within 5 Å of chain X), passes to `showSticksForLoci` with tag `tarantino-interface`, then `camera.focusSphere`.
- `showSelectionSticks(plugin, residues)` / `clearSelectionSticks(plugin)` — same pattern, tag `tarantino-selection`. Called by `useSequenceSync` whenever sequence-selected residues change.

**Entity-type-aware self detection.** `focusInterfaceForChain` takes a `category` argument (`polymer | ligand | ion | water | branched | other`). `entityTypeTest(category)` maps to MolScript `entity.type` test. The "self" MolScript test becomes `(label_asym_id == X) AND (entity.type == matchType)` so a polymer chain "A" and a ligand with chain id "A" are treated as distinct selves and as each other's partners. Without this, same-chain-id ligands would be hidden from the partner set.

### Custom Color Theme

`src/lib/residue-color-theme.ts` registers a Mol* `ColorTheme.Provider` named `tarantino-residue-type`. Carbons are colored by residue type (hydrophobic=green, positive=blue, negative=red, polar=orange, cysteine=yellow, aromatic=teal, special=pink). Non-carbon atoms use CPK element colors. Applied to:
- The default focus representation (via `MolstarViewer` subscription on `plugin.managers.structure.focus.behaviors.current` that updates target/surroundings repr nodes by tag)
- Our custom-tagged sticks (`showSticksForLoci` passes `color: 'tarantino-residue-type'` to `createStructureRepresentationParams`)

### Custom Mol* SCSS Skin

`src/molstar-theme.scss` overrides `molstar/lib/mol-plugin-ui/skin/base/_colors.scss` variables via `@use ... with (...)` to match the cool gray-blue app palette. This replaces the default light/dark Mol* themes entirely.

### Non-Canonical Amino Acid Handling

`src/lib/residue-codes.ts` contains an extensive `THREE_TO_ONE` mapping table that normalizes non-canonical amino acid codes (e.g., CYX/CYM/CSO -> C, HID/HIE/HIP -> H, SEP -> S, MSE -> M, etc.) to standard one-letter codes. `toCanonicalThree()` maps back to standard three-letter codes for display in the Interactions panel.

### Post-Load Behavior

When a structure loads, `MolstarViewer` subscribes to hierarchy changes and:
1. Extracts chain/element/meta data into `structureStore`
2. Hides water components by default (via `toggleVisibility`)
3. Resets the post-load flag when structures are cleared

### Sync Hooks

- `useMolstarSync` (structure → sequence):
  - Registers a `LociMarkProvider` via `addProvider`/`removeProvider` on `lociSelects`. The provider is **wrapped in try/catch** and has **no re-entrant side-effects** (no `focus.clear` from inside it), so a throw in our provider never breaks the next provider in the chain (which is the default canvas3d marker provider that paints the green halo).
  - Subscribes to `plugin.behaviors.interaction.hover` (debounced 50 ms).
  - Subscribes to `plugin.behaviors.interaction.click`. On empty click (`Loci.isEmpty`): `lociSelects.deselectAll()`, `clearHighlights()`, push `undefined` to `focus.behaviors.current`, `focus.clear()`, `clearInterfaceFocus`, `clearSelectionSticks`, `setFocusedChain(null)`. This is the only reliable place to dismiss the green halo — see "Why we avoid `focus.setFromLoci`" above.

- `useSequenceSync` (sequence → structure): subscribes to `selectionStore` changes. When `_lock === 'sequence'`, async:
  1. `clearSelection(plugin)` — `lociSelects.deselectAll`
  2. Push `undefined` to `focus.behaviors.current` + `focus.clear()`
  3. `await clearInterfaceFocus(plugin)` — must complete before painting new selection or translucent leftover sticks would overlap
  4. `setFocusedChain(null)`
  5. If non-empty: `selectResiduesInViewer` (cartoon halo) + `await showSelectionSticks(plugin, residues)` (solid ball-and-stick)
  6. If empty: `clearSelectionSticks`

Hover sync is debounced at 50 ms. The `selectionStore._lock` field (expires after 200 ms) prevents infinite update loops between the two sync directions.

### Interactions Panel

`InteractionsPanel.tsx` uses Mol*'s `computeInteractions()` to find non-covalent contacts (H-bonds, ionic, cation-pi, pi-stacking, halogen, hydrophobic, metal coordination). It also scans `structure.interUnitBonds` and intra-unit bonds for disulfide bridges and inter-chain covalent bonds. Results are deduplicated and displayed in a filterable table with chain pair dropdowns. Water interactions are excluded. Clicking a row focuses/zooms the 3D view to those residues.

When `structureStore.focusedChainId` is set (via Elements panel "Show Interface" button), the table auto-filters to rows involving that chain, and a banner shows per-partner contact counts: `Interface: polymer chain A · 24 contacts · ↔ B (12) ↔ C (3) ↔ D (9) · [Clear]`. The banner label includes `focusedCategory` so polymer/ligand/etc. ambiguity is visible.

### Empty 3D Click Behavior

Default Mol* `clickDeselectAllOnEmpty` requires `selectionMode === true` (false by default), so Mol* does NOT auto-clear `lociSelects` on empty click. We handle this manually via `plugin.behaviors.interaction.click.subscribe` in `useMolstarSync`. The check is `Loci.isEmpty(event.current.loci)` — NOT `isEmptyLoci(loci)` — because Mol* fires a `StructureElement.Loci` with empty `elements` array (not the `EmptyLoci` singleton).

The sequence panel's stored selection (`selectionStore.selectedResidues`) is NOT cleared on empty 3D click — sequence highlights remain in place. Empty 3D click clears only the 3D-side state.

## Key Constraints

- **Mol* imports use deep paths** like `molstar/lib/mol-model/structure` -- there is no barrel export. Check `node_modules/molstar/lib/` for available modules.
- **MUI v9**: all UI uses `@mui/material` and `@mui/icons-material`. No Tailwind CSS, no shadcn/ui.
- **flexlayout-react**: panel layout, docking, and tab management. Light theme CSS imported from `flexlayout-react/style/light.css`, customized with CSS variables in `src/index.css`.
- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly` are all enabled.
- **`@` alias**: resolves to `src/` (configured in `vite.config.ts`).
- **structures/ folder**: local structure database. Add PDB/mmCIF files; they are auto-detected. Optionally update `structures/index.json` for richer metadata.
- **postinstall script**: `scripts/fix-native-deps.mjs` installs the correct platform-specific `@rollup/rollup-*` native binding (macOS arm64/x64, Linux arm64/x64).

## File Map

```
src/
  App.tsx                      # Root: flexlayout-react Layout, panel factory, "+" menu, Esc handler
  main.tsx                     # Entry: MUI ThemeProvider, CssBaseline, ErrorBoundary
  theme.ts                     # MUI createTheme (light palette, compact sizing)
  index.css                    # FlexLayout CSS variable overrides, Mol* button fixes
  molstar-theme.scss           # Mol* SCSS skin with custom color variables

  components/
    MolstarViewer.tsx           # Mol* init, custom color theme registration, water hiding
    SequenceViewer.tsx          # Monospace residue grid, drag-select, per-instance chain
    StructureLibrary.tsx        # Fetches /structures/index.json, loads on click
    StructureInfo.tsx           # Editable metadata fields + summary stats
    ElementsTable.tsx           # Categorized tree, visibility toggles, "Show Interface" button
    InteractionsPanel.tsx       # Computed interactions, type/chain filters, focused-chain banner
    FileLoader.tsx              # Upload button for local PDB/mmCIF files
    ChainSelector.tsx           # Chain dropdown, filters out water/ions

  hooks/
    useMolstarSync.ts           # 3D → sequence sync (LociMarkProvider + hover + empty-click)
    useSequenceSync.ts          # Sequence → 3D sync (cartoon halo + solid sticks)

  stores/
    structureStore.ts           # Zustand: plugin, chains, elements, meta, focusedChainId+Category
    selectionStore.ts           # Zustand: selected/hovered residues, lock mechanism

  lib/
    molstar-helpers.ts          # MolScript builders, custom tagged repr (showSticksForLoci), extractors
    residue-codes.ts            # 3-to-1 letter code mapping (incl. non-canonical), residue classes
    residue-color-theme.ts      # Mol* ColorTheme: carbons by residue type, others CPK

scripts/
  fix-native-deps.mjs          # postinstall: install platform-specific rollup bindings

structures/
  index.json                   # Manifest of pre-loaded structures
  *.pdb                        # Structure files (1crn, 1ubq, 4hhb, 1bna)
```
