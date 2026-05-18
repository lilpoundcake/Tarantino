# Tarantino

Local tool for working with protein structures. Runs in your browser, with an
optional Node-side dev backend for DVBFixer pipelines and a PostgreSQL-backed
mutations table.

## What it does

- **3D viewer (×2)** -- interactive [Mol*](https://molstar.org) molecular
  visualization with custom residue-type coloring. Open a second viewer to
  compare structures side-by-side; toggle camera sync via the link icon in
  the top bar.
- **Sequence viewer** -- amino acid sequence with color-coded residue types,
  click or drag to select ranges
- **Pairwise alignment** -- Needleman-Wunsch with BLOSUM62 between any two
  chains, including across two different loaded structures
- **Bidirectional selection** -- click a residue in sequence or alignment, it
  highlights in 3D (solid ball-and-stick) and vice versa
- **Elements tree** -- hierarchical view of polymers, ligands, ions, and water
  with visibility toggles + per-chain **Show Interface** button (5 Å contact
  zone, distinguishes polymer vs ligand on the same chain id)
- **Interactions table** -- computed H-bonds, ionic, disulfide, hydrophobic,
  pi-stacking, and more with chain pair filtering; auto-filters when Show
  Interface is active
- **DVBFixer panel** -- form-driven UI for the DVBFixer CLI (split, renumber,
  model, prepare, minimize, protonate, glycam); outputs appear as nested
  children of the input structure in the Library
- **Mutations panel** -- editable DataGrid backed by PostgreSQL for keeping
  antibody mutation sets (e.g. YTE, LS, DLE)
- **Structure library** -- expandable tree of pre-loaded structures, star a
  child to make it the default-load target of its family root
- **Dockable panels** -- drag panels to rearrange, "+" button to spawn any
  panel into any tabset
- **Local files** -- upload your own .pdb or .mmcif files into either viewer

Everything except DVBFixer runs and the Mutations DB runs in the browser.
Your files never leave your machine.

## Install & run

### Minimum (viewer only — no DVBFixer, no Mutations DB)

```
git clone <repo-url>
cd tarantino
npm install
npm run dev:no-db
```

Open http://localhost:5173. The Mutations tab will show a configuration
hint; everything else works.

### Full install (DVBFixer + Mutations)

Tarantino can drive a [DVBFixer](https://github.com/lilpoundcake/DVBFixer)
pipeline (split / renumber / model / prepare / minimize / protonate / glycam)
and store antibody mutation sets in PostgreSQL. Both are exposed as panels.

**1.** Create a single `tarantino` micromamba env that holds the DVBFixer
Python toolchain AND lets Node spawn `dvbfixer` directly:

```
git clone https://github.com/lilpoundcake/DVBFixer
cd DVBFixer
micromamba create -f environment.yml -n tarantino
micromamba activate tarantino
pip install -e .
```

#### Modeller license

`model` and (indirectly) other DVBFixer commands rely on
[Modeller](https://salilab.org/modeller/), which requires a free academic
license. Register at <https://salilab.org/modeller/registration.html>, then:

```
micromamba activate tarantino
KEY=YOUR_LICENSE_KEY bash scripts/set-modeller-key.sh
```

The helper finds `<env>/lib/modeller-*/modlib/modeller/config.py` and writes
`license = r'YOUR_LICENSE_KEY'` into it (backing up the previous file).
You can also pass an explicit prefix as the first arg:

```
KEY=YOUR_LICENSE_KEY bash scripts/set-modeller-key.sh /opt/conda/envs/tarantino
```

**2.** Start the app. PostgreSQL is auto-managed — if Docker is installed,
`npm run dev` spins up a local postgres container (port 5432) and sets
`DATABASE_URL` automatically. The `mutations` table is created on first
connection.

```
cd tarantino
npm install
micromamba activate tarantino   # so `dvbfixer` is on PATH
npm run dev
```

The first run downloads the postgres image; the container survives `Ctrl+C`
so subsequent runs are instant.

### DB controls

| Command             | What it does                                          |
|---------------------|-------------------------------------------------------|
| `npm run dev`       | Auto-starts postgres (if docker present), then vite   |
| `npm run dev:no-db` | Skip auto-postgres, just run vite                     |
| `npm run db:up`     | Start the postgres container                          |
| `npm run db:down`   | Stop & remove the container (volume persists)         |
| `npm run db:logs`   | Tail postgres logs                                    |

**Override** the auto-setup by exporting `DATABASE_URL` yourself before
`npm run dev` — the script detects an existing value and skips Docker:

```
export DATABASE_URL=postgres://my-user:pw@my-host:5432/my-db
npm run dev
```

**Override DVBFixer** if it's not on PATH (e.g. wrapped in micromamba):

```
export DVBFIXER_CMD="micromamba run -n tarantino dvbfixer"
```

The DVBFixer tab is usable even without the env (it will just error on
Run); the Mutations tab is usable even without DATABASE_URL or Docker
(it will show a configuration message).

## Tech stack

React 19, TypeScript 6, Vite 6, Mol*, MUI (Material UI v9, plus
`@mui/x-data-grid`), flexlayout-react, Zustand. PostgreSQL via `pg`
(loaded lazily; optional). Vite middleware backend (`server/api-plugin.ts`).

## Panels

| Panel               | Description                                                                 |
|---------------------|-----------------------------------------------------------------------------|
| 3D Structure        | Mol* viewer with custom SCSS skin and residue-type color theme on sticks    |
| 3D Structure (B)    | Independent secondary viewer for side-by-side comparison; camera sync toggle in top bar |
| Sequence            | Monospace amino acid grid, drag-select, independent chain selector per tab  |
| Alignment           | Pairwise Needleman-Wunsch (BLOSUM62) across chains, incl. across structure A and B; click number row to pick the same column on both sides |
| Elements            | Categorized tree (polymer/ligand/ion/water) with per-component visibility + per-chain Show Interface |
| Interactions        | Computed non-covalent + covalent contacts, filterable by type and chain pair |
| DVBFixer            | Run split / renumber / model / prepare / minimize / protonate / glycam; outputs land in `structures/dvb_<command>_<timestamp>/` and appear as children in the Library |
| Mutations           | Editable DataGrid backed by PostgreSQL (`mutations` table: chain / mutation_name / mutations) |
| Library             | Expandable tree of structures from `structures/`; star a row to set it as the family's default load target |
| Info                | Editable metadata (name, organism, method, resolution, notes) + stats        |

Every panel can be duplicated via the "+" button on its tabset header.
Sequence panels maintain independent chain selections.

## DVBFixer commands

| Command   | What it does                                                                              |
|-----------|-------------------------------------------------------------------------------------------|
| split     | Empirical chain splitting via residue numbering / peptide-bond distance / nearest-atom gaps |
| renumber  | Renumber residues by aligning ATOM records to SEQRES; removes Kabat-style insertion codes |
| model     | Rebuild missing loops / gaps with Modeller (LoopModel + MD refinement)                     |
| prepare   | Add missing residues, heavy atoms, hydrogens via PDBFixer; supports point mutations        |
| minimize  | Energy-minimize with OpenMM (AMBER14 + GLYCAM); optional xtb / obminimize post-refine     |
| protonate | Predict per-residue pKa (PROPKA3); rename to AMBER protonation variants at target pH       |
| glycam    | Convert glycan PDB residues (BGC, GAL, NAG, ...) to GLYCAM 3-character codes               |

Each command's flags are auto-generated from `server/dvbfixer-spec.ts`. The
form supports comma-separated repeatable flags (`--mutate A:272:GLU,A:283:GLU`
becomes `--mutate A:272:GLU --mutate A:283:GLU`) and space-separated multi-value
flags (`--ff a.xml b.xml` becomes a single `--ff a.xml b.xml`).

## Library hierarchy & starring

The Library panel renders structures as a tree. Entries get a `parent` field
in `index.json` either manually or automatically (every successful DVBFixer
run is registered as a child of its input file). Children are auto-expanded
when something new appears.

Each row has a star button. Starring a descendant marks it as the
**default-load target** of its family root: clicking the root then loads the
starred descendant instead. The root row shows an orange `⭐ → <name>`
hint chip when this is in effect. The tree structure is unchanged — starring
just flips a flag.

When two 3D viewers are open, a small `A` / `B` toggle in the Library header
chooses which viewer the next click loads into.

## Adding structures to the library

Drop `.pdb`, `.cif`, or `.mmcif` files into `structures/` (subfolders are
scanned recursively; directories starting with `.` or `_` are skipped).
They are auto-detected — no config needed. Stale `index.json` entries whose
files have been deleted are auto-pruned on every scan.

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

To mark something as a child of another structure, add `"parent": "<file>"`.

## Pre-loaded structures

| ID   | Name            | Chains | Residues | Notes                          |
|------|-----------------|--------|----------|--------------------------------|
| 1crn | Crambin         | 1      | 46       | Small plant protein            |
| 1ubq | Ubiquitin       | 1      | 76       | Protein degradation regulator  |
| 4hhb | Hemoglobin      | 4      | 574      | Oxygen transport, 4 subunits   |
| 1bna | B-DNA Dodecamer | 2      | 24       | Classic B-form DNA helix       |

## Controls

| Action                       | How                                                          |
|------------------------------|--------------------------------------------------------------|
| Load from library            | Click a structure in the Library panel                       |
| Choose target viewer         | `A` / `B` toggle in the Library header (shown when both viewers are open) |
| Star a structure             | Star icon at the right of each row                           |
| Load your own file           | Click Upload in the top bar                                  |
| Toggle camera sync (A ↔ B)   | Link icon in the top bar                                     |
| Rotate 3D                    | Left-click drag                                              |
| Zoom                         | Scroll wheel                                                 |
| Select residue (3D)          | Click an atom                                                |
| Select residue (seq)         | Click a letter in the Sequence panel                         |
| Select range (seq)           | Click and drag across residues                               |
| Pick aligned column (both A and B) | Click a position in the number row above/below an alignment row |
| Drag-select on alignment     | Click and drag across one side                               |
| Toggle element visibility    | Eye icon in the Elements panel                               |
| Show Interface               | Network/hub icon next to a chain in Elements (zooms to 5 Å contact zone, filters Interactions) |
| Focus interaction            | Click a row in the Interactions panel                        |
| Run a DVBFixer command       | Pick the sub-tab, set the input file, click Run              |
| Duplicate a panel            | Click "+" on any tabset header                               |
| Clear 3D markers             | Tap empty space in 3D                                        |
| Clear everything             | Press Escape                                                 |

## Build for production

```
npm run build
```

Output goes to `dist/`. Serve it with any static file server:

```
npx serve dist
```

Note: the production build is **viewer-only**. The DVBFixer and Mutations
backends are dev-time Vite middleware in `server/api-plugin.ts` — they
don't ship in the static build. To run those in production, host a Node
server that re-uses the plugin (or port the routes).

## Notes

- Water is hidden by default when a structure loads
- The custom color theme (carbons by residue type, non-carbons CPK) applies to focus/stick representations
- Non-canonical amino acids (phosphorylated residues, modified cysteines, protonation variants, etc.) are normalized to standard codes
- Failed DVBFixer runs are moved to `structures/_dvb_failed/` so they don't pollute the library; the scanner skips `_*` and `.*` directories
- The `postinstall` script (`scripts/fix-native-deps.mjs`) handles cross-platform rollup native bindings for macOS and Linux
