import { useCallback, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
  DataGrid,
  type GridColDef,
  type GridRowModel,
  type GridRowsProp,
} from '@mui/x-data-grid'

interface Mutation {
  id: number
  chain: string
  mutation_name: string
  mutations: string
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
        body: JSON.stringify({ chain: '', mutation_name: '', mutations: '' }),
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

  const columns: GridColDef[] = [
    { field: 'id', headerName: 'ID', width: 70, type: 'number' },
    { field: 'chain', headerName: 'Chain', width: 90, editable: true },
    { field: 'mutation_name', headerName: 'Mutation Name', width: 180, editable: true },
    {
      field: 'mutations',
      headerName: 'Mutations',
      flex: 1,
      minWidth: 240,
      editable: true,
      description: 'Comma-separated list, e.g. M252Y,S254T,T256E',
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
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
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

      <Box sx={{ flex: 1, p: 1 }}>
        <DataGrid
          rows={gridRows}
          columns={columns}
          loading={loading}
          processRowUpdate={processRowUpdate}
          density="compact"
          disableRowSelectionOnClick
          sx={{
            fontSize: '0.75rem',
            '& .MuiDataGrid-columnHeader': { fontSize: '0.7rem', fontWeight: 700 },
          }}
        />
      </Box>
    </Box>
  )
}
