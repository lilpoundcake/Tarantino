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
import { StructureElement, StructureProperties as SP, type Structure, type Unit } from 'molstar/lib/mol-model/structure'

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

/**
 * Collect 1-2 and 1-3 neighbors of an atom across the FULL bond graph
 * (intra-unit `unit.bonds` + inter-unit `structure.interUnitBonds`).
 *
 * Returns string keys `${unitId}.${atomIdx}` so callers can match against
 * the same key shape used for dedup. Inter-unit edges matter because:
 *   - Glycosidic bonds between sugar non-polymer units (each sugar = its
 *     own unit) live in interUnitBonds; the C1–O bond and the C1–C2
 *     1-3-across-the-bridge geometry both look like severe clashes
 *     without this exclusion.
 *   - Inter-chain disulfides (heavy ↔ light SG–SG) likewise.
 */
function gatherNeighbors(
  structure: Structure,
  unit: Unit,
  atomIdx: number,
): { bonded: Set<string>; oneThree: Set<string> } {
  const bonded = new Set<string>()
  const oneThree = new Set<string>()
  const selfKey = `${unit.id}.${atomIdx}`

  const collectIntra = (u: Unit, idx: number, sink: Set<string>) => {
    const b: any = (u as any).bonds
    if (!b?.offset || !b?.b) return
    const start = b.offset[idx]
    const end = b.offset[idx + 1]
    for (let k = start; k < end; k++) sink.add(`${u.id}.${b.b[k]}`)
  }
  const collectInter = (u: Unit, idx: number, sink: Set<string>) => {
    const edgeIndices = structure.interUnitBonds.getEdgeIndices(idx as any, u.id)
    if (!edgeIndices) return
    for (let i = 0; i < edgeIndices.length; i++) {
      const e: any = (structure.interUnitBonds as any).edges[edgeIndices[i]]
      if (e.unitA === u.id && e.indexA === idx) sink.add(`${e.unitB}.${e.indexB}`)
      else sink.add(`${e.unitA}.${e.indexA}`)
    }
  }

  // 1-2 neighbors
  collectIntra(unit, atomIdx, bonded)
  collectInter(unit, atomIdx, bonded)

  // 1-3 neighbors: for each 1-2 neighbor, gather ITS 1-2 neighbors.
  for (const nKey of bonded) {
    const dot = nKey.indexOf('.')
    const nUnitId = Number(nKey.slice(0, dot))
    const nIdx = Number(nKey.slice(dot + 1))
    const nUnit = structure.unitMap.get(nUnitId as any) as Unit | undefined
    if (!nUnit) continue
    collectIntra(nUnit, nIdx, oneThree)
    collectInter(nUnit, nIdx, oneThree)
  }
  oneThree.delete(selfKey)
  for (const k of bonded) oneThree.delete(k)
  return { bonded, oneThree }
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

    for (let aIdx = 0; aIdx < elementsA.length; aIdx++) {
      const eA: any = elementsA[aIdx]
      locA.element = eA
      const symA = SP.atom.type_symbol(locA) as string
      if (symA === 'H' || symA === 'D') continue
      const compA = SP.atom.label_comp_id(locA) as string
      if (WATER_COMPS.has(compA)) continue
      const rA = VDW[symA] ?? DEFAULT_VDW
      const px = confA.x(eA), py = confA.y(eA), pz = confA.z(eA)

      // Bonded + 1-3 neighbors across the FULL bond graph (intra + inter).
      // Keyed by `${unitId}.${atomIdx}` so we can match candidate pairs
      // regardless of which unit they live in.
      const { bonded, oneThree } = gatherNeighbors(structure, unitA, aIdx)

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

        // Exclude 1-2 / 1-3 across the full graph (handles glycosidic bonds,
        // inter-chain disulfides, and intra-unit standard bonds uniformly).
        if (bonded.has(keyB) || oneThree.has(keyB)) { seen.add(pairKey); continue }

        // Same-residue → skip (ring topology + rotamer pairs look like clashes).
        if (unitA === unitB) {
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
