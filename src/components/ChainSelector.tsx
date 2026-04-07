import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import { useStructureStore } from '../stores/structureStore'

const NON_SEQ_COMPS = new Set([
  'HOH', 'WAT', 'DOD', 'H2O',
  'ZN', 'MG', 'CA', 'FE', 'MN', 'CO', 'NI', 'CU', 'NA', 'K',
  'CL', 'BR', 'SO4', 'PO4', 'NO3', 'CD', 'HG', 'SR', 'BA',
])

export function ChainSelector({ value, onChange }: { value?: string | null; onChange?: (chainId: string) => void } = {}) { // @dsp obj-a1000008
  const allChains = useStructureStore((s) => s.chains)

  const chains = allChains
    .map(c => ({ ...c, residues: c.residues.filter(r => !NON_SEQ_COMPS.has(r.compId)) }))
    .filter(c => c.residues.length > 1)

  if (chains.length <= 1) return null

  return (
    <FormControl size="small" sx={{ minWidth: 100 }}>
      <Select
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        sx={{ fontSize: '0.75rem', height: 28 }}
      >
        {chains.map((c) => (
          <MenuItem key={c.id} value={c.id} sx={{ fontSize: '0.75rem' }}>
            Chain {c.id} ({c.residues.length} residues)
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}
