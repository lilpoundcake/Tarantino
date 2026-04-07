import { create } from 'zustand'

export interface ResidueId {
  chainId: string
  seqId: number
}

function residueKey(r: ResidueId): string {
  return `${r.chainId}:${r.seqId}`
}

interface SelectionState {
  selectedResidues: Map<string, ResidueId>
  hoveredResidue: ResidueId | null
  // Lock to prevent feedback loops between sync hooks
  _lock: 'structure' | 'sequence' | null
  _lockTime: number

  select: (residues: ResidueId[], source: 'structure' | 'sequence') => void
  toggleSelect: (residue: ResidueId, source: 'structure' | 'sequence') => void
  selectRange: (residues: ResidueId[], source: 'structure' | 'sequence') => void
  hover: (residue: ResidueId | null, source: 'structure' | 'sequence') => void
  clearSelection: () => void
  isLocked: (by: 'structure' | 'sequence') => boolean
}

export const useSelectionStore = create<SelectionState>((set, get) => ({ // @dsp obj-a1000009
  selectedResidues: new Map(),
  hoveredResidue: null,
  _lock: null,
  _lockTime: 0,

  isLocked: (by) => {
    const state = get()
    // Lock expires after 200ms
    if (state._lock && state._lock !== by && Date.now() - state._lockTime < 200) {
      return true
    }
    return false
  },

  select: (residues, source) => {
    const map = new Map<string, ResidueId>()
    for (const r of residues) {
      map.set(residueKey(r), r)
    }
    set({ selectedResidues: map, _lock: source, _lockTime: Date.now() })
  },

  toggleSelect: (residue, source) => {
    const current = new Map(get().selectedResidues)
    const key = residueKey(residue)
    if (current.has(key)) {
      current.delete(key)
    } else {
      current.set(key, residue)
    }
    set({ selectedResidues: current, _lock: source, _lockTime: Date.now() })
  },

  selectRange: (residues, source) => {
    const map = new Map<string, ResidueId>()
    for (const r of residues) {
      map.set(residueKey(r), r)
    }
    set({ selectedResidues: map, _lock: source, _lockTime: Date.now() })
  },

  hover: (residue, source) => {
    set({ hoveredResidue: residue, _lock: source, _lockTime: Date.now() })
  },

  clearSelection: () => {
    set({ selectedResidues: new Map(), _lock: null, _lockTime: 0 })
  },
}))
