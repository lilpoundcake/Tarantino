const THREE_TO_ONE: Record<string, string> = {
  // Standard amino acids
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C',
  GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P',
  SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  SEC: 'U', PYL: 'O',

  // Non-canonical → canonical mappings
  // Cysteine variants
  CYX: 'C', CYM: 'C', CYF: 'C', CSS: 'C', CSO: 'C',
  OCS: 'C', CME: 'C', CSD: 'C', CSW: 'C', CSX: 'C',
  // Histidine variants (protonation states)
  HID: 'H', HIE: 'H', HIP: 'H', HSE: 'H', HSD: 'H',
  HSP: 'H', HIS1: 'H', HIS2: 'H', NEP: 'H',
  // Aspartate variants
  ASH: 'D', ASPP: 'D', AS4: 'D',
  // Glutamate variants
  GLH: 'E', GLUP: 'E', GL4: 'E',
  // Lysine variants
  LYN: 'K', KCX: 'K', MLY: 'K', M3L: 'K', MLZ: 'K',
  // Serine/Threonine (phosphorylated)
  SEP: 'S', TPO: 'T', PTR: 'Y',
  // Methionine
  MSE: 'M', SME: 'M', CXM: 'M',
  // Proline variants
  HYP: 'P', DPR: 'P',
  // Arginine
  ARN: 'R',
  // Phenylalanine
  PHD: 'F', DAL: 'A',
  // Other modified residues
  AIB: 'A', DAB: 'A', ORN: 'A',
  NLE: 'L', NVA: 'V',
  SAR: 'G', GLZ: 'G',
  TYS: 'Y', IYR: 'Y',
  TRO: 'W',
  ASX: 'N', GLX: 'Q',

  // DNA/RNA
  DA: 'A', DC: 'C', DG: 'G', DT: 'T',
  A: 'A', C: 'C', G: 'G', U: 'U',
}

export function threeToOne(code: string): string {
  return THREE_TO_ONE[code.toUpperCase()] ?? 'X'
}

const ONE_TO_THREE: Record<string, string> = {
  A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS',
  Q: 'GLN', E: 'GLU', G: 'GLY', H: 'HIS', I: 'ILE',
  L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO',
  S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL',
  U: 'SEC', O: 'PYL',
}

/** Returns canonical 3-letter code. E.g. CYX→CYS, HID→HIS, ASH→ASP */
export function toCanonicalThree(code: string): string {
  const upper = code.toUpperCase()
  // Already canonical?
  if (ONE_TO_THREE[THREE_TO_ONE[upper]] === upper) return upper
  // Map via one-letter
  const one = THREE_TO_ONE[upper]
  if (one && one !== 'X') return ONE_TO_THREE[one] ?? upper
  return upper
}

const HYDROPHOBIC = new Set(['A', 'V', 'I', 'L', 'M', 'F', 'W', 'P'])
const POSITIVE = new Set(['R', 'H', 'K'])
const NEGATIVE = new Set(['D', 'E'])
const POLAR = new Set(['S', 'T', 'Y', 'N', 'Q', 'C'])

export function residueClass(oneLetterCode: string): string {
  if (HYDROPHOBIC.has(oneLetterCode)) return 'hydrophobic'
  if (POSITIVE.has(oneLetterCode)) return 'positive'
  if (NEGATIVE.has(oneLetterCode)) return 'negative'
  if (POLAR.has(oneLetterCode)) return 'polar'
  if (oneLetterCode === 'G') return 'special'
  return 'other'
}
