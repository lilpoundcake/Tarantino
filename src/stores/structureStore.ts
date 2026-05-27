import { create } from 'zustand'
import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'

export interface ChainInfo {
  id: string
  entityId: string
  residues: Array<{
    seqId: number
    compId: string
    /** False if the residue exists in the PDB SEQRES block but is absent
     *  from the ATOM records (disordered loop, missing terminus, etc.). */
    present?: boolean
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
  /** Manual override of the equivalent-chain grouping shown in the Info
   *  panel. Each inner array is one group of chain ids. `undefined` →
   *  auto-detect via sequence identity (no persisted override). An empty
   *  outer array is a valid override meaning "force no grouping". */
  equivalentChains?: string[][]
}

export type ViewerSlot = 'primary' | 'secondary'

interface StructureState {
  /** Primary 3D viewer plugin. Drives Sequence, Elements, Interactions, Info, Alignment. */
  plugin: PluginUIContext | null
  /** Optional secondary 3D viewer plugin for comparing two structures side-by-side. */
  secondaryPlugin: PluginUIContext | null
  /** Currently selected target slot for "Load from Library". */
  loadTargetSlot: ViewerSlot

  chains: ChainInfo[]
  /** Chains extracted from the secondary viewer (for cross-structure alignment). */
  secondaryChains: ChainInfo[]
  elements: ElementInfo[]
  activeChainId: string | null
  fileName: string | null
  /** File loaded into the secondary viewer (independent of primary). */
  secondaryFileName: string | null
  isLoading: boolean
  error: string | null
  meta: StructureMeta
  /** Chain currently inspected via the Elements interface action. Filters InteractionsPanel. */
  focusedChainId: string | null
  /** Entity category of the focused chain ('polymer' | 'ligand' | 'ion' | 'water' | 'other'). */
  focusedCategory: string | null
  /** When true, camera movements in viewer A are mirrored in viewer B and vice versa. */
  cameraSyncEnabled: boolean
  /** Monotonic counter. Increment to signal "clear all selections everywhere"
   *  (3D viewers + alignment panel etc.). Components watch via useEffect. */
  clearAllSignal: number
  /** Monotonic counter for library mutations (meta edits, star toggles,
   *  DVBFixer runs, manual disk changes). StructureLibrary watches this and
   *  re-fetches /structures/index.json whenever it changes. */
  libraryVersion: number

  setPlugin: (plugin: PluginUIContext | null) => void
  setSecondaryPlugin: (plugin: PluginUIContext | null) => void
  setLoadTargetSlot: (slot: ViewerSlot) => void
  setChains: (chains: ChainInfo[]) => void
  setSecondaryChains: (chains: ChainInfo[]) => void
  setElements: (elements: ElementInfo[]) => void
  setActiveChain: (chainId: string) => void
  setFileName: (name: string | null) => void
  setSecondaryFileName: (name: string | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setMeta: (meta: Partial<StructureMeta>) => void
  setFocusedChain: (chainId: string | null, category?: string | null) => void
  setCameraSyncEnabled: (enabled: boolean) => void
  /** Bump clearAllSignal — components subscribed via useEffect will reset their state. */
  fireClearAll: () => void
  /** Bump libraryVersion — StructureLibrary re-fetches index.json. */
  bumpLibraryVersion: () => void
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
  secondaryPlugin: null,
  loadTargetSlot: 'primary',
  chains: [],
  secondaryChains: [],
  elements: [],
  activeChainId: null,
  fileName: null,
  secondaryFileName: null,
  isLoading: false,
  error: null,
  meta: { ...defaultMeta },
  focusedChainId: null,
  focusedCategory: null,
  cameraSyncEnabled: true,
  clearAllSignal: 0,
  libraryVersion: 0,

  setPlugin: (plugin) => set({ plugin }),
  setSecondaryPlugin: (plugin) => set({ secondaryPlugin: plugin }),
  setLoadTargetSlot: (slot) => set({ loadTargetSlot: slot }),
  setChains: (chains) => {
    set({
      chains,
      activeChainId: chains.length > 0 ? chains[0].id : null,
    })
  },
  setSecondaryChains: (chains) => set({ secondaryChains: chains }),
  setElements: (elements) => set({ elements }),
  setActiveChain: (chainId) => set({ activeChainId: chainId }),
  setFileName: (name) => set({ fileName: name }),
  setSecondaryFileName: (name) => set({ secondaryFileName: name }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  setMeta: (partial) => set({ meta: { ...get().meta, ...partial } }),
  setFocusedChain: (chainId, category = null) => set({
    focusedChainId: chainId,
    focusedCategory: chainId === null ? null : category,
  }),
  setCameraSyncEnabled: (enabled) => set({ cameraSyncEnabled: enabled }),
  fireClearAll: () => set(s => ({ clearAllSignal: s.clearAllSignal + 1 })),
  bumpLibraryVersion: () => set(s => ({ libraryVersion: s.libraryVersion + 1 })),
  reset: () => set({
    chains: [],
    secondaryChains: [],
    elements: [],
    activeChainId: null,
    fileName: null,
    secondaryFileName: null,
    isLoading: false,
    error: null,
    meta: { ...defaultMeta },
    focusedChainId: null,
    focusedCategory: null,
  }),
}))
