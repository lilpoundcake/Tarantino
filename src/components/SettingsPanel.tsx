import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import { useStructureStore } from '../stores/structureStore'

/**
 * App-wide preferences. Currently a single toggle for auto-orienting
 * structures to their principal axes on load. Settings persist in
 * localStorage via the store (see `setAutoOrientOnLoad`).
 */
export function SettingsPanel() {
  const autoOrientOnLoad = useStructureStore(s => s.autoOrientOnLoad)
  const setAutoOrientOnLoad = useStructureStore(s => s.setAutoOrientOnLoad)

  return (
    <Box sx={{ p: 1.5, height: '100%', overflow: 'auto' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        Viewer
      </Typography>
      <Paper variant="outlined" sx={{ p: 1.5, mt: 0.5 }}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={autoOrientOnLoad}
              onChange={(_e, checked) => setAutoOrientOnLoad(checked)}
            />
          }
          label={
            <Box>
              <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>
                Auto-orient on load
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
                When ON, every loaded structure is rotated to its principal
                axes (Mol*'s "Orient Axes" command). When OFF, the structure
                keeps its authored orientation. Default: OFF.
              </Typography>
            </Box>
          }
          sx={{ alignItems: 'flex-start', m: 0, '& .MuiFormControlLabel-label': { ml: 0.5 } }}
        />
      </Paper>
    </Box>
  )
}
