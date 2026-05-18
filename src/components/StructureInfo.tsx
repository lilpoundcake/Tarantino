import { useEffect, useRef } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Paper from '@mui/material/Paper'
import { useStructureStore, type StructureMeta } from '../stores/structureStore'

const META_FIELDS: Array<keyof StructureMeta> = ['name', 'organism', 'method', 'resolution', 'description']

export function StructureInfo() {
  const meta = useStructureStore((s) => s.meta)
  const setMeta = useStructureStore((s) => s.setMeta)
  const fileName = useStructureStore((s) => s.fileName)
  const chains = useStructureStore((s) => s.chains)
  const elements = useStructureStore((s) => s.elements)
  const bumpLibraryVersion = useStructureStore((s) => s.bumpLibraryVersion)

  // Persist meta edits to the backend (per-file in structures/index.json).
  // Debounced so we don't write on every keystroke. Resets when the loaded
  // file changes so the new structure's meta isn't immediately overwritten
  // by the just-loaded values.
  const lastSavedFileRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const initialMetaRef = useRef<StructureMeta | null>(null)

  useEffect(() => {
    // When the loaded file changes, snapshot the meta-on-load. Subsequent
    // saves only fire if any field differs from the snapshot.
    initialMetaRef.current = { ...meta }
    lastSavedFileRef.current = fileName
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName])

  useEffect(() => {
    if (!fileName) return
    if (lastSavedFileRef.current !== fileName) return // file just switched
    if (!initialMetaRef.current) return
    // Compare against the initial snapshot
    const changed = META_FIELDS.some(k => meta[k] !== initialMetaRef.current![k])
    if (!changed) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        await fetch('/api/library/meta', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: fileName,
            name: meta.name,
            organism: meta.organism,
            method: meta.method,
            resolution: meta.resolution,
            description: meta.description,
          }),
        })
        initialMetaRef.current = { ...meta }
        // Tell the library to re-fetch so the row's name / description
        // reflects the just-saved values.
        bumpLibraryVersion()
      } catch (err) {
        console.warn('[info] failed to persist meta:', err)
      }
    }, 500)
    return () => clearTimeout(debounceRef.current)
  }, [meta, fileName, bumpLibraryVersion])

  if (!fileName) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Load a structure to see its info</Typography>
      </Box>
    )
  }

  const totalResidues = chains.reduce((s, c) => s + c.residues.length, 0)
  const totalAtoms = elements.reduce((s, e) => s + e.atomCount, 0)

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 1.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        File
      </Typography>
      <Paper variant="outlined" sx={{ px: 1.5, py: 1, mt: 0.5, mb: 2, fontFamily: 'monospace', fontSize: '0.75rem' }}>
        {fileName}
      </Paper>

      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        Metadata
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5, mb: 2 }}>
        <TextField label="Name" value={meta.name} onChange={(e) => setMeta({ name: e.target.value })} fullWidth />
        <TextField label="Organism" value={meta.organism} onChange={(e) => setMeta({ organism: e.target.value })} fullWidth />
        <TextField label="Method" value={meta.method} onChange={(e) => setMeta({ method: e.target.value })} fullWidth />
        <TextField label="Resolution" value={meta.resolution} onChange={(e) => setMeta({ resolution: e.target.value })} placeholder="e.g. 2.0 A" fullWidth />
      </Box>

      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        Notes
      </Typography>
      <TextField
        value={meta.description}
        onChange={(e) => setMeta({ description: e.target.value })}
        placeholder="Add notes about this structure..."
        multiline
        minRows={3}
        fullWidth
        sx={{ mt: 0.5, mb: 2 }}
      />

      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        Summary
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mt: 0.5 }}>
        <StatCard label="Chains" value={chains.length} />
        <StatCard label="Residues" value={totalResidues} />
        <StatCard label="Atoms" value={totalAtoms} />
        <StatCard label="Elements" value={elements.length} />
      </Box>
    </Box>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
      <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1rem' }}>
        {value.toLocaleString()}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{label}</Typography>
    </Paper>
  )
}
