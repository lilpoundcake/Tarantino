import { create } from 'zustand'
import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'

export interface ChainInfo {
  id: string
  entityId: string
  residues: Array<{
    seqId: number
    compId: string
  }>
}

export interface ElementInfo {
  chainId: string
  entityId: string
  entityType: 'polymer' | 'non-polymer' | 'water' | 'branched' | 'ion' | 'unknown'
  moleculeName: string
  compIds: string[]
  residueCount: number
  atomCount: number
}

export interface StructureMeta {
  name: string
  organism: string
  method: string
  resolution: string
  description: string
}

interface StructureState {
  plugin: PluginUIContext | null
  chains: ChainInfo[]
  elements: ElementInfo[]
  activeChainId: string | null
  fileName: string | null
  isLoading: boolean
  error: string | null
  meta: StructureMeta
  /** Chain currently inspected via the Elements interface action. Filters InteractionsPanel. */
  focusedChainId: string | null
  /** Entity category of the focused chain ('polymer' | 'ligand' | 'ion' | 'water' | 'other'). */
  focusedCategory: string | null

  setPlugin: (plugin: PluginUIContext | null) => void
  setChains: (chains: ChainInfo[]) => void
  setElements: (elements: ElementInfo[]) => void
  setActiveChain: (chainId: string) => void
  setFileName: (name: string | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setMeta: (meta: Partial<StructureMeta>) => void
  setFocusedChain: (chainId: string | null, category?: string | null) => void
  reset: () => void
}

const defaultMeta: StructureMeta = {
  name: '',
  organism: '',
  method: '',
  resolution: '',
  description: '',
}

export const useStructureStore = create<StructureState>((set, get) => ({ // @dsp obj-a100000a
  plugin: null,
  chains: [],
  elements: [],
  activeChainId: null,
  fileName: null,
  isLoading: false,
  error: null,
  meta: { ...defaultMeta },
  focusedChainId: null,
  focusedCategory: null,

  setPlugin: (plugin) => set({ plugin }),
  setChains: (chains) => {
    set({
      chains,
      activeChainId: chains.length > 0 ? chains[0].id : null,
    })
  },
  setElements: (elements) => set({ elements }),
  setActiveChain: (chainId) => set({ activeChainId: chainId }),
  setFileName: (name) => set({ fileName: name }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  setMeta: (partial) => set({ meta: { ...get().meta, ...partial } }),
  setFocusedChain: (chainId, category = null) => set({
    focusedChainId: chainId,
    focusedCategory: chainId === null ? null : category,
  }),
  reset: () => set({
    chains: [],
    elements: [],
    activeChainId: null,
    fileName: null,
    isLoading: false,
    error: null,
    meta: { ...defaultMeta },
    focusedChainId: null,
    focusedCategory: null,
  }),
}))
