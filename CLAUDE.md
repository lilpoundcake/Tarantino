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
- **Elements**: tree view of structure components (polymers, ligands, ions, water) with visibility toggles
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
                  │       ↕
                  │  selectionStore (with _lock field to prevent loops)
                  │       ↕
                  └── MolstarViewer ← molstar-helpers (query builder, loci operations)
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
- **Focus representation**: `plugin.managers.structure.focus.setFromLoci()` triggers built-in ball-and-stick focus repr
- **Visibility**: `setSubtreeVisibility()` from `molstar/lib/mol-plugin/behavior/static/state`
- **Interactions computation**: `computeInteractions()` from `molstar/lib/mol-model-props/computed/interactions`

### Custom Color Theme

`src/lib/residue-color-theme.ts` registers a Mol* `ColorTheme.Provider` named `tarantino-residue-type`. Carbons are colored by residue type (hydrophobic=green, positive=blue, negative=red, polar=orange, cysteine=yellow, aromatic=teal, special=pink). Non-carbon atoms use CPK element colors. This theme is applied to focus representations (sticks) via a subscription on `plugin.managers.structure.focus.behaviors.current`.

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

- `useMolstarSync` (structure → sequence): registers a `LociMarkProvider` via `addProvider`/`removeProvider` on `lociSelects`, and subscribes to `plugin.behaviors.interaction.hover`
- `useSequenceSync` (sequence → structure): subscribes to `selectionStore` changes, pushes Loci operations to Mol*

Both hooks are activated in `App.tsx`. Hover sync is debounced at 50ms. The `selectionStore._lock` field (expires after 200ms) prevents infinite update loops between the two sync directions.

### Interactions Panel

`InteractionsPanel.tsx` uses Mol*'s `computeInteractions()` to find non-covalent contacts (H-bonds, ionic, cation-pi, pi-stacking, halogen, hydrophobic, metal coordination). It also scans `structure.interUnitBonds` and intra-unit bonds for disulfide bridges and inter-chain covalent bonds. Results are deduplicated and displayed in a filterable table with chain pair dropdowns. Water interactions are excluded. Clicking a row focuses/zooms the 3D view to those residues.

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
  App.tsx                      # Root: flexlayout-react Layout, panel factory, "+" menu
  main.tsx                     # Entry: MUI ThemeProvider, CssBaseline, ErrorBoundary
  theme.ts                     # MUI createTheme (light palette, compact sizing)
  index.css                    # FlexLayout CSS variable overrides, Mol* button fixes
  molstar-theme.scss           # Mol* SCSS skin with custom color variables

  components/
    MolstarViewer.tsx           # Mol* init, custom color theme registration, water hiding
    SequenceViewer.tsx          # Monospace residue grid, drag-select, per-instance chain
    StructureLibrary.tsx        # Fetches /structures/index.json, loads on click
    StructureInfo.tsx           # Editable metadata fields + summary stats
    ElementsTable.tsx           # Categorized tree (polymer/ligand/ion/water) with visibility
    InteractionsPanel.tsx       # Computed interactions table with type/chain filters
    FileLoader.tsx              # Upload button for local PDB/mmCIF files
    ChainSelector.tsx           # Chain dropdown, filters out water/ions

  hooks/
    useMolstarSync.ts           # 3D → sequence sync (LociMarkProvider + hover)
    useSequenceSync.ts          # Sequence → 3D sync (selectionStore subscriber)

  stores/
    structureStore.ts           # Zustand: plugin instance, chains, elements, meta, loading
    selectionStore.ts           # Zustand: selected/hovered residues, lock mechanism

  lib/
    molstar-helpers.ts          # MolScript query builders, loci operations, data extractors
    residue-codes.ts            # 3-to-1 letter code mapping (incl. non-canonical), residue classes
    residue-color-theme.ts      # Mol* ColorTheme: carbons by residue type, others CPK

scripts/
  fix-native-deps.mjs          # postinstall: install platform-specific rollup bindings

structures/
  index.json                   # Manifest of pre-loaded structures
  *.pdb                        # Structure files (1crn, 1ubq, 4hhb, 1bna)
```
