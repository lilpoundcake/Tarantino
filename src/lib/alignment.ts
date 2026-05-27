// Needleman-Wunsch global pairwise alignment with BLOSUM62 substitution matrix.
// Pure TypeScript, no external deps.

import { threeToOne } from './residue-codes'

const ALPHABET = 'ARNDCQEGHILKMFPSTWYVBZX*'
// BLOSUM62 substitution matrix (rows/columns indexed by ALPHABET)
const BLOSUM62 = [
  // A   R   N   D   C   Q   E   G   H   I   L   K   M   F   P   S   T   W   Y   V   B   Z   X   *
  [ 4, -1, -2, -2,  0, -1, -1,  0, -2, -1, -1, -1, -1, -2, -1,  1,  0, -3, -2,  0, -2, -1,  0, -4], // A
  [-1,  5,  0, -2, -3,  1,  0, -2,  0, -3, -2,  2, -1, -3, -2, -1, -1, -3, -2, -3, -1,  0, -1, -4], // R
  [-2,  0,  6,  1, -3,  0,  0,  0,  1, -3, -3,  0, -2, -3, -2,  1,  0, -4, -2, -3,  3,  0, -1, -4], // N
  [-2, -2,  1,  6, -3,  0,  2, -1, -1, -3, -4, -1, -3, -3, -1,  0, -1, -4, -3, -3,  4,  1, -1, -4], // D
  [ 0, -3, -3, -3,  9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1, -3, -3, -2, -4], // C
  [-1,  1,  0,  0, -3,  5,  2, -2,  0, -3, -2,  1,  0, -3, -1,  0, -1, -2, -1, -2,  0,  3, -1, -4], // Q
  [-1,  0,  0,  2, -4,  2,  5, -2,  0, -3, -3,  1, -2, -3, -1,  0, -1, -3, -2, -2,  1,  4, -1, -4], // E
  [ 0, -2,  0, -1, -3, -2, -2,  6, -2, -4, -4, -2, -3, -3, -2,  0, -2, -2, -3, -3, -1, -2, -1, -4], // G
  [-2,  0,  1, -1, -3,  0,  0, -2,  8, -3, -3, -1, -2, -1, -2, -1, -2, -2,  2, -3,  0,  0, -1, -4], // H
  [-1, -3, -3, -3, -1, -3, -3, -4, -3,  4,  2, -3,  1,  0, -3, -2, -1, -3, -1,  3, -3, -3, -1, -4], // I
  [-1, -2, -3, -4, -1, -2, -3, -4, -3,  2,  4, -2,  2,  0, -3, -2, -1, -2, -1,  1, -4, -3, -1, -4], // L
  [-1,  2,  0, -1, -3,  1,  1, -2, -1, -3, -2,  5, -1, -3, -1,  0, -1, -3, -2, -2,  0,  1, -1, -4], // K
  [-1, -1, -2, -3, -1,  0, -2, -3, -2,  1,  2, -1,  5,  0, -2, -1, -1, -1, -1,  1, -3, -1, -1, -4], // M
  [-2, -3, -3, -3, -2, -3, -3, -3, -1,  0,  0, -3,  0,  6, -4, -2, -2,  1,  3, -1, -3, -3, -1, -4], // F
  [-1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4,  7, -1, -1, -4, -3, -2, -2, -1, -2, -4], // P
  [ 1, -1,  1,  0, -1,  0,  0,  0, -1, -2, -2,  0, -1, -2, -1,  4,  1, -3, -2, -2,  0,  0,  0, -4], // S
  [ 0, -1,  0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1,  1,  5, -2, -2,  0, -1, -1,  0, -4], // T
  [-3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1,  1, -4, -3, -2, 11,  2, -3, -4, -3, -2, -4], // W
  [-2, -2, -2, -3, -2, -1, -2, -3,  2, -1, -1, -2, -1,  3, -3, -2, -2,  2,  7, -1, -3, -2, -1, -4], // Y
  [ 0, -3, -3, -3, -1, -2, -2, -3, -3,  3,  1, -2,  1, -1, -2, -2,  0, -3, -1,  4, -3, -2, -1, -4], // V
  [-2, -1,  3,  4, -3,  0,  1, -1,  0, -3, -4,  0, -3, -3, -2,  0, -1, -4, -3, -3,  4,  1, -1, -4], // B
  [-1,  0,  0,  1, -3,  3,  4, -2,  0, -3, -3,  1, -1, -3, -1,  0, -1, -3, -2, -2,  1,  4, -1, -4], // Z
  [ 0, -1, -1, -1, -2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2,  0,  0, -2, -1, -1, -1, -1, -1, -4], // X
  [-4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4,  1], // *
]

const INDEX = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i)

const X_IDX = INDEX.get('X')!

function score(a: string, b: string): number {
  const i = INDEX.get(a) ?? X_IDX
  const j = INDEX.get(b) ?? X_IDX
  return BLOSUM62[i][j]
}

export interface AlignmentResult {
  /** Aligned sequence A with gaps as '-' */
  alignedA: string
  /** Aligned sequence B with gaps as '-' */
  alignedB: string
  /** Per-column annotation: '|' identity, ':' positive, '.' weak, ' ' gap/mismatch */
  annotation: string
  /** Total alignment score */
  score: number
  /** Number of identical positions */
  identity: number
  /** Number of similar positions (positive score) */
  similarity: number
  /** Length of the aligned region */
  length: number
}

/**
 * Global pairwise alignment via Needleman-Wunsch with affine gap penalty.
 * `seqA` and `seqB` are one-letter amino acid sequences.
 */
export function alignSequences(
  seqA: string,
  seqB: string,
  gapOpen: number = -11,
  gapExtend: number = -1
): AlignmentResult {
  const m = seqA.length
  const n = seqB.length

  // M[i][j] = best score ending with match/mismatch at (i,j)
  // X[i][j] = best score ending with gap in seqA (i fixed, j advances)
  // Y[i][j] = best score ending with gap in seqB
  const NEG = -1e9
  const M: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(NEG))
  const X: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(NEG))
  const Y: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(NEG))
  // Traceback pointers: 0=M, 1=X (gap in A), 2=Y (gap in B)
  const tbM: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  const tbX: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  const tbY: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  M[0][0] = 0
  for (let i = 1; i <= m; i++) {
    Y[i][0] = gapOpen + (i - 1) * gapExtend
    tbY[i][0] = 2
  }
  for (let j = 1; j <= n; j++) {
    X[0][j] = gapOpen + (j - 1) * gapExtend
    tbX[0][j] = 1
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const s = score(seqA[i - 1], seqB[j - 1])
      // M: came from M, X, or Y at (i-1, j-1)
      const mm = M[i - 1][j - 1] + s
      const mx = X[i - 1][j - 1] + s
      const my = Y[i - 1][j - 1] + s
      if (mm >= mx && mm >= my) { M[i][j] = mm; tbM[i][j] = 0 }
      else if (mx >= my)        { M[i][j] = mx; tbM[i][j] = 1 }
      else                       { M[i][j] = my; tbM[i][j] = 2 }
      // X: gap in seqA (consume seqB), came from M (open) or X (extend) at (i, j-1)
      const xOpen = M[i][j - 1] + gapOpen
      const xExt  = X[i][j - 1] + gapExtend
      if (xOpen >= xExt) { X[i][j] = xOpen; tbX[i][j] = 0 } else { X[i][j] = xExt; tbX[i][j] = 1 }
      // Y: gap in seqB (consume seqA), came from M (open) or Y (extend) at (i-1, j)
      const yOpen = M[i - 1][j] + gapOpen
      const yExt  = Y[i - 1][j] + gapExtend
      if (yOpen >= yExt) { Y[i][j] = yOpen; tbY[i][j] = 0 } else { Y[i][j] = yExt; tbY[i][j] = 2 }
    }
  }

  // Pick the best end state
  let state: 0 | 1 | 2 = 0
  let best = M[m][n]
  if (X[m][n] > best) { best = X[m][n]; state = 1 }
  if (Y[m][n] > best) { best = Y[m][n]; state = 2 }

  // Traceback
  let i = m, j = n
  const a: string[] = []
  const b: string[] = []
  while (i > 0 || j > 0) {
    if (state === 0) {
      const prev = tbM[i][j]
      a.push(seqA[i - 1])
      b.push(seqB[j - 1])
      i--; j--
      state = prev as 0 | 1 | 2
    } else if (state === 1) {
      const prev = tbX[i][j]
      a.push('-')
      b.push(seqB[j - 1])
      j--
      state = prev as 0 | 1 | 2
    } else {
      const prev = tbY[i][j]
      a.push(seqA[i - 1])
      b.push('-')
      i--
      state = prev as 0 | 1 | 2
    }
  }

  const alignedA = a.reverse().join('')
  const alignedB = b.reverse().join('')

  // Build annotation + count identities/similarities
  let ann = ''
  let identity = 0
  let similarity = 0
  for (let k = 0; k < alignedA.length; k++) {
    const aa = alignedA[k]
    const bb = alignedB[k]
    if (aa === '-' || bb === '-') {
      ann += ' '
    } else if (aa === bb) {
      ann += '|'
      identity++
      similarity++
    } else {
      const s = score(aa, bb)
      if (s > 0) { ann += ':'; similarity++ }
      else if (s === 0) { ann += '.' }
      else { ann += ' ' }
    }
  }

  return {
    alignedA, alignedB, annotation: ann,
    score: best,
    identity, similarity,
    length: alignedA.length,
  }
}

export interface TrimmedIdentity {
  /** Identities ('|' in annotation) inside the trimmed range. */
  matches: number
  /** Columns in the trimmed range (includes internal gaps as mismatches). */
  length: number
  /** matches / length, 0 when length === 0. */
  identity: number
}

/**
 * Identity score after trimming leading/trailing columns where either side
 * is a gap. Used for "are these the same protein?" decisions in the presence
 * of differential truncation (e.g. a chain copy with a disordered N-terminus
 * shouldn't be penalised for the missing residues). Internal gaps stay
 * inside the trimmed range and count as mismatches.
 */
export function trimmedIdentity(result: AlignmentResult): TrimmedIdentity {
  const { alignedA, alignedB, annotation } = result
  const L = alignedA.length
  let start = 0
  while (start < L && (alignedA[start] === '-' || alignedB[start] === '-')) start++
  let end = L - 1
  while (end >= start && (alignedA[end] === '-' || alignedB[end] === '-')) end--
  if (end < start) return { matches: 0, length: 0, identity: 0 }
  let matches = 0
  for (let i = start; i <= end; i++) if (annotation[i] === '|') matches++
  const length = end - start + 1
  return { matches, length, identity: length === 0 ? 0 : matches / length }
}

/**
 * Map a residue list (each item has `compId`) to a 1-letter sequence via the
 * `threeToOne` table. Unknown / non-standard residues map to 'X'.
 */
export function chainToSequence(residues: Array<{ compId: string }>): string {
  return residues.map(r => threeToOne(r.compId)).join('')
}
