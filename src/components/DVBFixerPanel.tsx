import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
import { chainToSequence } from '../lib/alignment'
import { filterSequenceableChains } from '../lib/chain-grouping'

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
      })
      .catch(() => {})
  }, [])

  useEffect(() => { refreshStructures() }, [refreshStructures])

  // Keep the input dropdown in sync with the currently-loaded structure in
  // the PRIMARY 3D viewer. When the user loads / switches structures, the
  // DVBFixer input auto-updates to match. The user can still pick something
  // else from the dropdown manually.
  const primaryFileName = useStructureStore((s) => s.fileName)
  const userPickedInputRef = useRef(false)
  useEffect(() => {
    if (!primaryFileName) return
    // Only auto-sync if the user hasn't manually picked something different.
    if (!userPickedInputRef.current || inputFile === '') {
      setInputFile(primaryFileName)
    }
  }, [primaryFileName, inputFile])

  // Fallback default on first load if there's no primary structure: pick
  // a non-dvb root file.
  useEffect(() => {
    if (inputFile === '' && structures.length > 0 && !primaryFileName) {
      const pick = structures.find(d => !d.file.startsWith('dvb_')) ?? structures[0]
      setInputFile(pick.file)
    }
  }, [structures, inputFile, primaryFileName])

  const handleInputFileChange = useCallback((file: string) => {
    userPickedInputRef.current = true
    setInputFile(file)
  }, [])

  const activeCmd = commands[tabIdx]
  const activeValues = activeCmd ? values[activeCmd.name] ?? {} : {}

  const setFlagValue = useCallback((cmd: string, flag: string, v: any) => {
    setValues(prev => ({ ...prev, [cmd]: { ...(prev[cmd] ?? {}), [flag]: v } }))
  }, [])

  /* ── Model tab: per-chain FASTA inputs ─────────────────────────────
   * The model command takes --fasta <path>. To save users the hassle
   * of writing a FASTA file themselves, we render a textarea per chain
   * of the loaded primary structure. The contents are concatenated into
   * a real FASTA string and shipped as `fastaContent` in the request
   * body; the backend writes it to a file beside the output and injects
   * `--fasta <path>` into the args automatically.
   */
  const primaryChains = useStructureStore((s) => s.chains)
  const primaryFileNameStore = useStructureStore((s) => s.fileName)
  const inputMatchesLoaded = !!primaryFileNameStore && primaryFileNameStore === inputFile

  // Polypeptide chains only; drops water/ion/glycan etc.
  const seqChains = useMemo(() => {
    if (!inputMatchesLoaded) return []
    return filterSequenceableChains(primaryChains)
  }, [primaryChains, inputMatchesLoaded])

  // Map<chainId, sequence string>. Edited by the user.
  const [fastaByChain, setFastaByChain] = useState<Record<string, string>>({})

  // Reset when the user switches inputs (different structure → different chains).
  useEffect(() => {
    setFastaByChain({})
  }, [inputFile])

  const parseFromPdb = useCallback(() => {
    if (seqChains.length === 0) return
    const next: Record<string, string> = {}
    for (const c of seqChains) {
      // Use the full SEQRES-aware sequence (chainToSequence maps every
      // compId to a 1-letter code; SEQRES-only residues get included
      // since they're already in c.residues with present:false).
      next[c.id] = chainToSequence(c.residues)
    }
    setFastaByChain(next)
  }, [seqChains])

  const setChainFasta = useCallback((chainId: string, value: string) => {
    setFastaByChain(prev => ({ ...prev, [chainId]: value }))
  }, [])

  // Build the FASTA file content from the per-chain text fields. One
  // record per chain that has non-empty content. Wraps sequences at
  // 60 chars per FASTA convention. Returns '' when no chain is set
  // (no content shipped).
  const buildFastaContent = useCallback((): string => {
    const parts: string[] = []
    const inputBase = inputFile.replace(/\.(pdb|cif|mmcif)$/i, '').replace(/.*\//, '')
    for (const c of seqChains) {
      const raw = (fastaByChain[c.id] ?? '').replace(/\s+/g, '')
      if (raw.length === 0) continue
      parts.push(`>${inputBase}_${c.id}`)
      for (let i = 0; i < raw.length; i += 60) parts.push(raw.slice(i, i + 60))
    }
    return parts.length === 0 ? '' : parts.join('\n') + '\n'
  }, [seqChains, fastaByChain, inputFile])

  const handleRun = useCallback(async () => {
    if (!activeCmd || !inputFile) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      // For the `model` tab, materialise the per-chain text inputs into
      // a real FASTA string; backend writes it to a file and injects
      // --fasta automatically. Empty string = nothing shipped (backend
      // ignores).
      const fastaContent = activeCmd.name === 'model' ? buildFastaContent() : ''
      const res = await fetch(`/api/dvbfixer/${activeCmd.name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputFile, values: activeValues, fastaContent }),
      })
      const body = await res.json() as RunResult & { error?: string }
      if (!res.ok) {
        setError(body.error || `HTTP ${res.status}`)
        if (body.stdout || body.stderr) setResult(body as RunResult)
      } else {
        setResult(body as RunResult)
        // Auto-load the freshly-produced output into the PRIMARY 3D viewer.
        const outputFile = body.outputFile
        const plugin = useStructureStore.getState().plugin
        if (plugin && outputFile) {
          try {
            const fileRes = await fetch(`/structures/${encodeURI(outputFile)}`)
            if (fileRes.ok) {
              const text = await fileRes.text()
              const format = outputFile.endsWith('.cif') || outputFile.endsWith('.mmcif') ? 'mmcif' : 'pdb'
              await plugin.clear()
              const data = await plugin.builders.data.rawData({ data: text, label: outputFile })
              const trajectory = await plugin.builders.structure.parseTrajectory(data, format as any)
              await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')
              useStructureStore.getState().setFileName(outputFile)
              // The newly loaded structure also becomes the next DVBFixer
              // input (so the user can chain commands without re-picking).
              userPickedInputRef.current = false
              setInputFile(outputFile)
            }
          } catch (loadErr) {
            console.warn('[dvbfixer] auto-load output failed:', loadErr)
          }
        }
      }
      // Refresh local input list + notify other components (Library) to refetch
      setTimeout(refreshStructures, 200)
      useStructureStore.getState().bumpLibraryVersion()
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setRunning(false)
    }
  }, [activeCmd, inputFile, activeValues, refreshStructures, buildFastaContent])

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
                  onChange={(e) => handleInputFileChange(e.target.value)}
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

            {/* Model tab — per-chain FASTA inputs. Renders ONLY for the
             *  `model` command. The user pastes / parses one sequence per
             *  chain; on Run those get concatenated into a FASTA file
             *  passed via --fasta. */}
            {activeCmd.name === 'model' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                    Sequences per chain (--fasta)
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title={inputMatchesLoaded
                    ? 'Populate the boxes below with sequences extracted from the loaded structure (SEQRES + ATOM merged via extractChains).'
                    : 'Load this structure into the primary 3D viewer first to enable parsing.'}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={parseFromPdb}
                        disabled={!inputMatchesLoaded || seqChains.length === 0}
                      >
                        Parse from PDB
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Clear all chain boxes">
                    <span>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setFastaByChain({})}
                        disabled={Object.keys(fastaByChain).length === 0}
                      >
                        Clear
                      </Button>
                    </span>
                  </Tooltip>
                </Box>

                {!inputMatchesLoaded && (
                  <Alert severity="info" sx={{ py: 0.25, fontSize: '0.7rem' }}>
                    Load the selected input into the primary 3D viewer to
                    edit per-chain sequences. (Currently the loaded
                    structure differs from the picked DVBFixer input —
                    the chain list isn't known.) You can still leave
                    everything empty and dvbfixer will fall back to
                    SEQRES from the input PDB.
                  </Alert>
                )}

                {inputMatchesLoaded && seqChains.length === 0 && (
                  <Alert severity="info" sx={{ py: 0.25, fontSize: '0.7rem' }}>
                    No polypeptide chains detected in the loaded
                    structure — nothing to feed into --fasta.
                  </Alert>
                )}

                {seqChains.length > 0 && (
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 1 }}>
                    {seqChains.map(c => {
                      const value = fastaByChain[c.id] ?? ''
                      const len = value.replace(/\s+/g, '').length
                      return (
                        <TextField
                          key={c.id}
                          label={`Chain ${c.id}${len > 0 ? ` · ${len} aa` : ''}`}
                          value={value}
                          onChange={(e) => setChainFasta(c.id, e.target.value)}
                          placeholder="Paste single-letter sequence (or click Parse from PDB)"
                          multiline
                          minRows={3}
                          maxRows={8}
                          fullWidth
                          slotProps={{
                            input: {
                              sx: { fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem' },
                            },
                          }}
                        />
                      )
                    })}
                  </Box>
                )}
              </Box>
            )}

            {/* Flag controls. For the model tab we hide --fasta because
             *  the per-chain UI above synthesises it automatically. */}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}>
              {activeCmd.flags
                .filter(f => !(activeCmd.name === 'model' && f.flag === '--fasta'))
                .map(f => (
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
