import { useCallback, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Chip from '@mui/material/Chip'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Checkbox from '@mui/material/Checkbox'
import ListItemText from '@mui/material/ListItemText'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
  DataGrid,
  GridRow,
  useGridApiContext,
  type GridColDef,
  type GridRenderCellParams,
  type GridRenderEditCellParams,
  type GridRowModel,
  type GridRowProps,
  type GridRowsProp,
} from '@mui/x-data-grid'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface Mutation {
  id: number
  chain: string
  mutation_name: string
  mutations: string
  /** Persisted row ordering. Lower = higher in list. */
  display_order: number
  /** Comma-separated subclasses, e.g. "IgG1,IgG4". Empty string when none. */
  igg_subclass: string
  /** Free-form notes / annotations (effect, source paper, etc.). */
  properties: string
}

const IGG_SUBCLASSES = ['IgG1', 'IgG2', 'IgG3', 'IgG4']
const CHAIN_TYPES = ['', 'HC', 'LC']

/** Parse the stored comma-separated subclass string into an array. */
function parseSubclasses(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Display cell for the IgG Subclass column. Renders the selected subclasses
 * as small chips so multi-selections stay readable in the table.
 */
function SubclassRenderCell(params: GridRenderCellParams) {
  const selected = parseSubclasses(params.value)
  if (selected.length === 0) {
    return <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>—</Typography>
  }
  return (
    <Box sx={{ display: 'flex', gap: 0.25, flexWrap: 'wrap', alignItems: 'center', height: '100%' }}>
      {selected.map(s => (
        <Chip key={s} label={s} size="small" sx={{ height: 18, fontSize: '0.65rem', '& .MuiChip-label': { px: 0.75 } }} />
      ))}
    </Box>
  )
}

/**
 * Editable cell for the IgG Subclass column. Multi-select with checkboxes;
 * commits a comma-joined string back to the row so the underlying TEXT
 * column stores all picks together.
 *
 * The dropdown auto-opens on edit-mode entry, then closes (and commits) on
 * any of: click outside the popover, click the Select's chevron, or pressing
 * Escape. Each check / uncheck inside the open dropdown live-updates the
 * edit value via setEditCellValue, so whatever is checked at close time is
 * what gets saved.
 */
function SubclassEditCell(params: GridRenderEditCellParams) {
  const { id, field, value } = params
  const apiRef = useGridApiContext()
  const selected = parseSubclasses(value)
  return (
    <Select
      multiple
      value={selected}
      onChange={(e) => {
        const next = (typeof e.target.value === 'string'
          ? e.target.value.split(',')
          : (e.target.value as string[]))
          .filter(Boolean)
        // Persist the user's pick order so the chips render predictably.
        apiRef.current.setEditCellValue({ id, field, value: next.join(',') })
      }}
      renderValue={(sel) => (sel as string[]).join(', ')}
      // defaultOpen lets MUI defer the initial popover layout until the
      // Select's DOM anchor is mounted — a controlled `open={true}` on
      // mount makes Popover read the anchor's rect before layout and
      // crashes the render.
      defaultOpen
      onClose={() => {
        // Defer so the popover's own close transition completes before
        // DataGrid unmounts this edit cell — calling stopCellEditMode
        // synchronously here races with Popover cleanup and surfaces as
        // "Error rendering component".
        setTimeout(() => {
          apiRef.current.stopCellEditMode({ id, field })
        }, 0)
      }}
      sx={{ width: '100%', fontSize: '0.75rem', '& .MuiSelect-select': { py: 0.5 } }}
    >
      {IGG_SUBCLASSES.map(opt => (
        <MenuItem key={opt} value={opt} dense>
          <Checkbox checked={selected.includes(opt)} size="small" sx={{ p: 0.5 }} />
          <ListItemText primary={opt} slotProps={{ primary: { sx: { fontSize: '0.75rem' } } }} />
        </MenuItem>
      ))}
    </Select>
  )
}

/**
 * Custom DataGrid row that registers as a `useSortable` item. Wraps
 * Mol*'s built-in `GridRow` (so we preserve every native DataGrid
 * behavior: virtualization, cell editing, classNames, etc.) and
 * attaches drag-listener props from @dnd-kit.
 *
 * Activation requires an 8px drag — single clicks pass through to
 * DataGrid normally (so cell-edit double-clicks aren't hijacked).
 */
function SortableRow(props: GridRowProps) {
  const sortable = useSortable({ id: props.rowId })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    // The transform Layer must sit ABOVE adjacent rows during drag so
    // the moving row visually floats over its destination.
    zIndex: sortable.isDragging ? 1 : undefined,
    opacity: sortable.isDragging ? 0.6 : 1,
  }
  return (
    <GridRow
      ref={sortable.setNodeRef as any}
      {...props}
      {...sortable.attributes}
      {...sortable.listeners}
      style={{ ...(props as any).style, ...style }}
    />
  )
}

export function MutationsPanel() {
  const [rows, setRows] = useState<Mutation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/mutations')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then((data: Mutation[]) => setRows(data))
      .catch((e) => setError(e.message ?? String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleAdd = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/mutations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: '', mutation_name: '', mutations: '', igg_subclass: '', properties: '' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const created = await res.json()
      setRows(prev => [...prev, created])
    } catch (e: any) {
      setError(e.message ?? String(e))
    }
  }, [])

  const handleDelete = useCallback(async (id: number) => {
    setError(null)
    try {
      const res = await fetch(`/api/mutations/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setRows(prev => prev.filter(r => r.id !== id))
    } catch (e: any) {
      setError(e.message ?? String(e))
    }
  }, [])

  // Edit-commit handler: called by DataGrid on cell edit commit
  const processRowUpdate = useCallback(async (newRow: GridRowModel, oldRow: GridRowModel) => {
    const id = newRow.id as number
    const patch: Partial<Mutation> = {}
    if (newRow.chain !== oldRow.chain) patch.chain = newRow.chain as string
    if (newRow.mutation_name !== oldRow.mutation_name) patch.mutation_name = newRow.mutation_name as string
    if (newRow.mutations !== oldRow.mutations) patch.mutations = newRow.mutations as string
    if (newRow.igg_subclass !== oldRow.igg_subclass) patch.igg_subclass = newRow.igg_subclass as string
    if (newRow.properties !== oldRow.properties) patch.properties = newRow.properties as string
    if (Object.keys(patch).length === 0) return oldRow
    try {
      const res = await fetch(`/api/mutations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const saved = await res.json()
      return saved
    } catch (e: any) {
      setError(e.message ?? String(e))
      return oldRow
    }
  }, [])

  /* ── Drag-drop row reordering ─────────────────────────────────── */
  // PointerSensor only. We intentionally drop KeyboardSensor because
  // useSortable.listeners would otherwise attach an onKeyDown to the
  // whole row that intercepts Space / Enter to start a drag — when the
  // user types Space inside an editable cell (e.g. Properties), the
  // event bubbles to the row, dnd-kit calls preventDefault, and the
  // space character is never inserted.
  // 8px activation distance so single-clicks pass through to DataGrid
  // (cell-edit double-clicks aren't hijacked).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = rows.findIndex(r => r.id === active.id)
    const newIndex = rows.findIndex(r => r.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(rows, oldIndex, newIndex)
    // Optimistic update — rows update immediately, server resyncs on
    // success (or rolls back via setError on failure).
    setRows(next)
    try {
      const res = await fetch('/api/mutations/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map(r => r.id) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
    } catch (e: any) {
      setError(e.message ?? String(e))
      // Roll back on failure by refetching the canonical order.
      refresh()
    }
  }, [rows, refresh])

  const columns: GridColDef[] = [
    { field: 'id', headerName: 'ID', width: 70, type: 'number' },
    {
      field: 'igg_subclass',
      headerName: 'IgG Subclass',
      width: 160,
      editable: true,
      renderCell: SubclassRenderCell,
      renderEditCell: SubclassEditCell,
      // Sort + filter by the joined string — good enough for "rows
      // tagged with IgG1" style queries.
      sortComparator: (a, b) => parseSubclasses(a).join(',').localeCompare(parseSubclasses(b).join(',')),
    },
    {
      field: 'chain',
      headerName: 'Chain',
      width: 90,
      editable: true,
      type: 'singleSelect',
      valueOptions: CHAIN_TYPES,
    },
    { field: 'mutation_name', headerName: 'Mutation Name', width: 180, editable: true },
    {
      field: 'mutations',
      headerName: 'Mutations',
      width: 240,
      editable: true,
      description: 'Comma-separated list, e.g. M252Y,S254T,T256E',
    },
    {
      field: 'properties',
      headerName: 'Properties',
      flex: 1,
      minWidth: 200,
      editable: true,
      description: 'Free-form notes about this mutation (effect, source paper, etc.)',
    },
    {
      field: 'actions',
      headerName: '',
      width: 60,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderCell: (params) => (
        <Tooltip title="Delete">
          <IconButton size="small" onClick={() => handleDelete(params.row.id)}>
            <DeleteIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      ),
    },
  ]

  const gridRows: GridRowsProp = rows

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* Fixed-at-top header. It's a flex *sibling* of the scroll region
       *  below; the DataGrid handles its own scroll, so the header stays
       *  visible without needing position: sticky. flexShrink: 0 makes
       *  sure it doesn't get squeezed when rows are added. */}
      <Box sx={{
        px: 1.5, py: 1,
        borderBottom: 1, borderColor: 'divider',
        display: 'flex', alignItems: 'center', gap: 1,
        flexShrink: 0,
        bgcolor: 'background.paper',
      }}>
        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, mr: 'auto' }}>
          Mutations
        </Typography>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={refresh}><RefreshIcon sx={{ fontSize: 16 }} /></IconButton>
        </Tooltip>
        <Button size="small" variant="contained" startIcon={<AddIcon sx={{ fontSize: 14 }} />} onClick={handleAdd} sx={{ fontSize: '0.7rem' }}>
          Add row
        </Button>
      </Box>

      {error && (
        <Alert severity={error.includes('DATABASE_URL') ? 'info' : 'error'} sx={{ m: 1, py: 0.25, fontSize: '0.75rem' }}>
          {error}
          {error.includes('DATABASE_URL') && (
            <Box sx={{ mt: 0.5, fontSize: '0.7rem', color: 'text.secondary' }}>
              Set <code>DATABASE_URL=postgres://user:pass@host:port/db</code> before running <code>npm run dev</code>.
              The <code>mutations</code> table is auto-created on first connection.
            </Box>
          )}
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0, p: 1 }}>
        {/* Drag-drop reordering. SortableContext.items = ordered list of
         *  row ids; slots.row replaces the native row with a
         *  useSortable-wired version. 8px activation distance lets
         *  single clicks pass through to DataGrid's cell-edit
         *  machinery. */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
            <DataGrid
              rows={gridRows}
              columns={columns}
              loading={loading}
              processRowUpdate={processRowUpdate}
              density="compact"
              disableRowSelectionOnClick
              slots={{ row: SortableRow }}
              // Don't sort by clicking column headers — would conflict
              // with the persisted drag-drop ordering. Manual reorder
              // is the only sort mechanism.
              disableColumnSorting
              // Zebra striping.
              getRowClassName={(params) =>
                params.indexRelativeToCurrentPage % 2 === 0 ? 'tarantino-row-even' : 'tarantino-row-odd'
              }
              sx={{
                fontSize: '0.75rem',
                '& .MuiDataGrid-columnHeader': { fontSize: '0.7rem', fontWeight: 700 },
                '& .tarantino-row-odd': { backgroundColor: 'rgba(74, 118, 196, 0.04)' },
                '& .MuiDataGrid-row': { cursor: 'grab' },
                '& .MuiDataGrid-row:hover': { backgroundColor: 'rgba(74, 118, 196, 0.10)' },
                '& .MuiDataGrid-row:active': { cursor: 'grabbing' },
                // Halve the "Rows per page" footer height. MUI's default
                // toolbar/footer is ~52px; we squeeze its minHeight and
                // tighten internal padding + font size so the pagination
                // controls don't dominate the panel.
                '& .MuiDataGrid-footerContainer': {
                  minHeight: 26,
                },
                '& .MuiTablePagination-root': {
                  minHeight: 26,
                  fontSize: '0.7rem',
                },
                '& .MuiTablePagination-toolbar': {
                  minHeight: 26,
                  py: 0,
                  pl: 1,
                },
                '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                  fontSize: '0.7rem',
                  m: 0,
                },
                '& .MuiTablePagination-select': {
                  fontSize: '0.7rem',
                  py: 0,
                },
                '& .MuiTablePagination-actions .MuiIconButton-root': {
                  padding: 0.25,
                },
              }}
            />
          </SortableContext>
        </DndContext>
      </Box>
    </Box>
  )
}
