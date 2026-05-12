import { useEffect, useRef } from 'react'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'
import {
  selectResiduesInViewer,
  clearSelection,
  clearHighlight,
  clearInterfaceFocus,
  showSelectionSticks,
  clearSelectionSticks,
} from '../lib/molstar-helpers'

export function useSequenceSync() { // @dsp func-b1000002
  const plugin = useStructureStore((s) => s.plugin)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!plugin) return

    const unsub = useSelectionStore.subscribe((state, prevState) => {
      if (state._lock !== 'sequence') return

      if (state.selectedResidues !== prevState.selectedResidues) {
        // Async: delete prior interface/selection state nodes first, then
        // paint the new selection (cartoon halo + solid ball-and-stick).
        ;(async () => {
          clearSelection(plugin)
          plugin.managers.structure.focus.behaviors.current.next(undefined)
          plugin.managers.structure.focus.clear()
          try {
            await clearInterfaceFocus(plugin)
          } catch {}
          useStructureStore.getState().setFocusedChain(null)
          const residues = Array.from(state.selectedResidues.values())
          if (residues.length > 0) {
            // 1. Cartoon halo (green outline) via lociSelects
            selectResiduesInViewer(plugin, residues, 'select')
            // 2. Solid ball-and-stick sticks for the selected residues
            try { await showSelectionSticks(plugin, residues) } catch {}
          } else {
            // Empty selection — also remove any leftover sticks
            try { await clearSelectionSticks(plugin) } catch {}
          }
        })()
      }

      if (state.hoveredResidue !== prevState.hoveredResidue) {
        clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          clearHighlight(plugin)
          if (state.hoveredResidue) {
            selectResiduesInViewer(plugin, [state.hoveredResidue], 'highlight')
          }
        }, 50)
      }
    })

    return () => {
      unsub()
      clearTimeout(debounceRef.current)
    }
  }, [plugin])
}
