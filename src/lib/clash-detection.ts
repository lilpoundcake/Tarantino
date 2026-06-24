/**
 * Steric-clash detection for a loaded Mol* structure.
 *
 * Criterion: van-der-Waals overlap = (rA + rB) − distance(A, B). A pair
 * is reported when overlap > minOverlap (default 0.4 Å). Two severity
 * tiers (PyMOL / ChimeraX / MolProbity convention):
 *   - bad:    0.4 Å < overlap ≤ 0.9 Å
 *   - severe: overlap > 0.9 Å
 *
 * Excluded pairs (every clash-detection tool excludes these):
 *   - Bonded neighbors (1-2) within the same unit
 *   - 1-3 neighbors within the same unit (atoms sharing a bonded neighbor;
 *     they're close by ring/angle topology, not by clash)
 *   - Same-residue pairs (1-4 ring atoms and rotamer geometry produce
 *     overlaps that aren't real clashes — engineered structures with
 *     genuinely bad rotamers will still surface cross-residue clashes)
 *   - Hydrogens (often missing or placed approximately)
 *   - Water molecules (HOH / WAT etc. — close packing in crystal envs)
 *
 * For inter-unit pairs (cross-asymmetric-unit, NCS) we currently only
 * apply the same-residue / water filters; bonded inter-unit edges are
 * rare and produce false positives rather than missed clashes.
 */

import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'
import { StructureElement, StructureProperties as SP } from 'molstar/lib/mol-model/structure'

// Bondi 1964 + Rowland & Taylor 1996 VdW radii for common elements (Å).
// MolProbity / PyMOL use a similar set. Fallback for missing entries: 1.70 (C).
const VDW: Record<string, number> = {
  H: 1.20, D: 1.20,
  C: 1.70, N: 1.55, O: 1.52, F: 1.47,
  P: 1.80, S: 1.80, Cl: 1.75, Br: 1.85, I: 1.98,
  Na: 2.27, Mg: 1.73, K: 2.75, Ca: 2.31,
  Mn: 1.97, Fe: 1.94, Co: 1.92, Ni: 1.84, Cu: 1.40, Zn: 1.39,
  Se: 1.90,
}
const DEFAULT_VDW = 1.70
const MAX_VDW = 2.00          // upper bound for neighbor-search radius
const WATER_COMPS = new Set(['HOH', 'WAT', 'DOD', 'H2O'])

export interface Clash {
  /** Stable id for React keys — built from unit ids + element indices. */
  id: string
  chainA: string
  resIdA: number
  resNameA: string
  atomA: string
  chainB: string
  resIdB: number
  resNameB: string
  atomB: string
  distance: number       // Å
  overlap: number        // Å, always > minOverlap
  severity: 'bad' | 'severe'
}

export interface ClashOptions {
  /** Minimum overlap (Å) for a pair to be reported. Default 0.4. */
  minOverlap?: number
  /** Threshold for the 'severe' tier. Default 0.9 (matches ChimeraX). */
  severeThreshold?: number
}

export function computeClashes(plugin: PluginUIContext, opts: ClashOptions = {}): Clash[] {
  const minOverlap = opts.minOverlap ?? 0.4
  const severeThreshold = opts.severeThreshold ?? 0.9
  const structure = plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data
  if (!structure) return []

  const out: Clash[] = []
  const seen = new Set<string>()                  // dedup pair keys
  const locA = StructureElement.Location.create(structure)
  const locB = StructureElement.Location.create(structure)
  const searchR = 2 * MAX_VDW - minOverlap        // ~3.6 Å covers any real overlap

  for (const unitA of structure.units) {
    const elementsA = unitA.elements
    const confA = unitA.conformation
    locA.unit = unitA
    // IntraUnitBonds — atomic units have a bond graph; coarse / branched
    // units may not. Guard defensively.
    const bondsA: any = (unitA as any).bonds
    const offset: ArrayLike<number> | undefined = bondsA?.offset
    const bArr: ArrayLike<number> | undefined = bondsA?.b

    for (let aIdx = 0; aIdx < elementsA.length; aIdx++) {
      const eA: any = elementsA[aIdx]
      locA.element = eA
      const symA = SP.atom.type_symbol(locA) as string
      if (symA === 'H' || symA === 'D') continue
      const compA = SP.atom.label_comp_id(locA) as string
      if (WATER_COMPS.has(compA)) continue
      const rA = VDW[symA] ?? DEFAULT_VDW
      const px = confA.x(eA), py = confA.y(eA), pz = confA.z(eA)

      // Precompute bonded + 1-3 sets for this atom (intra-unit).
      let bonded: Set<number> | null = null
      let oneThree: Set<number> | null = null
      if (offset && bArr) {
        bonded = new Set()
        oneThree = new Set()
        const start = offset[aIdx]
        const end = offset[aIdx + 1]
        for (let k = start; k < end; k++) {
          const cIdx = bArr[k]
          bonded.add(cIdx)
          const cStart = offset[cIdx]
          const cEnd = offset[cIdx + 1]
          for (let kk = cStart; kk < cEnd; kk++) {
            oneThree.add(bArr[kk])
          }
        }
      }

      const result = structure.lookup3d.find(px, py, pz, searchR)
      for (let i = 0; i < result.count; i++) {
        const unitB = result.units[i]
        const bIdx = result.indices[i]
        if (unitA === unitB && aIdx === bIdx) continue

        // Canonical-ordered dedup key
        const keyA = `${unitA.id}.${aIdx}`
        const keyB = `${unitB.id}.${bIdx}`
        const pairKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`
        if (seen.has(pairKey)) continue

        // Intra-unit exclusions: bonded, 1-3, same residue
        if (unitA === unitB) {
          if (bonded?.has(bIdx) || oneThree?.has(bIdx)) { seen.add(pairKey); continue }
          // Same-residue → skip (ring topology + rotamer pairs look like clashes)
          const residueIdx = (unitA as any).residueIndex as ArrayLike<number> | undefined
          if (residueIdx) {
            const eAFull = elementsA[aIdx]
            const eBFull = elementsA[bIdx]
            if (residueIdx[eAFull] === residueIdx[eBFull]) { seen.add(pairKey); continue }
          }
        }

        const eB: any = unitB.elements[bIdx]
        locB.unit = unitB
        locB.element = eB
        const symB = SP.atom.type_symbol(locB) as string
        if (symB === 'H' || symB === 'D') { seen.add(pairKey); continue }
        const compB = SP.atom.label_comp_id(locB) as string
        if (WATER_COMPS.has(compB)) { seen.add(pairKey); continue }
        const rB = VDW[symB] ?? DEFAULT_VDW
        const dist = Math.sqrt(result.squaredDistances[i])
        const overlap = (rA + rB) - dist
        if (overlap <= minOverlap) { seen.add(pairKey); continue }

        seen.add(pairKey)

        out.push({
          id: pairKey,
          chainA: SP.chain.label_asym_id(locA) as string,
          resIdA: SP.residue.label_seq_id(locA) as number,
          resNameA: compA,
          atomA: SP.atom.label_atom_id(locA) as string,
          chainB: SP.chain.label_asym_id(locB) as string,
          resIdB: SP.residue.label_seq_id(locB) as number,
          resNameB: compB,
          atomB: SP.atom.label_atom_id(locB) as string,
          distance: dist,
          overlap,
          severity: overlap > severeThreshold ? 'severe' : 'bad',
        })
      }
    }
  }

  // Worst clashes first.
  out.sort((a, b) => b.overlap - a.overlap)
  return out
}
