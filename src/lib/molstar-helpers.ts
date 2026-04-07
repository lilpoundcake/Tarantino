import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'
import { StructureSelection, QueryContext, Structure, StructureElement } from 'molstar/lib/mol-model/structure'
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder'
import { compile } from 'molstar/lib/mol-script/runtime/query/compiler'
import { StructureProperties as SP } from 'molstar/lib/mol-model/structure'
import { OrderedSet } from 'molstar/lib/mol-data/int'

export interface ResidueId {
  chainId: string
  seqId: number
}

export function getFirstStructure(plugin: PluginUIContext): Structure | undefined {
  for (const s of plugin.managers.structure.hierarchy.current.structures) {
    if (s.cell.obj?.data) {
      return s.cell.obj.data
    }
  }
  return undefined
}

/** Build a MolScript expression that selects specific residues by chain + seqId */
function buildResidueExpression(residues: ResidueId[]) {
  if (residues.length === 1) {
    return MS.struct.generator.atomGroups({
      'chain-test': MS.core.rel.eq([
        MS.struct.atomProperty.macromolecular.label_asym_id(),
        residues[0].chainId,
      ]),
      'residue-test': MS.core.rel.eq([
        MS.struct.atomProperty.macromolecular.label_seq_id(),
        residues[0].seqId,
      ]),
    })
  }

  // Group residues by chain for efficiency
  const byChain = new Map<string, number[]>()
  for (const r of residues) {
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, [])
    byChain.get(r.chainId)!.push(r.seqId)
  }

  const groups = Array.from(byChain.entries()).map(([chainId, seqIds]) =>
    MS.struct.generator.atomGroups({
      'chain-test': MS.core.rel.eq([
        MS.struct.atomProperty.macromolecular.label_asym_id(),
        chainId,
      ]),
      'residue-test': MS.core.set.has([
        MS.set(...seqIds),
        MS.struct.atomProperty.macromolecular.label_seq_id(),
      ]),
    })
  )

  return groups.length === 1 ? groups[0] : MS.struct.combinator.merge(groups)
}

/** Compute loci from a MolScript expression against a structure */
function toLoci(expression: ReturnType<typeof buildResidueExpression>, structure: Structure) {
  const compiled = compile<StructureSelection>(expression)
  const selection = compiled(new QueryContext(structure))
  return StructureSelection.toLociWithSourceUnits(selection)
}

export function selectResiduesInViewer(
  plugin: PluginUIContext,
  residues: ResidueId[],
  mode: 'select' | 'highlight' = 'select'
) {
  if (residues.length === 0) {
    if (mode === 'select') {
      plugin.managers.interactivity.lociSelects.deselectAll()
    } else {
      plugin.managers.interactivity.lociHighlights.clearHighlights()
    }
    return
  }

  const structure = getFirstStructure(plugin)
  if (!structure) return

  const expression = buildResidueExpression(residues)
  const loci = toLoci(expression, structure)

  if (mode === 'select') {
    plugin.managers.interactivity.lociSelects.select({ loci })
  } else {
    plugin.managers.interactivity.lociHighlights.highlight({ loci })
  }
}

/**
 * Focus residues in 3D — triggers Mol*'s built-in focus representation
 * which shows ball-and-stick for focused residues + surrounding context.
 * Uses the documented StructureSelectionQuery + fromSelectionQuery pattern.
 */
export function focusResiduesInViewer(plugin: PluginUIContext, residues: ResidueId[]) {
  if (residues.length === 0) {
    plugin.managers.structure.focus.clear()
    return
  }

  const structure = getFirstStructure(plugin)
  if (!structure) return

  const expression = buildResidueExpression(residues)
  const loci = toLoci(expression, structure)
  plugin.managers.structure.focus.setFromLoci(loci)

  // Extend focus with remaining residues if multi-residue
  // (setFromLoci replaces, addFromLoci accumulates)
  // Since we already built a combined expression, the loci contains all residues
}

export function clearSelection(plugin: PluginUIContext) {
  plugin.managers.interactivity.lociSelects.deselectAll()
}

export function clearHighlight(plugin: PluginUIContext) {
  plugin.managers.interactivity.lociHighlights.clearHighlights()
}

export interface ChainData {
  id: string
  entityId: string
  residues: Array<{
    seqId: number
    compId: string
  }>
}

export function extractChains(plugin: PluginUIContext): ChainData[] {
  const structure = getFirstStructure(plugin)
  if (!structure) return []

  const chainsMap = new Map<string, ChainData>()
  const loc = StructureElement.Location.create(structure)

  for (let i = 0, il = structure.units.length; i < il; i++) {
    const unit = structure.units[i]
    const { elements } = unit
    loc.unit = unit

    const seenInUnit = new Set<string>()

    for (let j = 0, jl = OrderedSet.size(elements); j < jl; j++) {
      loc.element = OrderedSet.getAt(elements, j)
      const chainId = SP.chain.label_asym_id(loc)
      const seqId = SP.residue.label_seq_id(loc)
      const compId = SP.atom.label_comp_id(loc)
      const entityId = SP.chain.label_entity_id(loc)

      const residueKey = `${chainId}:${seqId}`
      if (seenInUnit.has(residueKey)) continue
      seenInUnit.add(residueKey)

      if (!chainsMap.has(chainId)) {
        chainsMap.set(chainId, { id: chainId, entityId, residues: [] })
      }

      const chain = chainsMap.get(chainId)!
      if (!chain.residues.some(r => r.seqId === seqId)) {
        chain.residues.push({ seqId, compId })
      }
    }
  }

  for (const chain of chainsMap.values()) {
    chain.residues.sort((a, b) => a.seqId - b.seqId)
  }

  return Array.from(chainsMap.values())
}

export interface ElementData {
  chainId: string
  entityId: string
  entityType: 'polymer' | 'non-polymer' | 'water' | 'branched' | 'ion' | 'unknown'
  moleculeName: string
  compIds: string[]
  residueCount: number
  atomCount: number
}

export function extractElements(plugin: PluginUIContext): ElementData[] {
  const structure = getFirstStructure(plugin)
  if (!structure) return []

  const elemMap = new Map<string, ElementData>()
  const loc = StructureElement.Location.create(structure)
  const seenResidues = new Set<string>()

  for (let i = 0, il = structure.units.length; i < il; i++) {
    const unit = structure.units[i]
    const { elements } = unit
    loc.unit = unit

    for (let j = 0, jl = OrderedSet.size(elements); j < jl; j++) {
      loc.element = OrderedSet.getAt(elements, j)
      const chainId = SP.chain.label_asym_id(loc)
      const entityId = SP.chain.label_entity_id(loc)
      const compId = SP.atom.label_comp_id(loc)

      if (!elemMap.has(chainId)) {
        const eType = SP.entity.type(loc) as string
        const eSubtype = SP.entity.subtype(loc) as string
        const descArr = SP.entity.pdbx_description(loc)
        const desc = Array.isArray(descArr) ? descArr.join(', ') : ''

        let entityType: ElementData['entityType'] = 'unknown'
        if (eType === 'water') entityType = 'water'
        else if (eType === 'polymer') entityType = 'polymer'
        else if (eType === 'branched') entityType = 'branched'
        else if (eType === 'non-polymer') entityType = eSubtype === 'ion' ? 'ion' : 'non-polymer'

        elemMap.set(chainId, {
          chainId, entityId, entityType,
          moleculeName: desc || compId,
          compIds: [], residueCount: 0, atomCount: 0,
        })
      }

      const elem = elemMap.get(chainId)!
      elem.atomCount++

      const resKey = `${chainId}:${SP.residue.label_seq_id(loc)}:${compId}`
      if (!seenResidues.has(resKey)) {
        seenResidues.add(resKey)
        elem.residueCount++
        if (!elem.compIds.includes(compId)) elem.compIds.push(compId)
      }
    }
  }

  return Array.from(elemMap.values()).sort((a, b) => {
    const order: Record<string, number> = { polymer: 0, 'non-polymer': 1, ion: 2, branched: 3, water: 4, unknown: 5 }
    return (order[a.entityType] ?? 5) - (order[b.entityType] ?? 5) || a.chainId.localeCompare(b.chainId)
  })
}

export function extractMeta(plugin: PluginUIContext): { name: string; method: string } {
  const structure = getFirstStructure(plugin)
  if (!structure) return { name: '', method: '' }

  const model = structure.models[0]
  if (!model) return { name: '', method: '' }

  return { name: model.entry || model.entryId || '', method: '' }
}

/**
 * Select a single chain in the 3D viewer and focus on it.
 * Uses MolScript query against the root structure.
 */
export function selectChainInViewer(plugin: PluginUIContext, chainId: string) {
  const structure = getFirstStructure(plugin)
  if (!structure) return

  const expression = MS.struct.generator.atomGroups({
    'chain-test': MS.core.rel.eq([
      MS.struct.atomProperty.macromolecular.label_asym_id(),
      chainId,
    ]),
  })

  const loci = toLoci(expression, structure)

  plugin.managers.interactivity.lociSelects.deselectAll()
  plugin.managers.interactivity.lociSelects.select({ loci })
  plugin.managers.structure.focus.setFromLoci(loci)
}
