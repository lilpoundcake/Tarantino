import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Paper from '@mui/material/Paper'
import { useStructureStore } from '../stores/structureStore'

export function StructureInfo() {
  const meta = useStructureStore((s) => s.meta)
  const setMeta = useStructureStore((s) => s.setMeta)
  const fileName = useStructureStore((s) => s.fileName)
  const chains = useStructureStore((s) => s.chains)
  const elements = useStructureStore((s) => s.elements)

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
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mt: 0.5 }}>
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
