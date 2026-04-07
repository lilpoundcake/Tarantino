import { useCallback, useEffect, useState } from 'react'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import RefreshIcon from '@mui/icons-material/Refresh'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'

interface StructureEntry {
  id: string
  file: string
  name: string
  organism: string
  chains: number
  residues: number
  description: string
}

export function StructureLibrary(_props: { onClose?: () => void }) {
  const [entries, setEntries] = useState<StructureEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const plugin = useStructureStore((s) => s.plugin)
  const setFileName = useStructureStore((s) => s.setFileName)
  const setStoreLoading = useStructureStore((s) => s.setLoading)
  const setStoreError = useStructureStore((s) => s.setError)
  const fileName = useStructureStore((s) => s.fileName)
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

  useEffect(() => { fetchIndex() }, [fetchIndex])

  const loadStructure = useCallback(async (entry: StructureEntry) => {
    if (!plugin) return
    setLoadingId(entry.id)
    setStoreLoading(true)
    setStoreError(null)
    clearSelection()

    try {
      const res = await fetch(`/structures/${entry.file}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const format = entry.file.endsWith('.cif') || entry.file.endsWith('.mmcif') ? 'mmcif' : 'pdb'

      await plugin.clear()
      const data = await plugin.builders.data.rawData({ data: text, label: entry.file })
      const trajectory = await plugin.builders.structure.parseTrajectory(data, format)
      await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')
      setFileName(entry.file)
    } catch (err: any) {
      setStoreError(`Failed to load ${entry.name}: ${err.message}`)
    } finally {
      setStoreLoading(false)
      setLoadingId(null)
    }
  }, [plugin, setFileName, setStoreLoading, setStoreError, clearSelection])

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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Library
        </Typography>
        <IconButton size="small" onClick={fetchIndex} sx={{ p: 0.5 }}>
          <RefreshIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
      <List dense disablePadding sx={{ flex: 1, overflow: 'auto' }}>
        {entries.map((entry) => {
          const isActive = fileName === entry.file
          const isLoading = loadingId === entry.id
          return (
            <ListItemButton
              key={entry.id}
              selected={isActive}
              onClick={() => loadStructure(entry)}
              disabled={isLoading}
              sx={{
                borderBottom: '1px solid',
                borderColor: 'divider',
                borderLeft: isActive ? '3px solid' : '3px solid transparent',
                borderLeftColor: isActive ? 'primary.main' : 'transparent',
                py: 1, px: 1.5,
              }}
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.75rem' }}>
                      {entry.name}
                    </Typography>
                    {isLoading && <CircularProgress size={12} />}
                    {isActive && !isLoading && (
                      <Chip label="LOADED" size="small" color="primary" sx={{ height: 16, fontSize: '0.6rem' }} />
                    )}
                  </Box>
                }
                secondary={
                  <>
                    <Typography component="span" variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {entry.id} · {entry.chains} chain{entry.chains > 1 ? 's' : ''} · {entry.residues} res
                    </Typography>
                    <br />
                    <Typography component="span" variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
                      {entry.description}
                    </Typography>
                  </>
                }
              />
            </ListItemButton>
          )
        })}
      </List>
      <Box sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6rem' }}>
          Add files to <code>structures/</code> + update <code>index.json</code>
        </Typography>
      </Box>
    </Box>
  )
}
