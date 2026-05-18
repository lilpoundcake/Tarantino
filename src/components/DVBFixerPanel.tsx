import { useState, useEffect, useCallback, useMemo } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import TextField from '@mui/material/TextField'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { useStructureStore } from '../stores/structureStore'

// Re-declare the spec types here (mirrors server/dvbfixer-spec.ts) so the
// frontend doesn't have to import server/. The actual spec is fetched at
// runtime from /api/dvbfixer-spec.
interface FlagDef {
  flag: string
  label: string
  type: 'bool' | 'number' | 'text' | 'select'
  default?: string | number | boolean
  options?: string[]
  min?: number
  max?: number
  step?: number
  help?: string
}
interface CommandDef {
  name: string
  label: string
  description: string
  flags: FlagDef[]
}

interface StructureEntry {
  id: string
  file: string
  name: string
}

interface RunResult {
  ok: boolean
  command: string
  outputFile: string
  outputDir: string
  /** When the run failed, the output folder is moved here (relative to structures/). */
  movedTo?: string | null
  stdout: string
  stderr: string
  exitCode: number
}

export function DVBFixerPanel() {
  const [commands, setCommands] = useState<CommandDef[]>([])
  const [tabIdx, setTabIdx] = useState(0)
  const [structures, setStructures] = useState<StructureEntry[]>([])
  const [inputFile, setInputFile] = useState<string>('')
  const [values, setValues] = useState<Record<string, Record<string, any>>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchSpec = useCallback(() => {
    fetch(`/api/dvbfixer-spec?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(`spec ${r.status}`))
      .then((data: CommandDef[]) => {
        setCommands(data)
        setValues(prev => {
          // Preserve user-entered values per command; only fill in defaults
          // for newly-arrived commands.
          const next = { ...prev }
          for (const c of data) {
            if (!next[c.name]) {
              next[c.name] = {}
              for (const f of c.flags) {
                if (f.default !== undefined) next[c.name][f.flag] = f.default
              }
            } else {
              // Fill in defaults for any newly-added flags
              for (const f of c.flags) {
                if (next[c.name][f.flag] === undefined && f.default !== undefined) {
                  next[c.name][f.flag] = f.default
                }
              }
            }
          }
          return next
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => { fetchSpec() }, [fetchSpec])

  const refreshStructures = useCallback(() => {
    fetch('/structures/index.json')
      .then(r => r.ok ? r.json() : [])
      .then((data: StructureEntry[]) => {
        setStructures(data)
        // pick a sensible default input
        if (data.length > 0 && !inputFile) {
          // Prefer a .pdb file not in a dvb_ subdir
          const pick = data.find(d => !d.file.startsWith('dvb_')) ?? data[0]
          setInputFile(pick.file)
        }
      })
      .catch(() => {})
  }, [inputFile])

  useEffect(() => { refreshStructures() }, [refreshStructures])

  const activeCmd = commands[tabIdx]
  const activeValues = activeCmd ? values[activeCmd.name] ?? {} : {}

  const setFlagValue = useCallback((cmd: string, flag: string, v: any) => {
    setValues(prev => ({ ...prev, [cmd]: { ...(prev[cmd] ?? {}), [flag]: v } }))
  }, [])

  const handleRun = useCallback(async () => {
    if (!activeCmd || !inputFile) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/dvbfixer/${activeCmd.name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputFile, values: activeValues }),
      })
      const body = await res.json() as RunResult & { error?: string }
      if (!res.ok) {
        setError(body.error || `HTTP ${res.status}`)
        if (body.stdout || body.stderr) setResult(body as RunResult)
      } else {
        setResult(body as RunResult)
      }
      // Refresh local input list + notify other components (Library) to refetch
      setTimeout(refreshStructures, 200)
      useStructureStore.getState().bumpLibraryVersion()
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setRunning(false)
    }
  }, [activeCmd, inputFile, activeValues, refreshStructures])

  const inputOptions = useMemo(
    () => structures.filter(s => /\.(pdb|cif|mmcif)$/i.test(s.file)),
    [structures]
  )

  if (commands.length === 0) {
    return (
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <CircularProgress size={20} />
        <Typography variant="caption" color="text.secondary">
          Loading DVBFixer command specs…
        </Typography>
        <Typography variant="caption" color="text.secondary">
          If this never finishes, check that the dev server has access to <code>/api/dvbfixer-spec</code>.
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Command tabs */}
      <Tabs
        value={tabIdx}
        onChange={(_e, v) => setTabIdx(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{
          minHeight: 30,
          borderBottom: 1, borderColor: 'divider',
          '& .MuiTab-root': { minHeight: 30, py: 0.5, fontSize: '0.7rem', textTransform: 'none', fontWeight: 600 },
        }}
      >
        {commands.map(c => (<Tab key={c.name} label={c.label} />))}
      </Tabs>

      {/* Body */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {activeCmd && (
          <>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {activeCmd.description}
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <FormControl size="small" sx={{ minWidth: 240 }}>
                <InputLabel sx={{ fontSize: '0.75rem' }}>Input file</InputLabel>
                <Select
                  label="Input file"
                  value={inputFile}
                  onChange={(e) => setInputFile(e.target.value)}
                  sx={{ fontSize: '0.75rem' }}
                >
                  {inputOptions.map(s => (
                    <MenuItem key={s.file} value={s.file} sx={{ fontSize: '0.75rem' }}>
                      {s.file}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Button
                variant="contained"
                size="small"
                disabled={running || !inputFile}
                onClick={handleRun}
                startIcon={running ? <CircularProgress size={12} sx={{ color: 'white' }} /> : <PlayArrowIcon sx={{ fontSize: 16 }} />}
              >
                Run {activeCmd.label}
              </Button>

              <Tooltip title="Reload command specs (pick up new DVBFixer subcommands without page reload)">
                <IconButton size="small" onClick={() => { fetchSpec(); refreshStructures() }}>
                  <RefreshIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>

              {result && result.ok && (
                <Chip label={`OK · ${result.outputFile}`} color="success" size="small" />
              )}
              {result && !result.ok && (
                <Chip
                  label={result.movedTo ? `Exit ${result.exitCode} · moved to ${result.movedTo}` : `Exit ${result.exitCode}`}
                  color="error"
                  size="small"
                />
              )}
            </Box>

            {error && <Alert severity="error" sx={{ py: 0.25, fontSize: '0.75rem' }}>{error}</Alert>}

            <Divider />

            {/* Flag controls */}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}>
              {activeCmd.flags.map(f => (
                <FlagControl
                  key={f.flag}
                  flag={f}
                  value={activeValues[f.flag]}
                  onChange={(v) => setFlagValue(activeCmd.name, f.flag, v)}
                />
              ))}
            </Box>

            {result && (result.stdout || result.stderr) && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                  Output
                </Typography>
                {result.stdout && (
                  <Box component="pre" sx={{
                    bgcolor: '#fafafa', p: 1, mt: 0.5,
                    border: 1, borderColor: 'divider', borderRadius: 1,
                    fontSize: '0.7rem', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                  }}>{result.stdout}</Box>
                )}
                {result.stderr && (
                  <Box component="pre" sx={{
                    bgcolor: '#fff5f5', p: 1, mt: 0.5,
                    border: 1, borderColor: 'error.light', borderRadius: 1,
                    fontSize: '0.7rem', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                    color: 'error.dark',
                  }}>{result.stderr}</Box>
                )}
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}

function FlagControl({ flag, value, onChange }: { flag: FlagDef; value: any; onChange: (v: any) => void }) {
  if (flag.type === 'bool') {
    return (
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
        }
        label={
          <Box>
            <Typography variant="caption" sx={{ display: 'block', fontSize: '0.75rem' }}>
              {flag.label}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: '0.65rem' }}>
              {flag.flag}
            </Typography>
          </Box>
        }
        sx={{ alignItems: 'flex-start', m: 0 }}
      />
    )
  }
  if (flag.type === 'select') {
    return (
      <FormControl size="small" fullWidth>
        <InputLabel sx={{ fontSize: '0.75rem' }}>{flag.label}</InputLabel>
        <Select
          label={flag.label}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          sx={{ fontSize: '0.75rem' }}
        >
          {(flag.options ?? []).map(opt => (
            <MenuItem key={opt} value={opt} sx={{ fontSize: '0.75rem' }}>{opt}</MenuItem>
          ))}
        </Select>
        {flag.help && <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.25, fontSize: '0.65rem' }}>{flag.help}</Typography>}
      </FormControl>
    )
  }
  // number / text
  return (
    <TextField
      size="small"
      label={flag.label}
      value={value ?? ''}
      onChange={(e) => onChange(flag.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
      type={flag.type === 'number' ? 'number' : 'text'}
      slotProps={{
        ...(flag.type === 'number' ? { htmlInput: { step: flag.step, min: flag.min, max: flag.max } } : {}),
        inputLabel: { sx: { fontSize: '0.75rem' } },
      }}
      helperText={flag.help}
      sx={{ '& .MuiInputBase-input': { fontSize: '0.75rem' }, '& .MuiFormHelperText-root': { fontSize: '0.65rem' } }}
    />
  )
}
