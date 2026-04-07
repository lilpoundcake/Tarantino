import { useCallback, useRef, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import IconButton from '@mui/material/IconButton'
import ClearIcon from '@mui/icons-material/Deselect'
import ZoomInIcon from '@mui/icons-material/CenterFocusStrong'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'
import { selectResiduesInViewer, focusResiduesInViewer } from '../lib/molstar-helpers'
import { threeToOne, residueClass } from '../lib/residue-codes'
import { ChainSelector } from './ChainSelector'

const RESIDUES_PER_LINE = 60
const BLOCK_SIZE = 10

const CLASS_COLORS: Record<string, string> = {
  hydrophobic: '#2e7d32',
  positive: '#1565c0',
  negative: '#c62828',
  polar: '#e68a00',
  special: '#7b1fa2',
  other: '#5a607a',
}

const NON_SEQ_COMPS = new Set([
  'HOH', 'WAT', 'DOD', 'H2O',  // water
  'ZN', 'MG', 'CA', 'FE', 'MN', 'CO', 'NI', 'CU', 'NA', 'K',  // ions
  'CL', 'BR', 'SO4', 'PO4', 'NO3', 'CD', 'HG', 'SR', 'BA',
])

function getSequenceChains(allChains: Array<{ id: string; entityId: string; residues: Array<{ seqId: number; compId: string }> }>) {
  return allChains
    .map(chain => ({
      ...chain,
      residues: chain.residues.filter(r => !NON_SEQ_COMPS.has(r.compId)),
    }))
    .filter(chain => chain.residues.length > 1)
}

export function SequenceViewer({ initialChainId }: { initialChainId?: string } = {}) { // @dsp obj-a1000006
  const allChains = useStructureStore((s) => s.chains)
  const chains = getSequenceChains(allChains)
  const globalChainId = useStructureStore((s) => s.activeChainId)
  const [localChainId, setLocalChainId] = useState<string | null>(initialChainId ?? null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Initialize local chain from global on first load, or when chains change and local is invalid
  useEffect(() => {
    if (chains.length > 0 && (!localChainId || !chains.find(c => c.id === localChainId))) {
      setLocalChainId(initialChainId ?? globalChainId ?? chains[0].id)
    }
  }, [chains, initialChainId])

  const activeChainId = localChainId
  const [dragStart, setDragStart] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const plugin = useStructureStore((s) => s.plugin)
  const selectedResidues = useSelectionStore((s) => s.selectedResidues)
  const hoveredResidue = useSelectionStore((s) => s.hoveredResidue)
  const toggleSelect = useSelectionStore((s) => s.toggleSelect)
  const selectRange = useSelectionStore((s) => s.selectRange)
  const clearSelection = useSelectionStore((s) => s.clearSelection)
  const hover = useSelectionStore((s) => s.hover)

  const activeChain = chains.find((c) => c.id === activeChainId)

  const handleClear = useCallback(() => {
    clearSelection()
    if (plugin) {
      plugin.managers.interactivity.lociSelects.deselectAll()
    }
  }, [clearSelection, plugin])

  const handleZoom = useCallback(() => {
    if (!plugin || selectedResidues.size === 0) return
    const residues = Array.from(selectedResidues.values())
    // Show as sticks + zoom
    selectResiduesInViewer(plugin, residues, 'select')
    focusResiduesInViewer(plugin, residues)
    // Zoom camera
    const loci = plugin.managers.structure.selection.getLoci(
      plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data as any
    )
    if (loci) {
      plugin.managers.camera.focusLoci(loci)
    }
  }, [plugin, selectedResidues])

  const handleMouseDown = useCallback((seqId: number) => {
    setDragStart(seqId)
    setIsDragging(false)
  }, [])

  const handleMouseMove = useCallback((seqId: number) => {
    if (dragStart !== null && activeChain) {
      setIsDragging(true)
      // Select range from dragStart to current
      const start = Math.min(dragStart, seqId)
      const end = Math.max(dragStart, seqId)
      const rangeResidues = activeChain.residues
        .filter(r => r.seqId >= start && r.seqId <= end)
        .map(r => ({ chainId: activeChain.id, seqId: r.seqId }))
      selectRange(rangeResidues, 'sequence')
    }
    if (activeChain) {
      hover({ chainId: activeChain.id, seqId }, 'sequence')
    }
  }, [dragStart, activeChain, selectRange, hover])

  const handleMouseUp = useCallback((seqId: number) => {
    if (!isDragging && activeChain) {
      // Simple click, not drag
      toggleSelect({ chainId: activeChain.id, seqId }, 'sequence')
    }
    setDragStart(null)
    setIsDragging(false)
  }, [isDragging, activeChain, toggleSelect])

  const handleMouseLeave = useCallback(() => {
    hover(null, 'sequence')
  }, [hover])

  // Global mouseup to handle drag ending outside the component
  useEffect(() => {
    const handler = () => {
      setDragStart(null)
      setIsDragging(false)
    }
    window.addEventListener('mouseup', handler)
    return () => window.removeEventListener('mouseup', handler)
  }, [])

  // Scroll selected residue into view
  useEffect(() => {
    if (selectedResidues.size === 1 && scrollRef.current) {
      const entry = selectedResidues.values().next().value
      if (entry && entry.chainId === activeChainId) {
        const el = scrollRef.current.querySelector(`[data-seq="${entry.seqId}"]`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [selectedResidues, activeChainId])

  if (chains.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Load a structure to view its sequence</Typography>
      </Box>
    )
  }

  // Split residues into lines
  const residueLines: Array<typeof activeChain extends undefined ? never : NonNullable<typeof activeChain>['residues']> = []
  if (activeChain) {
    for (let i = 0; i < activeChain.residues.length; i += RESIDUES_PER_LINE) {
      residueLines.push(activeChain.residues.slice(i, i + RESIDUES_PER_LINE))
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <ChainSelector value={activeChainId} onChange={setLocalChainId} />
        <Tooltip title="Zoom to selected residues in 3D view" placement="bottom">
          <span>
            <IconButton
              size="small"
              onClick={handleZoom}
              disabled={selectedResidues.size === 0}
              sx={{ p: 0.5 }}
            >
              <ZoomInIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Clear selection (Esc)" placement="bottom">
          <span>
            <IconButton
              size="small"
              onClick={handleClear}
              disabled={selectedResidues.size === 0}
              sx={{ p: 0.5 }}
            >
              <ClearIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        {activeChain && (
          <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
            {activeChain.residues.length} residues
          </Typography>
        )}
        {selectedResidues.size > 0 && (
          <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 600 }}>
            · {selectedResidues.size} selected
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {Object.entries(CLASS_COLORS).filter(([k]) => k !== 'other').map(([label, color]) => (
            <Chip
              key={label}
              label={label}
              size="small"
              sx={{ height: 16, fontSize: '0.5rem', bgcolor: `${color}20`, color, '& .MuiChip-label': { px: 0.5 } }}
            />
          ))}
        </Box>
      </Box>

      {/* Sequence lines */}
      <Box
        ref={scrollRef}
        onMouseLeave={handleMouseLeave}
        sx={{
          flex: 1,
          overflow: 'auto',
          py: 1, pl: 1, pr: 3,
          userSelect: 'none',
          cursor: dragStart !== null ? 'crosshair' : 'default',
          fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
        }}
      >
        {residueLines.map((lineResidues, lineIdx) => {
          const lineStart = lineResidues[0]?.seqId ?? 0
          return (
            <Box key={lineIdx} sx={{ display: 'flex', alignItems: 'flex-start', mb: 0.5 }}>
              {/* Line number — aligned to residue letters (12px number above + 20px letter) */}
              <Box sx={{
                width: 36, flexShrink: 0, textAlign: 'right', pr: 0.75,
                fontSize: '10px', color: 'text.secondary', fontFamily: 'inherit',
                pt: '12px', lineHeight: '18px',
              }}>
                {lineStart}
              </Box>
              {/* Residues with block spacing */}
              <Box sx={{ display: 'flex', flexWrap: 'nowrap' }}>
                {lineResidues.map((r, rIdx) => {
                  const oneLetterCode = threeToOne(r.compId)
                  const key = `${activeChain!.id}:${r.seqId}`
                  const isSelected = selectedResidues.has(key)
                  const isHovered = hoveredResidue !== null &&
                    hoveredResidue.chainId === activeChain!.id &&
                    hoveredResidue.seqId === r.seqId
                  const rClass = residueClass(oneLetterCode)
                  const baseColor = CLASS_COLORS[rClass] ?? CLASS_COLORS.other

                  let bg = 'transparent'
                  let textColor = baseColor
                  let border = '1px solid transparent'

                  if (isSelected) {
                    bg = '#4a76c4'
                    textColor = '#ffffff'
                    border = '1px solid #4a76c4'
                  } else if (isHovered) {
                    bg = '#e8eaf6'
                    textColor = '#1a1a2e'
                    border = '1px solid #4a76c4'
                  }

                  // Block spacer every BLOCK_SIZE residues
                  const spacer = rIdx > 0 && rIdx % BLOCK_SIZE === 0

                  const showNumber = (rIdx + 1) % BLOCK_SIZE === 0

                  // Fixed width per residue cell — number label constrained to same width
                  const CELL_W = 13

                  return (
                    <span key={r.seqId} style={{
                      display: 'inline-flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      width: CELL_W,
                      marginLeft: spacer ? 8 : 0,
                    }}>
                      <span style={{
                        fontSize: '7px',
                        color: '#8899aa',
                        height: 11,
                        lineHeight: '11px',
                        fontWeight: 400,
                        textAlign: 'center',
                        overflow: 'visible',
                        whiteSpace: 'nowrap',
                        visibility: showNumber ? 'visible' : 'hidden',
                      }}>
                        {r.seqId}
                      </span>
                      <Tooltip title={`${r.compId} ${r.seqId} (${rClass})`} placement="top" enterDelay={300}>
                        <span
                          data-seq={r.seqId}
                          onMouseDown={() => handleMouseDown(r.seqId)}
                          onMouseMove={() => handleMouseMove(r.seqId)}
                          onMouseUp={() => handleMouseUp(r.seqId)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: CELL_W,
                            height: 18,
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            backgroundColor: bg,
                            color: textColor,
                            borderRadius: 2,
                            border,
                            transition: 'background-color 50ms',
                          }}
                        >
                          {oneLetterCode}
                        </span>
                      </Tooltip>
                    </span>
                  )
                })}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
