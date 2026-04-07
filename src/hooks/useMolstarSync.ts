import { useEffect, useRef } from 'react'
import { StructureElement } from 'molstar/lib/mol-model/structure'
import { StructureProperties as SP } from 'molstar/lib/mol-model/structure'
import { OrderedSet } from 'molstar/lib/mol-data/int'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore, type ResidueId } from '../stores/selectionStore'
import type { InteractivityManager } from 'molstar/lib/mol-plugin-state/manager/interactivity'

export function useMolstarSync() { // @dsp func-b1000001
  const plugin = useStructureStore((s) => s.plugin)
  const select = useSelectionStore((s) => s.select)
  const hover = useSelectionStore((s) => s.hover)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const providerRef = useRef<InteractivityManager.LociMarkProvider | null>(null)

  useEffect(() => {
    if (!plugin) return

    const selProvider: InteractivityManager.LociMarkProvider = () => {
      // Skip if sequence just acted (lock-based anti-loop)
      if (useSelectionStore.getState().isLocked('structure')) return

      const residues: ResidueId[] = []
      plugin.managers.structure.selection.entries.forEach((entry) => {
        const loci = entry.selection
        if (StructureElement.Loci.is(loci)) {
          const loc = StructureElement.Location.create(loci.structure)
          for (const e of loci.elements) {
            loc.unit = e.unit
            const size = OrderedSet.size(e.indices)
            for (let i = 0; i < size; i++) {
              loc.element = e.unit.elements[OrderedSet.getAt(e.indices, i)]
              // Only include polymer residues (skip water, ions, ligands)
              const entityType = SP.entity.type(loc)
              if (entityType !== 'polymer') continue
              const chainId = SP.chain.label_asym_id(loc)
              const seqId = SP.residue.label_seq_id(loc)
              if (!residues.some(r => r.chainId === chainId && r.seqId === seqId)) {
                residues.push({ chainId, seqId })
              }
            }
          }
        }
      })

      select(residues, 'structure')
    }

    providerRef.current = selProvider
    plugin.managers.interactivity.lociSelects.addProvider(selProvider)

    const hoverSub = plugin.behaviors.interaction.hover.subscribe((event) => {
      if (useSelectionStore.getState().isLocked('structure')) return

      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const { current } = event
        if (StructureElement.Loci.is(current.loci)) {
          const loci = current.loci
          if (loci.elements.length > 0) {
            const e = loci.elements[0]
            const loc = StructureElement.Location.create(loci.structure)
            loc.unit = e.unit
            loc.element = e.unit.elements[OrderedSet.getAt(e.indices, 0)]
            hover({ chainId: SP.chain.label_asym_id(loc), seqId: SP.residue.label_seq_id(loc) }, 'structure')
            return
          }
        }
        hover(null, 'structure')
      }, 50)
    })

    return () => {
      if (providerRef.current) {
        plugin.managers.interactivity.lociSelects.removeProvider(providerRef.current)
        providerRef.current = null
      }
      hoverSub.unsubscribe()
      clearTimeout(debounceRef.current)
    }
  }, [plugin, select, hover])
}
