import { useCallback, useEffect, useMemo, useState } from 'react'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import RefreshIcon from '@mui/icons-material/Refresh'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import SubdirectoryArrowRightIcon from '@mui/icons-material/SubdirectoryArrowRight'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import { useStructureStore, type ViewerSlot } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'

interface StructureEntry {
  id: string
  file: string
  name: string
  organism: string
  chains: number
  residues: number
  description: string
  /** When set, this entry is a child of the entry whose `file` matches. */
  parent?: string
  /** DVBFixer command that produced this child (set on outputs). */
  command?: string
  /** User-marked root. Visual indicator only — re-rooting is persisted as parent rewrites. */
  starred?: boolean
}

export function StructureLibrary(_props: { onClose?: () => void }) {
  const [entries, setEntries] = useState<StructureEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Build parent → children map. Roots are entries without a parent that
  // matches an existing entry's `file`. Orphans (parent set but parent file
  // missing) are treated as roots too so they're not hidden.
  const tree = useMemo(() => {
    const fileSet = new Set(entries.map(e => e.file))
    const byParent = new Map<string, StructureEntry[]>()
    const roots: StructureEntry[] = []
    for (const e of entries) {
      if (e.parent && fileSet.has(e.parent)) {
        const arr = byParent.get(e.parent) ?? []
        arr.push(e)
        byParent.set(e.parent, arr)
      } else {
        roots.push(e)
      }
    }
    return { roots, byParent }
  }, [entries])

  // Everything starts collapsed. Users explicitly open parents via the
  // chevron — we DO NOT auto-expand when new children appear (the chevron
  // changes appearance to indicate children, which is enough hint).

  const toggleExpanded = useCallback((file: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }, [])

  const plugin = useStructureStore((s) => s.plugin)
  const secondaryPlugin = useStructureStore((s) => s.secondaryPlugin)
  const loadTargetSlot = useStructureStore((s) => s.loadTargetSlot)
  const setLoadTargetSlot = useStructureStore((s) => s.setLoadTargetSlot)
  const setFileName = useStructureStore((s) => s.setFileName)
  const setSecondaryFileName = useStructureStore((s) => s.setSecondaryFileName)
  const setMeta = useStructureStore((s) => s.setMeta)
  const setStoreLoading = useStructureStore((s) => s.setLoading)
  const setStoreError = useStructureStore((s) => s.setError)
  const fileName = useStructureStore((s) => s.fileName)
  const secondaryFileName = useStructureStore((s) => s.secondaryFileName)
  const clearSelection = useSelectionStore((s) => s.clearSelection)

  const fetchIndex = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/structures/index.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setEntries(await res.json())
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-fetch on mount AND whenever something bumps libraryVersion
  // (meta edit, star toggle, DVBFixer run, file deletion, etc).
  const libraryVersion = useStructureStore((s) => s.libraryVersion)
  useEffect(() => { fetchIndex() }, [fetchIndex, libraryVersion])

  // Find a starred descendant of `entry`. If found, that's what we load
  // when the user clicks `entry` (the family root). DFS through children.
  const findStarredInSubtree = useCallback((root: StructureEntry): StructureEntry | null => {
    const byParent = new Map<string, StructureEntry[]>()
    for (const e of entries) {
      if (e.parent) {
        const arr = byParent.get(e.parent) ?? []
        arr.push(e)
        byParent.set(e.parent, arr)
      }
    }
    const stack: StructureEntry[] = [root]
    const seen = new Set<string>([root.file])
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur.starred && cur !== root) return cur
      for (const child of byParent.get(cur.file) ?? []) {
        if (!seen.has(child.file)) {
          seen.add(child.file)
          stack.push(child)
        }
      }
    }
    return null
  }, [entries])

  const loadStructureRaw = useCallback(async (entry: StructureEntry) => {
    const targetPlugin = loadTargetSlot === 'secondary' ? secondaryPlugin : plugin
    if (!targetPlugin) {
      setStoreError(
        loadTargetSlot === 'secondary'
          ? 'Open a "3D Structure (B)" tab first'
          : 'Open a "3D Structure" tab first'
      )
      return
    }
    setLoadingId(entry.id)
    setStoreLoading(true)
    setStoreError(null)
    // Only clear sequence-panel selection when loading into primary
    if (loadTargetSlot === 'primary') clearSelection()

    try {
      const res = await fetch(`/structures/${entry.file}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const format = entry.file.endsWith('.cif') || entry.file.endsWith('.mmcif') ? 'mmcif' : 'pdb'

      await targetPlugin.clear()
      const data = await targetPlugin.builders.data.rawData({ data: text, label: entry.file })
      const trajectory = await targetPlugin.builders.structure.parseTrajectory(data, format)
      await targetPlugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')
      if (loadTargetSlot === 'secondary') {
        setSecondaryFileName(entry.file)
      } else {
        setFileName(entry.file)
        // Populate the Info-panel meta from the loaded entry. Only the
        // PRIMARY viewer drives the meta panel — the secondary is for
        // visual comparison and doesn't own the metadata UI.
        setMeta({
          name: entry.name ?? '',
          organism: (entry as any).organism ?? '',
          method: (entry as any).method ?? '',
          resolution: (entry as any).resolution ?? '',
          description: entry.description ?? '',
        })
      }
    } catch (err: any) {
      setStoreError(`Failed to load ${entry.name}: ${err.message}`)
    } finally {
      setStoreLoading(false)
      setLoadingId(null)
    }
  }, [plugin, secondaryPlugin, loadTargetSlot, setFileName, setSecondaryFileName, setMeta, setStoreLoading, setStoreError, clearSelection])

  const loadStructure = useCallback(async (entry: StructureEntry) => {
    // If clicking a family root and a descendant is starred, load THAT instead.
    if (!entry.parent && !entry.starred) {
      const starredDescendant = findStarredInSubtree(entry)
      if (starredDescendant) {
        return loadStructureRaw(starredDescendant)
      }
    }
    return loadStructureRaw(entry)
  }, [findStarredInSubtree, loadStructureRaw])

  const bumpLibraryVersion = useStructureStore((s) => s.bumpLibraryVersion)

  const handleStar = useCallback(async (file: string) => {
    try {
      const res = await fetch('/api/library/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      // Triggers re-fetch via the libraryVersion useEffect below
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] star failed:', err)
    }
  }, [bumpLibraryVersion])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={20} />
      </Box>
    )
  }

  if (entries.length === 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1, px: 2 }}>
        <FolderOpenIcon sx={{ fontSize: 32, color: 'text.secondary' }} />
        <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center' }}>
          No structures found. Add .pdb files to the structures/ folder.
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider', gap: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Library
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}>
          {secondaryPlugin && (
            <Tooltip title="Choose which 3D viewer the next click loads into">
              <ToggleButtonGroup
                size="small"
                exclusive
                value={loadTargetSlot}
                onChange={(_e, v: ViewerSlot | null) => v && setLoadTargetSlot(v)}
                sx={{
                  height: 20,
                  '& .MuiToggleButton-root': {
                    px: 0.75, py: 0, fontSize: '0.6rem', fontWeight: 700, lineHeight: 1,
                    border: '1px solid', borderColor: 'divider',
                  },
                }}
              >
                <ToggleButton value="primary">A</ToggleButton>
                <ToggleButton value="secondary">B</ToggleButton>
              </ToggleButtonGroup>
            </Tooltip>
          )}
          <IconButton size="small" onClick={fetchIndex} sx={{ p: 0.5 }}>
            <RefreshIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      </Box>
      <List dense disablePadding sx={{ flex: 1, overflow: 'auto' }}>
        {tree.roots.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            depth={0}
            children={tree.byParent.get(entry.file) ?? []}
            byParent={tree.byParent}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            fileName={fileName}
            secondaryFileName={secondaryFileName}
            loadingId={loadingId}
            onLoad={loadStructure}
            onStar={handleStar}
          />
        ))}
      </List>
      <Box sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6rem' }}>
          Add files to <code>structures/</code> + update <code>index.json</code>
        </Typography>
      </Box>
    </Box>
  )
}

interface EntryRowProps {
  entry: StructureEntry
  depth: number
  children: StructureEntry[]
  byParent: Map<string, StructureEntry[]>
  expanded: Set<string>
  toggleExpanded: (file: string) => void
  fileName: string | null
  secondaryFileName: string | null
  loadingId: string | null
  onLoad: (entry: StructureEntry) => void
  onStar: (file: string) => void
  /** If this entry has a starred descendant, the name to display as a hint. */
  starredDescendantName?: string | null
}

function EntryRow({
  entry,
  depth,
  children,
  byParent,
  expanded,
  toggleExpanded,
  fileName,
  secondaryFileName,
  loadingId,
  onLoad,
  onStar,
  starredDescendantName,
}: EntryRowProps) {
  const inPrimary = fileName === entry.file
  const inSecondary = secondaryFileName === entry.file
  const isActive = inPrimary || inSecondary
  const isLoading = loadingId === entry.id
  const hasChildren = children.length > 0
  const isExpanded = expanded.has(entry.file)

  // For a family ROOT (depth 0), find a starred descendant for the hint
  // chip. NB: we deliberately DON'T require `!entry.parent` — an entry can
  // become a tree root even with a non-empty `parent` field if that parent
  // file doesn't exist on disk (an orphan reference, usually leftover from
  // an old buggy star/swap). Hiding the chip in that case made the bug
  // invisible to the user. The vite scanner now also auto-cleans these.
  let starredHintName = starredDescendantName ?? null
  if (depth === 0 && !entry.starred && !starredHintName) {
    const stack: StructureEntry[] = [...children]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur.file)) continue
      seen.add(cur.file)
      if (cur.starred) { starredHintName = cur.name; break }
      for (const grand of byParent.get(cur.file) ?? []) stack.push(grand)
    }
  }

  return (
    <>
      <ListItemButton
        selected={isActive}
        onClick={() => onLoad(entry)}
        disabled={isLoading}
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          borderLeft: isActive ? '3px solid' : '3px solid transparent',
          borderLeftColor: isActive ? 'primary.main' : 'transparent',
          py: 0.75, px: 1, pl: 1 + depth * 1.5,
        }}
      >
        {/* Chevron / indent indicator */}
        <Box sx={{ width: 18, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          {hasChildren ? (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); toggleExpanded(entry.file) }}
              sx={{ p: 0 }}
            >
              {isExpanded
                ? <ExpandMoreIcon sx={{ fontSize: 16 }} />
                : <ChevronRightIcon sx={{ fontSize: 16 }} />
              }
            </IconButton>
          ) : depth > 0 ? (
            <SubdirectoryArrowRightIcon sx={{ fontSize: 12, color: 'text.disabled' }} />
          ) : null}
        </Box>

        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography variant="body2" sx={{ fontWeight: depth === 0 ? 600 : 500, fontSize: '0.75rem' }}>
                {entry.name}
              </Typography>
              {entry.command && (
                <Chip
                  label={entry.command}
                  size="small"
                  variant="outlined"
                  sx={{ height: 14, fontSize: '0.55rem', '& .MuiChip-label': { px: 0.5 } }}
                />
              )}
              {starredHintName && (
                <Tooltip title={`Clicking loads ${starredHintName} (starred descendant)`}>
                  <Chip
                    icon={<StarIcon sx={{ fontSize: 12, color: '#f5a623 !important' }} />}
                    label={`→ ${starredHintName}`}
                    size="small"
                    variant="outlined"
                    sx={{
                      height: 14,
                      fontSize: '0.55rem',
                      borderColor: '#f5a623',
                      color: '#a0670f',
                      '& .MuiChip-label': { px: 0.5 },
                    }}
                  />
                </Tooltip>
              )}
              {isLoading && <CircularProgress size={12} />}
              {isActive && !isLoading && (
                <Chip
                  label={inPrimary && inSecondary ? 'A + B' : inPrimary ? 'A' : 'B'}
                  size="small" color="primary"
                  sx={{ height: 16, fontSize: '0.6rem', minWidth: 28 }}
                />
              )}
            </Box>
          }
          secondary={
            <Typography component="span" variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6rem', display: 'block' }}>
              {entry.description || entry.file}
            </Typography>
          }
        />
        {/* Star button — re-roots the tree on a child, just toggles flag on a root */}
        <Tooltip title={entry.starred ? 'Unstar' : (entry.parent ? 'Promote to root (parent becomes its child)' : 'Star this root')}>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onStar(entry.file) }}
            sx={{ p: 0.5, flexShrink: 0 }}
          >
            {entry.starred
              ? <StarIcon sx={{ fontSize: 16, color: '#f5a623' }} />
              : <StarBorderIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
            }
          </IconButton>
        </Tooltip>
      </ListItemButton>

      {/* Children */}
      {hasChildren && isExpanded && children.map((child) => (
        <EntryRow
          key={child.id}
          entry={child}
          depth={depth + 1}
          children={byParent.get(child.file) ?? []}
          byParent={byParent}
          expanded={expanded}
          toggleExpanded={toggleExpanded}
          fileName={fileName}
          secondaryFileName={secondaryFileName}
          loadingId={loadingId}
          onLoad={onLoad}
          onStar={onStar}
        />
      ))}
    </>
  )
}
