import { alignSequences, chainToSequence, trimmedIdentity } from './alignment'
import { HC_REFS, LC_REFS, type HCSubclass, type LCSubclass, type CHRef } from './antibody-references'

export type { HCSubclass, LCSubclass }

export type ChainType = 'HC' | 'LC' | 'not-antibody'
export type Region = 'full' | 'Fab-HC' | 'Fc' | 'VH-only' | 'VL-only' | 'scFv' | 'VHH' | 'LC' | 'partial'

export interface AntibodyClassification {
  type: ChainType
  subclass: HCSubclass | LCSubclass | null
  region: Region
  identity: number
  alignmentLength: number
  margin: number
  domainsObserved: { CH1?: boolean; hinge?: boolean; CH2?: boolean; CH3?: boolean; V?: boolean }
  warnings: string[]
}

const ID_MIN = 0.70
const VHH_MIN = 0.55
const MARGIN_MIN = 0.05
const DOMAIN_COVERAGE_MIN = 0.60   // fraction of the reference domain that needs to align

interface ChainResidue { seqId: number; compId: string; present?: boolean }

/**
 * Classify a single chain. Returns null if the input isn't a polymer or is
 * too short to bother aligning. Otherwise always returns a classification —
 * `type: 'not-antibody'` if no reference clears the threshold.
 */
export function identifyAntibodyChain(residues: ChainResidue[]): AntibodyClassification | null {
  if (residues.length < 20) return null
  const seq = chainToSequence(residues)
  if (!seq || seq.replace(/X/g, '').length < 20) return null

  // Score every reference. We compute trimmed identity (ignores flanking
  // gaps — see lib/alignment.ts) which is the right metric when a chain
  // may be a partial fragment (Fc-only, Fab-only).
  const hcHits = (Object.keys(HC_REFS) as HCSubclass[]).map(sub => {
    const ref = HC_REFS[sub]
    const a = alignSequences(seq, ref.sequence)
    const t = trimmedIdentity(a)
    return { kind: 'HC' as const, subclass: sub, ref, alignment: a, ...t }
  })
  const lcHits = (Object.keys(LC_REFS) as LCSubclass[]).map(sub => {
    const ref = LC_REFS[sub]
    const a = alignSequences(seq, ref.sequence)
    const t = trimmedIdentity(a)
    return { kind: 'LC' as const, subclass: sub, ref, alignment: a, ...t }
  })

  const sortedHC = [...hcHits].sort((a, b) => b.identity - a.identity)
  const sortedLC = [...lcHits].sort((a, b) => b.identity - a.identity)
  const bestHC = sortedHC[0]
  const bestLC = sortedLC[0]
  const secondHC = sortedHC[1] ?? { identity: 0 }
  const secondLC = sortedLC[1] ?? { identity: 0 }

  // Decide between HC, LC, or not-antibody. Compare the two class winners.
  const hcWins = bestHC.identity >= bestLC.identity
  const top = hcWins ? bestHC : bestLC
  const margin = hcWins ? bestHC.identity - secondHC.identity : bestLC.identity - secondLC.identity

  if (top.identity < VHH_MIN) {
    return {
      type: 'not-antibody', subclass: null, region: 'partial',
      identity: top.identity, alignmentLength: top.length, margin,
      domainsObserved: {}, warnings: [],
    }
  }

  const warnings: string[] = []
  if (top.identity < ID_MIN) warnings.push(`Low identity (${(top.identity * 100).toFixed(1)}%) — possible engineered or non-human antibody.`)
  if (margin < MARGIN_MIN) warnings.push(`Ambiguous subclass — runner-up within ${MARGIN_MIN} identity.`)

  if (top.kind === 'HC') {
    const domains = detectHCDomains(top.alignment.alignedA, top.alignment.alignedB, top.ref)
    const region = classifyHCRegion(domains, seq.length)
    return {
      type: 'HC', subclass: top.subclass, region,
      identity: top.identity, alignmentLength: top.length, margin,
      domainsObserved: domains, warnings,
    }
  } else {
    // LC: detect VL by checking unmatched leading residues.
    const leadingUnmatched = countLeadingUnmatchedChainResidues(top.alignment.alignedA, top.alignment.alignedB)
    const hasV = leadingUnmatched >= 70 // VL framework is ~107 aa
    const region: Region = hasV ? 'LC' : 'partial'
    return {
      type: 'LC', subclass: top.subclass, region,
      identity: top.identity, alignmentLength: top.length, margin,
      domainsObserved: { V: hasV },
      warnings,
    }
  }
}

/**
 * Map an EU position to the author-residue-id in this chain. Returns null
 * if the chain isn't an HC or the position is outside the aligned span.
 * `observed: false` means the residue is in SEQRES but missing from ATOM
 * coordinates (disordered loop).
 *
 * NB: This is for *frontend* validation only. The actual mutation pipeline
 * runs `dvbfixer renumber --scheme EU` first, after which the residue IDs
 * in the renumbered PDB ARE the EU numbers and `--mutate H:322:ALA` works
 * directly. The JS mapping here lets the UI say "EU 322 isn't in this
 * Fc-only fragment" before submitting the run.
 */
export function mapEuToAuthSeqId(
  residues: ChainResidue[],
  euNumber: number,
  cls: AntibodyClassification,
): { authSeqId: number; observed: boolean } | null {
  if (cls.type !== 'HC' || !cls.subclass) return null
  const ref = HC_REFS[cls.subclass as HCSubclass]
  if (!ref) return null
  const seq = chainToSequence(residues)
  const aln = alignSequences(seq, ref.sequence)

  // Walk the alignment, maintain refEu (counts only ungapped ref columns)
  // and chainIdx (counts only ungapped chain columns). When refEu hits the
  // target, return the chain residue (or, if a chain-side gap, indicate
  // not-observed).
  let refEu = ref.euStart
  let chainIdx = 0
  for (let i = 0; i < aln.alignedA.length; i++) {
    const chainCh = aln.alignedA[i]
    const refCh = aln.alignedB[i]
    if (refCh !== '-' && chainCh !== '-' && refEu === euNumber) {
      const r = residues[chainIdx]
      return { authSeqId: r.seqId, observed: r.present !== false }
    }
    if (refCh !== '-' && chainCh === '-' && refEu === euNumber) {
      // Position exists in reference but is a gap in the chain. The user's
      // mutation targets a residue the structure doesn't have.
      return null
    }
    if (refCh !== '-') refEu++
    if (chainCh !== '-') chainIdx++
  }
  return null
}

const MUT_RE = /^([A-Z])(\d+)([A-Z]|del)$/i

/** Parse a single token like 'K322A' or 'G446del'. */
export function parseMutation(s: string):
  | { fromAA: string; position: number; toAA: string; kind: 'sub' | 'del' } | null {
  const m = s.trim().match(MUT_RE)
  if (!m) return null
  const fromAA = m[1].toUpperCase()
  const position = parseInt(m[2], 10)
  const tail = m[3].toLowerCase()
  if (tail === 'del') return { fromAA, position, toAA: 'del', kind: 'del' }
  return { fromAA, position, toAA: m[3].toUpperCase(), kind: 'sub' }
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Inspect the alignment between chain and HC reference to figure out which
 * EU domain windows (CH1/hinge/CH2/CH3) have at least DOMAIN_COVERAGE_MIN
 * of their reference span aligned (any non-gap match) on the chain side.
 */
function detectHCDomains(alignedChain: string, alignedRef: string, ref: CHRef): AntibodyClassification['domainsObserved'] {
  const presence = {
    CH1: countPairedInRefSpan(alignedChain, alignedRef, ref.euStart, ref.domains.CH1[0], ref.domains.CH1[1]),
    hinge: countPairedInRefSpan(alignedChain, alignedRef, ref.euStart, ref.domains.hinge[0], ref.domains.hinge[1]),
    CH2: countPairedInRefSpan(alignedChain, alignedRef, ref.euStart, ref.domains.CH2[0], ref.domains.CH2[1]),
    CH3: countPairedInRefSpan(alignedChain, alignedRef, ref.euStart, ref.domains.CH3[0], ref.domains.CH3[1]),
  }
  // Detect VH: did the chain align to the reference at all, and does the
  // chain have a substantial unmatched leading segment? VH frameworks are
  // ~120 aa.
  const leading = countLeadingUnmatchedChainResidues(alignedChain, alignedRef)
  const V = leading >= 80
  return {
    CH1: presence.CH1.fraction >= DOMAIN_COVERAGE_MIN,
    hinge: presence.hinge.fraction >= 0.40,             // hinge is short, looser threshold
    CH2: presence.CH2.fraction >= DOMAIN_COVERAGE_MIN,
    CH3: presence.CH3.fraction >= DOMAIN_COVERAGE_MIN,
    V,
  }
}

function classifyHCRegion(d: AntibodyClassification['domainsObserved'], _chainLen: number): Region {
  const fullC = d.CH1 && d.CH2 && d.CH3
  if (d.V && fullC) return 'full'
  if (d.V && d.CH1 && !d.CH2 && !d.CH3) return 'Fab-HC'
  if (!d.V && d.CH2 && d.CH3 && !d.CH1) return 'Fc'
  if (d.V && !d.CH1 && !d.CH2 && !d.CH3) return 'VH-only'
  if (d.V && d.CH2 && d.CH3) return 'scFv'             // VH + Fc-like = scFv-Fc fusion or unusual construct
  return 'partial'
}

function countPairedInRefSpan(
  alignedChain: string, alignedRef: string,
  euStart: number, fromEu: number, toEu: number,
): { matched: number; refLen: number; fraction: number } {
  let refEu = euStart
  let matched = 0
  let refLen = 0
  for (let i = 0; i < alignedRef.length; i++) {
    const refCh = alignedRef[i]
    if (refCh === '-') continue
    if (refEu >= fromEu && refEu <= toEu) {
      refLen++
      if (alignedChain[i] !== '-') matched++
    }
    refEu++
  }
  return { matched, refLen, fraction: refLen === 0 ? 0 : matched / refLen }
}

function countLeadingUnmatchedChainResidues(alignedChain: string, alignedRef: string): number {
  // Count chain residues before the first column where both align.
  let count = 0
  for (let i = 0; i < alignedChain.length; i++) {
    if (alignedChain[i] !== '-' && alignedRef[i] !== '-') return count
    if (alignedChain[i] !== '-') count++
  }
  return count
}

/* ────────────────────────────────────────────────────────────────────────
 * Mutation expansion (frontend-side preview of what the backend will emit)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 1-letter → 3-letter amino acid code, used to build the `--mutate` arg
 * string that matches DVBFixer's expected `CHAIN:RESNUM:NEW_AA3` format.
 */
export const AA1_TO_AA3: Record<string, string> = {
  A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS',
  E: 'GLU', Q: 'GLN', G: 'GLY', H: 'HIS', I: 'ILE',
  L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO',
  S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL',
}

/** Build a single `--mutate` value from a parsed mutation + target chain id. */
export function mutateArgFor(chainId: string, m: { position: number; toAA: string; kind: 'sub' | 'del' }): string {
  if (m.kind === 'del') return `${chainId}:${m.position}:del`
  const aa3 = AA1_TO_AA3[m.toAA]
  if (!aa3) throw new Error(`Unknown 1-letter amino acid: ${m.toAA}`)
  return `${chainId}:${m.position}:${aa3}`
}
