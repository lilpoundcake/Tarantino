import { useEffect, useRef } from 'react'
import { StructureElement } from 'molstar/lib/mol-model/structure'
import { StructureProperties as SP } from 'molstar/lib/mol-model/structure'
import { OrderedSet } from 'molstar/lib/mol-data/int'
import { Loci } from 'molstar/lib/mol-model/loci'
import { clearInterfaceFocus, clearSelectionSticks } from '../lib/molstar-helpers'
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
      // CRITICAL: this provider is one entry in a sequential list driven by
      // LociMarkManager.mark(). If we throw here, the next provider (the
      // default canvas3d marker provider that actually clears the green
      // halo from the renderer's marker buffer) never runs — and the halo
      // persists. Wrap everything in try/catch and do ZERO state mutation
      // that could re-enter Mol* (no focus.clear, no plugin.runTask).
      try {
        if (useSelectionStore.getState().isLocked('structure')) return

        const residues: ResidueId[] = []
        plugin.managers.structure.selection.entries.forEach((entry) => {
          const loci = entry.selection
          if (!StructureElement.Loci.is(loci)) return
          const loc = StructureElement.Location.create(loci.structure)
          for (const e of loci.elements) {
            loc.unit = e.unit
            const size = OrderedSet.size(e.indices)
            for (let i = 0; i < size; i++) {
              loc.element = e.unit.elements[OrderedSet.getAt(e.indices, i)]
              let entityType: string
              try { entityType = SP.entity.type(loc) as string } catch { continue }
              if (entityType !== 'polymer') continue
              const chainId = SP.chain.label_asym_id(loc)
              const seqId = SP.residue.label_seq_id(loc)
              if (!residues.some(r => r.chainId === chainId && r.seqId === seqId)) {
                residues.push({ chainId, seqId })
              }
            }
          }
        })

        // Empty Mol* selection from upstream: don't broadcast empty to the
        // store (preserves sequence-panel highlights). Focus/halo cleanup
        // happens in the click handler below — NOT here, to keep this
        // provider side-effect-free during the mark fan-out.
        if (residues.length === 0) return

        select(residues, 'structure')
      } catch (err) {
        console.warn('[tarantino] selProvider error (ignored):', err)
      }
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

    // Click on empty 3D space → force-clear ALL 3D markers (Mol*'s default
    // selectColor is bright green #33FF1A, so the "green halo" the user sees
    // is the lociSelects selection marker, NOT only the focus representation).
    // Be aggressive: clear selection, highlights, and focus state nodes.
    const clickSub = plugin.behaviors.interaction.click.subscribe((event) => {
      if (Loci.isEmpty(event.current.loci)) {
        plugin.managers.interactivity.lociSelects.deselectAll()
        plugin.managers.interactivity.lociHighlights.clearHighlights()
        plugin.managers.structure.focus.behaviors.current.next(undefined)
        plugin.managers.structure.focus.clear()
        clearInterfaceFocus(plugin).catch(() => {})
        clearSelectionSticks(plugin).catch(() => {})
        useStructureStore.getState().setFocusedChain(null)
      }
    })

    return () => {
      if (providerRef.current) {
        plugin.managers.interactivity.lociSelects.removeProvider(providerRef.current)
        providerRef.current = null
      }
      hoverSub.unsubscribe()
      clickSub.unsubscribe()
      clearTimeout(debounceRef.current)
    }
  }, [plugin, select, hover])
}
