import { alignSequences, chainToSequence, trimmedIdentity } from './alignment'
import { threeToOne } from './residue-codes'

/** Identity threshold (over the trimmed alignment) above which two chains
 *  are considered equivalent. 95% is the standard "same protein" cutoff
 *  used by clustering tools like CD-HIT. */
export const EQUIV_THRESHOLD = 0.95

/** Water / ion residues that should never count toward the chain sequence. */
const NON_SEQ_COMPS = new Set([
  'HOH', 'WAT', 'DOD', 'H2O',
  'ZN', 'MG', 'CA', 'FE', 'MN', 'CO', 'NI', 'CU', 'NA', 'K',
  'CL', 'BR', 'SO4', 'PO4', 'NO3', 'CD', 'HG', 'SR', 'BA',
])

export interface ChainGroup {
  /** Chain ids in this group (≥ 1 element). Sorted alphabetically. */
  chainIds: string[]
  /** Representative pairwise identity (max within the group), or null for singletons. */
  identity: number | null
  /** Trimmed alignment length used to compute identity, or null for singletons. */
  alignmentLength: number | null
}

interface ChainLike {
  id: string
  residues: Array<{ compId: string }>
}

/**
 * Filter chains down to the polypeptide / nucleotide set worth aligning:
 *  - Strip water / ion residues.
 *  - Drop chains with ≤ 1 residue left.
 *  - Drop chains whose every residue maps to 'X' (glycans, heme groups, …).
 *
 * Same filter pipeline used by `SequenceViewer`, `ChainSelector`, and the
 * `AlignmentPanel` picker — kept consistent so the chain set the user sees
 * everywhere matches the set we group on.
 */
export function filterSequenceableChains<T extends ChainLike>(chains: T[]): T[] {
  return chains
    .map(c => ({
      ...c,
      residues: c.residues.filter(r => !NON_SEQ_COMPS.has(r.compId)),
    }))
    .filter(c => c.residues.length > 1)
    .filter(c => c.residues.some(r => threeToOne(r.compId) !== 'X')) as T[]
}

/**
 * Group chains by sequence equivalence. Each pair is aligned with NW + BLOSUM62,
 * then the alignment's leading/trailing gap columns are trimmed (so a copy with
 * a truncated terminus still groups), and the resulting identity is compared
 * against the threshold. Single-linkage union-find produces the groups.
 *
 * Output ordering:
 *  - Multi-member groups first, sorted by their smallest chain id.
 *  - Singletons last, sorted alphabetically.
 */
export function computeEquivalentChains(
  rawChains: ChainLike[],
  threshold: number = EQUIV_THRESHOLD,
): ChainGroup[] {
  const chains = filterSequenceableChains(rawChains)
  const n = chains.length
  if (n === 0) return []

  const sequences = chains.map(c => chainToSequence(c.residues))

  // Union-find over chain indices
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Cache every pairwise trimmed identity (alignments are O(L²); we don't
  // want to recompute when picking the group representative).
  type Pair = { i: number; j: number; identity: number; length: number }
  const pairs: Pair[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = trimmedIdentity(alignSequences(sequences[i], sequences[j]))
      pairs.push({ i, j, identity: t.identity, length: t.length })
      if (t.identity >= threshold) union(i, j)
    }
  }

  // Representative identity per group = max pairwise identity among
  // members. Singletons stay null (no intra-group pair exists).
  const groupStats = new Map<number, { identity: number; length: number }>()
  for (const p of pairs) {
    const ri = find(p.i)
    if (ri !== find(p.j)) continue
    const cur = groupStats.get(ri)
    if (!cur || p.identity > cur.identity) {
      groupStats.set(ri, { identity: p.identity, length: p.length })
    }
  }

  // Assemble groups
  const byRoot = new Map<number, string[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(chains[i].id)
  }

  const groups: ChainGroup[] = []
  for (const [root, ids] of byRoot.entries()) {
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    const stats = groupStats.get(root)
    groups.push({
      chainIds: ids,
      identity: stats ? stats.identity : null,
      alignmentLength: stats ? stats.length : null,
    })
  }

  groups.sort((a, b) => {
    const aMulti = a.chainIds.length > 1
    const bMulti = b.chainIds.length > 1
    if (aMulti !== bMulti) return aMulti ? -1 : 1
    return a.chainIds[0].localeCompare(b.chainIds[0], undefined, { numeric: true, sensitivity: 'base' })
  })

  return groups
}

/**
 * Validate / canonicalise a user-supplied manual grouping against the
 * currently available chain ids. Returns the canonical form plus any
 * problems discovered (used by the editor's Save button).
 *
 * Canonicalisation:
 *  - Trim whitespace, collapse case for matching, drop empties.
 *  - Sort each group alphabetically.
 *  - Drop empty groups entirely.
 *
 * Problems:
 *  - `duplicates`: chain ids appearing in more than one group.
 *  - `unknown`: ids not present in `availableChainIds`.
 *  - `missingFromGroups`: ids in `availableChainIds` not placed in any group
 *    (informational — these become implicit singletons).
 */
export function validateGrouping(
  groups: string[][],
  availableChainIds: string[],
): {
  canonical: string[][]
  duplicates: string[]
  unknown: string[]
  missingFromGroups: string[]
} {
  const known = new Map(availableChainIds.map(id => [id.toLowerCase(), id]))
  const seen = new Map<string, number>()  // chainId → group index
  const duplicates = new Set<string>()
  const unknown = new Set<string>()
  const canonical: string[][] = []

  for (const raw of groups) {
    const cleaned: string[] = []
    for (const item of raw) {
      const norm = item.trim()
      if (!norm) continue
      const canonId = known.get(norm.toLowerCase()) ?? norm
      if (!known.has(norm.toLowerCase())) unknown.add(canonId)
      if (seen.has(canonId)) duplicates.add(canonId)
      else seen.set(canonId, canonical.length)
      if (!cleaned.includes(canonId)) cleaned.push(canonId)
    }
    if (cleaned.length === 0) continue
    cleaned.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    canonical.push(cleaned)
  }

  const placed = new Set(canonical.flat())
  const missingFromGroups = availableChainIds.filter(id => !placed.has(id))

  return {
    canonical,
    duplicates: Array.from(duplicates),
    unknown: Array.from(unknown),
    missingFromGroups,
  }
}
