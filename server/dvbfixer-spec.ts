/**
 * DVBFixer command specs. Each command declares its CLI flags so the UI
 * can render forms generically and the backend can build the arg list.
 *
 * Used by both the backend (server/api.ts → builds CLI args) and the
 * frontend (DVBFixerPanel → renders forms).
 */

export type FlagType = 'bool' | 'number' | 'text' | 'select'

export interface FlagDef {
  /** CLI flag, e.g. '--ph'. Boolean flags emit the flag when value is true. */
  flag: string
  /** UI label */
  label: string
  type: FlagType
  default?: string | number | boolean
  /** for 'select' */
  options?: string[]
  /** for 'number' inputs */
  min?: number
  max?: number
  step?: number
  /** Helper text shown below input */
  help?: string
  /**
   * Repeatable text flag (DVBFixer's `--mutate`, `--ss`, etc).
   * The UI is still a single text input, but on the CLI side the value is
   * split on commas and emitted as `--flag v1 --flag v2 --flag v3`.
   */
  repeatable?: boolean
  /**
   * Multi-value text flag (e.g. `--ff a.xml b.xml`). UI is one text input;
   * on the CLI side the value is split on whitespace and emitted as a single
   * `--flag` followed by all values: `--flag v1 v2 v3` (Python argparse
   * nargs='+').
   */
  multi?: boolean
}

export interface CommandDef {
  /** dvbfixer subcommand */
  name: string
  /** Human-readable label */
  label: string
  description: string
  flags: FlagDef[]
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'split',
    label: 'Split',
    description: 'Empirical chain splitting. Detects breaks by residue numbering, peptide bond distance, or nearest-atom gaps.',
    flags: [
      { flag: '--distance-cutoff', label: 'C→N peptide bond cutoff (Å)', type: 'number', default: 2.5, step: 0.1, min: 0 },
      { flag: '--gap-cutoff', label: 'Nearest-atom gap cutoff (Å)', type: 'number', default: 15.0, step: 0.5, min: 0 },
      { flag: '--no-distance', label: 'Disable distance-based detection', type: 'bool' },
      { flag: '--no-renumber', label: 'Keep original residue numbers', type: 'bool' },
      { flag: '--keep-water', label: 'Keep water / ions', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'renumber',
    label: 'Renumber',
    description: 'Renumber residues by aligning ATOM records to SEQRES. Removes insertion codes (e.g. Kabat antibody numbering). With --scheme, applies EU or Kabat antibody numbering.',
    flags: [
      { flag: '--scheme', label: 'Numbering scheme', type: 'select', default: '', options: ['', 'seqres', 'kabat', 'chothia', 'imgt', 'martin', 'eu', 'aho'], help: 'Renumbering scheme. Antibody-specific schemes (kabat, chothia, imgt, martin, eu, aho) renumber antibody constant/variable domains in canonical conventions. Default (empty) → seqres-based plain renumbering.' },
      { flag: '--keep-water', label: 'Keep water', type: 'bool' },
      { flag: '--rename', label: 'Rename non-canonical residues', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'model',
    label: 'Model',
    description: 'Rebuild missing loops / gaps with Modeller (LoopModel + MD refinement). Preserves non-protein chains.',
    flags: [
      { flag: '--fasta', label: 'FASTA file (alternative to SEQRES)', type: 'text', default: '', help: 'Path to FASTA file' },
      { flag: '--num-models', label: 'Initial models to generate (-n)', type: 'number', default: 1, step: 1, min: 1 },
      { flag: '--num-loops', label: 'Loop refinement models per initial', type: 'number', default: 2, step: 1, min: 1 },
      { flag: '--md-level', label: 'MD refinement level', type: 'select', default: 'fast', options: ['none', 'fast', 'slow', 'very_slow', 'slow_large'] },
      { flag: '--no-terminal', label: 'Skip N/C-terminal modeling', type: 'bool' },
      { flag: '--keep-water', label: 'Keep water', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'prepare',
    label: 'Prepare',
    description: 'Add missing residues, heavy atoms, and hydrogens via PDBFixer. Heterogens protonated by default.',
    flags: [
      { flag: '--ph', label: 'pH for hydrogen addition', type: 'number', default: 7.0, step: 0.1, min: 0, max: 14 },
      { flag: '--keep-water', label: 'Keep crystallographic waters', type: 'bool' },
      { flag: '--strip-heterogens', label: 'Remove sugars / ligands (protein-only)', type: 'bool' },
      { flag: '--no-heterogen-h', label: 'Keep heterogens but skip H addition', type: 'bool' },
      { flag: '--mutate', label: 'Mutations (CHAIN:RESNUM:NEW_AA, comma-separated)', type: 'text', default: '', repeatable: true, help: 'e.g. A:272:GLU,A:283:GLU,B:312:ASP — each is passed as a separate --mutate flag' },
      { flag: '--no-infer-conect', label: 'Skip CONECT inference', type: 'bool', help: 'Trust only explicit CONECT records in the input PDB; do not let PDBFixer add new CONECTs based on atom proximity.' },
      { flag: '--rename', label: 'Rename non-canonical residues', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'minimize',
    label: 'Minimize',
    description: 'Energy-minimize with OpenMM (AMBER14 + GLYCAM_06j-1). Reads .dat for tiered restraints if present.',
    flags: [
      { flag: '--ph', label: 'pH', type: 'number', default: 7.0, step: 0.1, min: 0, max: 14 },
      {
        flag: '--ff',
        label: 'Force field',
        type: 'select',
        multi: true,
        default: '',
        options: [
          '',
          'amber19/protein.ff19SB.xml amber19/tip3p.xml',
          'amber14-all.xml amber14/GLYCAM_06j-1.xml',
          'amber14/protein.ff14SB.xml amber14/tip3p.xml',
          'charmm36.xml charmm36/water.xml',
        ],
        help: 'OpenMM force-field bundle. Empty = DVBFixer auto-picks (AMBER19 for proteins, AMBER14 + GLYCAM_06j-1 for glycoproteins).',
      },
      { flag: '--restraint-k', label: 'Strong restraint k (kcal/mol/Å²)', type: 'number', default: 100.0, step: 1, min: 0 },
      { flag: '--weak-k', label: 'Weak restraint k (kcal/mol/Å²)', type: 'number', default: 5.0, step: 1, min: 0 },
      { flag: '--max-iter', label: 'Max iterations per phase', type: 'number', default: 1000, step: 100, min: 1 },
      { flag: '--rebuild-h', label: 'Strip & re-add hydrogens', type: 'bool' },
      { flag: '--strip-heterogens', label: 'Protein-only (with coords splicing)', type: 'bool' },
      { flag: '--no-solvent', label: 'Vacuum minimization (no solvent)', type: 'bool' },
      { flag: '--xtb-refine', label: 'Post-refine with xtb GFN-FF', type: 'bool' },
      { flag: '--xtb-cycles', label: 'Max xtb cycles', type: 'number', default: 200, step: 10, min: 1, help: 'Only used if --xtb-refine is on' },
      { flag: '--obminimize-refine', label: 'Post-refine with OpenBabel obminimize', type: 'bool' },
      { flag: '--obminimize-ff', label: 'OpenBabel force field', type: 'select', default: 'UFF', options: ['UFF', 'MMFF94', 'GAFF'], help: 'Only used if --obminimize-refine is on' },
      { flag: '--obminimize-steps', label: 'OpenBabel minimization steps', type: 'number', default: 500, step: 50, min: 1, help: 'Only used if --obminimize-refine is on' },
      { flag: '--refine-heterogens-only', label: 'Refine only heterogens (protein frozen)', type: 'bool' },
      { flag: '--rename', label: 'Rename non-canonical residues', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'protonate',
    label: 'Protonate',
    description: 'Predict per-residue pKa (PROPKA3) and rename titratable residues to AMBER protonation variants at target pH.',
    flags: [
      { flag: '--ph', label: 'Target pH', type: 'number', default: 7.0, step: 0.1, min: 0, max: 14 },
      { flag: '--his-default', label: 'Default neutral HIS tautomer', type: 'select', default: 'HIE', options: ['HIE', 'HID'] },
      { flag: '--protassign', label: 'PROTASSIGN side-chain flips', type: 'bool', default: true, help: 'Run external PROTASSIGN to flip HIS, ASN, and GLN side chains for optimal H-bond geometry before assigning protonation states.' },
      { flag: '--no-hydrogens', label: 'Only rename, skip H addition', type: 'bool' },
      {
        flag: '--ff',
        label: 'Force field',
        type: 'select',
        multi: true,
        default: '',
        options: [
          '',
          'amber19/protein.ff19SB.xml amber19/tip3p.xml',
          'amber14-all.xml amber14/GLYCAM_06j-1.xml',
          'amber14/protein.ff14SB.xml amber14/tip3p.xml',
          'charmm36.xml charmm36/water.xml',
        ],
        help: 'OpenMM force-field bundle. Empty = DVBFixer auto-picks (AMBER19 for proteins, AMBER14 + GLYCAM_06j-1 for glycoproteins).',
      },
      { flag: '--keep-water', label: 'Keep water', type: 'bool' },
      { flag: '--summary', label: 'Print full pKa table', type: 'bool' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
  {
    name: 'convert',
    label: 'Convert',
    description: 'Convert structure naming between PDB/AMBER/GLYCAM and CHARMM conventions. Default (--to-amber) converts PDB/CHARMM-named input to GLYCAM sugar codes + AMBER protonation variants (HID/HIE/HIP, ASH/GLH, LYN, CYX/CYM) consumable by prepare / minimize / protonate / top --acpype. With --to-charmm, the reverse: GLYCAM/AMBER → CHARMM (BGLCNA/BMAN/…, HSD/HSE/HSP/ASPP/GLUP/LSN); glycoprotein NLN/OLS/OLT revert to ASN/SER/THR and ROH/OME caps are dropped. Both directions are idempotent.',
    flags: [
      { flag: '--to-amber', label: 'Direction: → AMBER + GLYCAM (default)', type: 'bool', help: 'Convert PDB/CHARMM → GLYCAM sugars + AMBER protonation variants. Mutually exclusive with --to-charmm.' },
      { flag: '--to-charmm', label: 'Direction: → CHARMM', type: 'bool', help: 'Convert GLYCAM/AMBER → CHARMM-compatible naming. Drops ROH/OME caps; NLN/OLS/OLT revert to ASN/SER/THR. Mutually exclusive with --to-amber.' },
      { flag: '--no-roh', label: 'Skip ROH cap at reducing end', type: 'bool', help: 'Suppress ROH/reducing-end cap addition. Applies only to the --to-amber direction.' },
      { flag: '--verbose', label: 'Verbose output', type: 'bool', default: true },
    ],
  },
]
