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
import TextField from '@mui/material/TextField'
import RefreshIcon from '@mui/icons-material/Refresh'
import FolderIcon from '@mui/icons-material/Folder'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import SubdirectoryArrowRightIcon from '@mui/icons-material/SubdirectoryArrowRight'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useStructureStore, type ViewerSlot } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

interface StructureEntry {
  kind?: 'structure'
  id: string
  file: string
  name: string
  organism?: string
  chains?: number
  residues?: number
  description?: string
  /** Lineage parent (e.g. DVBFixer output's input). Read-only nesting. */
  parent?: string
  /** DVBFixer command that produced this child. */
  command?: string
  starred?: boolean
}

interface FolderEntry {
  kind: 'folder'
  id: string
  name: string
  /** Ordered list of entry ids (folder ids OR structure file paths). */
  children: string[]
}

type AnyEntry = StructureEntry | FolderEntry

const ROOT_ID = '__root__'

function isFolder(e: AnyEntry): e is FolderEntry {
  return e.kind === 'folder'
}
function entryIdOf(e: AnyEntry): string {
  return isFolder(e) ? e.id : e.file
}

/**
 * Walk up the lineage `parent` chain from `start` looking for the first
 * non-empty value of `field`. Returns '' if nothing is found. Cycle-safe
 * via a seen-set. Used to inherit antibody-identity tags (allotype,
 * iggSubtype) so the Info panel shows the right value even on outputs
 * whose own entry doesn't carry the field — useful for entries created
 * before the inherit-at-write rule landed, or for any future tool that
 * forgets to propagate the tags.
 */
function inheritFromLineage<K extends 'allotype' | 'iggSubtype'>(
  allEntries: AnyEntry[],
  start: StructureEntry,
  field: K,
): string {
  const ownValue = (start as any)[field]
  if (typeof ownValue === 'string' && ownValue.trim() !== '') return ownValue

  const byFile = new Map<string, StructureEntry>()
  for (const e of allEntries) {
    if (!isFolder(e)) byFile.set(e.file, e)
  }

  const seen = new Set<string>([start.file])
  let cursor: StructureEntry | undefined = start
  while (cursor?.parent) {
    if (seen.has(cursor.parent)) break       // cycle guard
    seen.add(cursor.parent)
    const parent = byFile.get(cursor.parent)
    if (!parent) break
    const v = (parent as any)[field]
    if (typeof v === 'string' && v.trim() !== '') return v
    cursor = parent
  }
  return ''
}

/* ────────────────────────────────────────────────────────────────────────
 * StructureLibrary
 * ──────────────────────────────────────────────────────────────────────── */

export function StructureLibrary(_props: { onClose?: () => void }) {
  const [entries, setEntries] = useState<AnyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT_ID]))
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

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
  const bumpLibraryVersion = useStructureStore((s) => s.bumpLibraryVersion)
  const libraryVersion = useStructureStore((s) => s.libraryVersion)

  /* ── Fetch ─────────────────────────────────────────────────────────── */
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
  useEffect(() => { fetchIndex() }, [fetchIndex, libraryVersion])

  // Defensive watchdog: if the secondary viewer disappears for any
  // reason (tab closed, error, hot reload) while the A/B toggle is
  // still on 'secondary', snap it back to 'primary'. Otherwise every
  // Library click bails with "Open a '3D Structure (B)' tab first"
  // since loadStructureRaw checks the resolved plugin. The
  // MolstarViewer cleanup already handles the common case; this is a
  // belt-and-braces safety net.
  useEffect(() => {
    if (!secondaryPlugin && loadTargetSlot === 'secondary') {
      setLoadTargetSlot('primary')
    }
  }, [secondaryPlugin, loadTargetSlot, setLoadTargetSlot])

  /* ── Index ─────────────────────────────────────────────────────────── */
  // byId: id → entry
  // lineage: parentFile → child structures (default auto-nesting)
  // placedInFolder: ids that appear inside SOME folder.children — they
  // render at that explicit location and are SUPPRESSED from default
  // lineage nesting (otherwise they'd appear twice).
  const { byId, lineage, root, placedInFolder } = useMemo(() => {
    const map = new Map<string, AnyEntry>()
    const lin = new Map<string, StructureEntry[]>()
    const placed = new Set<string>()
    let r: FolderEntry | null = null
    for (const e of entries) {
      map.set(entryIdOf(e), e)
      if (isFolder(e)) {
        if (e.id === ROOT_ID) r = e
        for (const childId of e.children ?? []) placed.add(childId)
      } else if (e.parent) {
        const arr = lin.get(e.parent) ?? []
        arr.push(e)
        lin.set(e.parent, arr)
      }
    }
    return { byId: map, lineage: lin, root: r, placedInFolder: placed }
  }, [entries])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  /* ── Load a structure into the active viewer slot ──────────────────── */
  const findStarredInLineage = useCallback((rootStruct: StructureEntry): StructureEntry | null => {
    const stack: StructureEntry[] = [rootStruct]
    const seen = new Set<string>([rootStruct.file])
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur.starred && cur !== rootStruct) return cur
      for (const child of lineage.get(cur.file) ?? []) {
        if (!seen.has(child.file)) { seen.add(child.file); stack.push(child) }
      }
    }
    return null
  }, [lineage])

  const loadStructureRaw = useCallback(async (entry: StructureEntry) => {
    const targetPlugin = loadTargetSlot === 'secondary' ? secondaryPlugin : plugin
    if (!targetPlugin) {
      setStoreError(loadTargetSlot === 'secondary'
        ? 'Open a "3D Structure (B)" tab first'
        : 'Open a "3D Structure" tab first')
      return
    }
    setLoadingId(entry.id)
    setStoreLoading(true)
    setStoreError(null)
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
        // Lineage inheritance for antibody-identity tags. If this entry
        // doesn't have its own allotype / iggSubtype set, walk up the
        // `parent` chain and use the first ancestor's value. So even
        // when a child was created BEFORE the inherit-at-write fix (or
        // by a tool that didn't carry the tags), the Info panel still
        // shows the right value as long as some ancestor has it set.
        const inheritedAllotype = inheritFromLineage(entries, entry, 'allotype')
        const inheritedIggSubtype = inheritFromLineage(entries, entry, 'iggSubtype')
        setMeta({
          name: entry.name ?? '',
          organism: (entry as any).organism ?? '',
          method: (entry as any).method ?? '',
          resolution: (entry as any).resolution ?? '',
          description: entry.description ?? '',
          iggSubtype: inheritedIggSubtype,
          allotype: inheritedAllotype,
          equivalentChains: (entry as any).equivalentChains,
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
    // If clicking a lineage root with a starred descendant, load the descendant instead.
    if (!entry.parent && !entry.starred) {
      const starred = findStarredInLineage(entry)
      if (starred) return loadStructureRaw(starred)
    }
    return loadStructureRaw(entry)
  }, [findStarredInLineage, loadStructureRaw])

  /* ── Star toggle ───────────────────────────────────────────────────── */
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
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] star failed:', err)
    }
  }, [bumpLibraryVersion])

  /* ── Folder operations ─────────────────────────────────────────────── */
  const createFolder = useCallback(async () => {
    const name = window.prompt('New folder name:', 'New folder')
    if (!name) return
    try {
      const res = await fetch('/api/library/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] createFolder failed:', err)
    }
  }, [bumpLibraryVersion])

  const renameFolder = useCallback(async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/library/folder/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] renameFolder failed:', err)
    }
  }, [bumpLibraryVersion])

  const deleteFolder = useCallback(async (id: string) => {
    if (!window.confirm('Delete this folder? Children move up to the parent folder.')) return
    try {
      const res = await fetch(`/api/library/folder/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] deleteFolder failed:', err)
    }
  }, [bumpLibraryVersion])

  /* ── Move / reorder ────────────────────────────────────────────────── */
  const apiMove = useCallback(async (entryId: string, toFolderId: string, beforeId?: string | null) => {
    try {
      const res = await fetch('/api/library/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, toFolderId, beforeId: beforeId ?? null }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      bumpLibraryVersion()
    } catch (err) {
      console.warn('[library] move failed:', err)
    }
  }, [bumpLibraryVersion])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const folderContainingId = useCallback((id: string): FolderEntry | null => {
    for (const e of entries) {
      if (isFolder(e) && e.children.includes(id)) return e
    }
    return null
  }, [entries])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    // The sortable item's data tells us whether `over` is a folder or a
    // structure (set via `useSortable({ id, data: { type } })`).
    const overType = (over.data?.current as any)?.type as 'folder' | 'structure' | undefined
    const activeType = (active.data?.current as any)?.type as 'folder' | 'structure' | undefined

    // Drop a STRUCTURE on a FOLDER → move the structure INTO that folder
    // (appended at end). This is the "put this in the folder" gesture.
    if (overType === 'folder' && activeType === 'structure') {
      apiMove(activeId, overId)
      return
    }

    // Otherwise (structure-on-structure, folder-on-folder, folder-on-structure)
    // → insert active before over in over's container folder. Lets the user
    // reorder folders alongside each other and structures within a folder.
    const destFolder = folderContainingId(overId)
    if (!destFolder) return
    apiMove(activeId, destFolder.id, overId)
  }, [apiMove, folderContainingId])

  /* ── Render ────────────────────────────────────────────────────────── */
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={20} />
      </Box>
    )
  }
  if (!root || (entries.length === 0)) {
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
          <Tooltip title="New folder">
            <IconButton size="small" onClick={createFolder} sx={{ p: 0.5 }}>
              <CreateNewFolderIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={fetchIndex} sx={{ p: 0.5 }}>
              <RefreshIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <List dense disablePadding sx={{ flex: 1, overflow: 'auto' }}>
          <FolderContents
            folder={root}
            depth={0}
            byId={byId}
            lineage={lineage}
            placedInFolder={placedInFolder}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            fileName={fileName}
            secondaryFileName={secondaryFileName}
            loadingId={loadingId}
            onLoad={loadStructure}
            onStar={handleStar}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            renameDraft={renameDraft}
            setRenameDraft={setRenameDraft}
          />
        </List>
      </DndContext>

      <Box sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6rem' }}>
          Drag rows to reorder · drop onto a folder header to move inside
        </Typography>
      </Box>
    </Box>
  )
}

/* ────────────────────────────────────────────────────────────────────────
 * Rows
 * ──────────────────────────────────────────────────────────────────────── */

interface RowCtx {
  byId: Map<string, AnyEntry>
  lineage: Map<string, StructureEntry[]>
  /** Ids that appear inside SOME folder.children. Used to suppress
   *  default lineage rendering — a lineage child placed in a folder
   *  is shown only there, not under its parent. */
  placedInFolder: Set<string>
  expanded: Set<string>
  toggleExpanded: (id: string) => void
  fileName: string | null
  secondaryFileName: string | null
  loadingId: string | null
  onLoad: (e: StructureEntry) => void
  onStar: (file: string) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  renamingId: string | null
  setRenamingId: (id: string | null) => void
  renameDraft: string
  setRenameDraft: (s: string) => void
}

function FolderContents({ folder, depth, ...ctx }: { folder: FolderEntry; depth: number } & RowCtx) {
  // Lineage children CAN appear here — user explicitly placed them. We
  // only filter out unknown ids (stale references). Duplication with
  // default lineage rendering is prevented by `placedInFolder` (see
  // StructureRow's lineage render path).
  const items = folder.children.filter(id => ctx.byId.has(id))
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {items.map(id => {
        const child = ctx.byId.get(id)!
        if (isFolder(child)) {
          return <FolderRow key={id} folder={child} depth={depth} {...ctx} />
        }
        return <StructureRow key={id} structure={child} depth={depth} draggable {...ctx} />
      })}
    </SortableContext>
  )
}

function FolderRow({ folder, depth, ...ctx }: { folder: FolderEntry; depth: number } & RowCtx) {
  const sortable = useSortable({ id: folder.id, data: { type: 'folder' } })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  }
  const isExpanded = ctx.expanded.has(folder.id)
  const isRenaming = ctx.renamingId === folder.id

  const commitRename = () => {
    const next = ctx.renameDraft.trim()
    ctx.setRenamingId(null)
    if (next && next !== folder.name) ctx.onRenameFolder(folder.id, next)
  }

  return (
    <>
      <Box ref={sortable.setNodeRef} style={style}>
        <Box
          sx={{
            display: 'flex', alignItems: 'center',
            borderBottom: '1px solid', borderColor: 'divider',
            py: 0.5, px: 1, pl: 1 + depth * 1.5,
            // Highlight the folder row when something is being dragged
            // OVER it — visual cue for "drop here to move inside".
            backgroundColor: sortable.isOver && !sortable.isDragging ? 'rgba(74,118,196,0.10)' : 'transparent',
            transition: 'background-color 80ms',
          }}
        >
          <Box {...sortable.attributes} {...sortable.listeners} sx={{ display: 'flex', alignItems: 'center', cursor: 'grab', mr: 0.25 }}>
            <DragIndicatorIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          </Box>
          <IconButton
            size="small"
            onClick={() => ctx.toggleExpanded(folder.id)}
            sx={{ p: 0, mr: 0.25 }}
          >
            {isExpanded
              ? <ExpandMoreIcon sx={{ fontSize: 16 }} />
              : <ChevronRightIcon sx={{ fontSize: 16 }} />}
          </IconButton>
          {isExpanded
            ? <FolderOpenIcon sx={{ fontSize: 16, color: '#f5a623', mr: 0.5 }} />
            : <FolderIcon sx={{ fontSize: 16, color: '#f5a623', mr: 0.5 }} />}
          {isRenaming ? (
            <TextField
              autoFocus
              size="small"
              value={ctx.renameDraft}
              onChange={(e) => ctx.setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') ctx.setRenamingId(null)
              }}
              sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: '0.75rem', py: 0.25 } }}
            />
          ) : (
            <Typography
              variant="body2"
              onDoubleClick={() => {
                ctx.setRenameDraft(folder.name)
                ctx.setRenamingId(folder.id)
              }}
              sx={{ flex: 1, fontWeight: 600, fontSize: '0.75rem' }}
            >
              {folder.name}
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.6rem', mx: 0.5 }}>
            {folder.children.length}
          </Typography>
          <Tooltip title="Delete folder (children promoted up)">
            <IconButton size="small" onClick={() => ctx.onDeleteFolder(folder.id)} sx={{ p: 0.25 }}>
              <DeleteOutlineIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      {isExpanded && (
        <FolderContents folder={folder} depth={depth + 1} {...ctx} />
      )}
    </>
  )
}

function StructureRow({ structure, depth, draggable = false, ...ctx }: { structure: StructureEntry; depth: number; draggable?: boolean } & RowCtx) {
  // Only top-level entries (children of folders) are draggable. Lineage
  // children render under their parent and must NOT register as sortable
  // items — otherwise dragging them moves them into a folder's children
  // and they appear twice (once as folder member, once as lineage child).
  const sortable = useSortable({
    id: structure.file,
    data: { type: 'structure' },
    disabled: !draggable,
  })
  const style: React.CSSProperties = draggable ? {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  } : {}
  const isLoading = ctx.loadingId === structure.id
  const lineageChildren = ctx.lineage.get(structure.file) ?? []
  const hasLineage = lineageChildren.length > 0
  const isExpanded = ctx.expanded.has(structure.file)

  // A row is "in viewer A/B" when its own file matches, OR — for lineage
  // roots — when ANY descendant in its lineage is the loaded file. This
  // handles the click-a-root-with-starred-descendant case: we load the
  // descendant, but the user clicked the root and expects the A/B chip
  // there too. Hint chip already exists on the root; without this, the
  // active marker only appears on the descendant.
  const isFileInOwnLineage = (target: string | null): boolean => {
    if (!target) return false
    if (structure.file === target) return true
    if (structure.parent) return false           // only lineage ROOTS bubble up
    const stack = [...lineageChildren]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur.file)) continue
      seen.add(cur.file)
      if (cur.file === target) return true
      for (const c of (ctx.lineage.get(cur.file) ?? [])) stack.push(c)
    }
    return false
  }
  const inPrimary = isFileInOwnLineage(ctx.fileName)
  const inSecondary = isFileInOwnLineage(ctx.secondaryFileName)
  const isActive = inPrimary || inSecondary

  // Starred-descendant hint chip on lineage roots.
  let starredHintName: string | null = null
  if (!structure.parent && !structure.starred && hasLineage) {
    const stack: StructureEntry[] = [...lineageChildren]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur.file)) continue
      seen.add(cur.file)
      if (cur.starred) { starredHintName = cur.name; break }
      for (const grand of (ctx.lineage.get(cur.file) ?? [])) stack.push(grand)
    }
  }

  return (
    <Box ref={draggable ? sortable.setNodeRef : undefined} style={style}>
      <ListItemButton
        selected={isActive}
        onClick={() => ctx.onLoad(structure)}
        disabled={isLoading}
        sx={{
          borderBottom: '1px solid', borderColor: 'divider',
          borderLeft: isActive ? '3px solid' : '3px solid transparent',
          borderLeftColor: isActive ? 'primary.main' : 'transparent',
          py: 0.75, px: 1, pl: 1 + depth * 1.5,
        }}
      >
        {draggable ? (
          <Box {...sortable.attributes} {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
            sx={{ display: 'flex', alignItems: 'center', cursor: 'grab', mr: 0.25 }}>
            <DragIndicatorIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          </Box>
        ) : (
          <Box sx={{ width: 14, mr: 0.25 }} />
        )}
        <Box sx={{ width: 18, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          {hasLineage ? (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); ctx.toggleExpanded(structure.file) }}
              sx={{ p: 0 }}
            >
              {isExpanded
                ? <ExpandMoreIcon sx={{ fontSize: 16 }} />
                : <ChevronRightIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          ) : depth > 0 ? <SubdirectoryArrowRightIcon sx={{ fontSize: 12, color: 'text.disabled' }} /> : null}
        </Box>
        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography variant="body2" sx={{ fontWeight: depth === 0 ? 600 : 500, fontSize: '0.75rem' }}>
                {structure.name}
              </Typography>
              {structure.command && (
                <Chip label={structure.command} size="small" variant="outlined"
                  sx={{ height: 14, fontSize: '0.55rem', '& .MuiChip-label': { px: 0.5 } }} />
              )}
              {starredHintName && (
                <Tooltip title={`Clicking loads ${starredHintName} (starred descendant)`}>
                  <Chip
                    icon={<StarIcon sx={{ fontSize: 12, color: '#f5a623 !important' }} />}
                    label={`→ ${starredHintName}`}
                    size="small" variant="outlined"
                    sx={{ height: 14, fontSize: '0.55rem', borderColor: '#f5a623', color: '#a0670f',
                      '& .MuiChip-label': { px: 0.5 } }}
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
              {structure.description || structure.file}
            </Typography>
          }
        />
        <Tooltip title={structure.starred ? 'Unstar' : (structure.parent ? 'Star this lineage entry' : 'Star this root')}>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); ctx.onStar(structure.file) }}
            sx={{ p: 0.5, flexShrink: 0 }}
          >
            {structure.starred
              ? <StarIcon sx={{ fontSize: 16, color: '#f5a623' }} />
              : <StarBorderIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
          </IconButton>
        </Tooltip>
      </ListItemButton>

      {/* Lineage children. Render only those NOT explicitly placed in
       *  some folder — those already render where the user put them.
       *  Remaining lineage children render here AND are draggable so
       *  the user can move them out. Wrapped in a SortableContext so
       *  dnd-kit can register / pick them up.
       */}
      {hasLineage && isExpanded && (() => {
        const visible = lineageChildren.filter(c => !ctx.placedInFolder.has(c.file))
        if (visible.length === 0) return null
        return (
          <SortableContext items={visible.map(c => c.file)} strategy={verticalListSortingStrategy}>
            {visible.map(child => (
              <StructureRow key={child.file} structure={child} depth={depth + 1} draggable {...ctx} />
            ))}
          </SortableContext>
        )
      })()}
    </Box>
  )
}
