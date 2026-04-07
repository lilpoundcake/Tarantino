import { useEffect, useRef } from 'react'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'
import {
  selectResiduesInViewer,
  clearSelection,
  clearHighlight,
} from '../lib/molstar-helpers'

export function useSequenceSync() { // @dsp func-b1000002
  const plugin = useStructureStore((s) => s.plugin)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!plugin) return

    const unsub = useSelectionStore.subscribe((state, prevState) => {
      if (state._lock !== 'sequence') return

      if (state.selectedResidues !== prevState.selectedResidues) {
        clearSelection(plugin)
        plugin.managers.structure.focus.clear()
        const residues = Array.from(state.selectedResidues.values())
        if (residues.length > 0) {
          selectResiduesInViewer(plugin, residues, 'select')
        }
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
