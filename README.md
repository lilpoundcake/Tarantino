# Tarantino

Local tool for working with protein structures. Runs in your browser, no server needed.

## What it does

- **3D viewer** -- interactive molecular visualization powered by [Mol*](https://molstar.org) with custom residue-type coloring
- **Sequence viewer** -- amino acid sequence with color-coded residue types, click or drag to select ranges
- **Bidirectional selection** -- click a residue in sequence, it highlights in 3D and vice versa
- **Elements tree** -- hierarchical view of polymers, ligands, ions, and water with visibility toggles
- **Interactions table** -- computed H-bonds, ionic, disulfide, hydrophobic, pi-stacking, and more with chain pair filtering
- **Structure library** -- sidebar with pre-loaded structures, click to open
- **Dockable panels** -- drag panels to rearrange, "+" button to duplicate any panel into any tabset
- **Local files** -- upload your own .pdb or .mmcif files

Everything runs client-side. Your files never leave your machine.

## Install & run

```
git clone <repo-url>
cd tarantino
npm install
npm run dev
```

Open http://localhost:5173. That's it.

## Tech stack

React 19, TypeScript 6, Vite 6, Mol*, MUI (Material UI v9), flexlayout-react, Zustand.

## Panels

| Panel        | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| 3D Structure | Mol* viewer with custom SCSS skin and residue-type color theme on sticks    |
| Sequence     | Monospace amino acid grid, drag-select, independent chain selector per tab  |
| Elements     | Categorized tree (polymer/ligand/ion/water) with per-component visibility  |
| Interactions | Computed non-covalent + covalent contacts, filterable by type and chain pair|
| Library      | Clickable list from `structures/` folder, auto-scans for new files         |
| Info         | Editable metadata (name, organism, method, resolution, notes) + stats      |

Every panel can be duplicated via the "+" button on its tabset header. Sequence panels maintain independent chain selections.

## Adding structures to the library

Drop `.pdb` or `.mmcif` files into the `structures/` folder. They are auto-detected by the Vite dev server plugin -- no config needed.

For richer metadata, add an entry to `structures/index.json`:

```json
{
  "id": "1abc",
  "file": "1abc.pdb",
  "name": "My Protein",
  "organism": "Homo sapiens",
  "chains": 2,
  "residues": 150,
  "description": "Short description of what this structure is"
}
```

Refresh the browser and it appears in the Library panel.

## Pre-loaded structures

| ID   | Name            | Chains | Residues | Notes                        |
|------|-----------------|--------|----------|------------------------------|
| 1crn | Crambin         | 1      | 46       | Small plant protein           |
| 1ubq | Ubiquitin       | 1      | 76       | Protein degradation regulator |
| 4hhb | Hemoglobin      | 4      | 574      | Oxygen transport, 4 subunits  |
| 1bna | B-DNA Dodecamer | 2      | 24       | Classic B-form DNA helix      |

## Controls

| Action                  | How                                           |
|-------------------------|-----------------------------------------------|
| Load from library       | Click a structure in the Library panel         |
| Load your own file      | Click Upload in the top bar                    |
| Rotate 3D              | Left-click drag                                |
| Zoom                   | Scroll wheel                                   |
| Select residue (3D)    | Click an atom                                  |
| Select residue (seq)   | Click a letter in the Sequence panel           |
| Select range (seq)     | Click and drag across residues                 |
| Toggle element visibility | Click the eye icon in the Elements panel    |
| Focus interaction       | Click a row in the Interactions panel          |
| Duplicate a panel      | Click "+" on any tabset header                 |
| Clear selection         | Press Escape                                   |

## Build for production

```
npm run build
```

Output goes to `dist/`. Serve it with any static file server:

```
npx serve dist
```

## Notes

- Water is hidden by default when a structure loads
- The custom color theme (carbons by residue type, non-carbons CPK) applies to focus/stick representations
- Non-canonical amino acids (phosphorylated, modified cysteines, protonation variants, etc.) are normalized to standard codes
- The `postinstall` script (`scripts/fix-native-deps.mjs`) handles cross-platform rollup native bindings for macOS and Linux
