import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import FormControlLabel from '@mui/material/FormControlLabel'
import Checkbox from '@mui/material/Checkbox'
import ListItemText from '@mui/material/ListItemText'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Button from '@mui/material/Button'
import LinearProgress from '@mui/material/LinearProgress'
import Alert from '@mui/material/Alert'
import Tooltip from '@mui/material/Tooltip'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import { useStructureStore } from '../stores/structureStore'
import { identifyAntibodyChain, mapEuToAuthSeqId, parseMutation, mutateArgFor, type AntibodyClassification } from '../lib/antibody-numbering'

interface StructureEntry {
  id: string
  file: string
  name: string
}

interface MutationRow {
  id: number
  chain: string                 // 'HC' / 'LC' / legacy free-form
  mutation_name: string
  mutations: string
  igg_subclass: string
}

interface SubclassDetection {
  chainId: string
  cls: AntibodyClassification
}

interface ValidationIssue {
  rowId: number
  kind: 'conflict' | 'out-of-range' | 'no-target-chain'
  /** 'error' blocks the Run button; 'warning' is informational only.
   *  out-of-range is non-blocking because DVBFixer now skips residues
   *  not present in the structure. */
  severity: 'error' | 'warning'
  message: string
}

interface ProgressState {
  step: number
  total: number
  name: string
  outputFile?: string
}

type Phase = 'idle' | 'running' | 'done' | 'error' | 'cached'

const GLYCAN_COMP_IDS = new Set(['NAG', 'BMA', 'MAN', 'FUC', 'GAL', 'SIA', 'GLC', 'XYL'])

export function AntibodyEngineerPanel() {
  /* ── Input picker ────────────────────────────────────────────────── */
  const [structures, setStructures] = useState<StructureEntry[]>([])
  const [inputFile, setInputFile] = useState('')
  const userPickedInputRef = useRef(false)
  const primaryFileName = useStructureStore(s => s.fileName)

  const refreshStructures = useCallback(() => {
    fetch('/structures/index.json')
      .then(r => r.ok ? r.json() : [])
      .then((data: StructureEntry[]) => setStructures(data))
      .catch(() => {})
  }, [])
  useEffect(() => { refreshStructures() }, [refreshStructures])

  useEffect(() => {
    if (!primaryFileName) return
    if (!userPickedInputRef.current || inputFile === '') setInputFile(primaryFileName)
  }, [primaryFileName, inputFile])

  useEffect(() => {
    if (inputFile === '' && structures.length > 0 && !primaryFileName) {
      const pick = structures.find(d => !d.file.startsWith('dvb_')) ?? structures[0]
      setInputFile(pick.file)
    }
  }, [structures, inputFile, primaryFileName])

  const inputOptions = useMemo(
    () => structures.filter(s => /\.(pdb|cif|mmcif)$/i.test(s.file)),
    [structures]
  )

  /* ── Chain detection (against currently-loaded primary structure) ─ */
  // We can only run detection on the live primary plugin's chains, not on
  // arbitrary entries in the dropdown. So we treat "input must be the
  // primary-loaded structure" as a soft requirement and warn otherwise.
  const chains = useStructureStore(s => s.chains)
  const elements = useStructureStore(s => s.elements)
  const meta = useStructureStore(s => s.meta)
  const isPrimaryLoaded = inputFile && inputFile === primaryFileName

  const detections = useMemo<SubclassDetection[]>(() => {
    if (!isPrimaryLoaded) return []
    const out: SubclassDetection[] = []
    for (const c of chains) {
      const cls = identifyAntibodyChain(c.residues)
      if (cls && cls.type !== 'not-antibody') out.push({ chainId: c.id, cls })
    }
    return out
  }, [chains, isPrimaryLoaded])

  // Glycan auto-detection from store's `elements`.
  const hasGlycanAuto = useMemo(() => {
    if (!isPrimaryLoaded) return false
    return elements.some(e =>
      e.entityType === 'branched' ||
      e.compIds.some(c => GLYCAN_COMP_IDS.has(c))
    )
  }, [elements, isPrimaryLoaded])

  // Equivalent-chain map for the request. Combines (a) detected chain
  // types (HC/LC) and (b) the user's manual `meta.equivalentChains`
  // override. Result: { HC: [...], LC: [...] }.
  const equivalentChainsMap = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {}
    // Bucket all detected chains by their classification type.
    for (const d of detections) {
      const key = d.cls.type === 'HC' ? 'HC' : 'LC'
      if (!out[key]) out[key] = []
      if (!out[key].includes(d.chainId)) out[key].push(d.chainId)
    }
    // Honour the user's explicit equivalentChains groups: if a group
    // contains an HC chain, promote every other chain in the group to HC
    // too (and likewise for LC). The Info panel is the source of truth.
    const overrideGroups = meta.equivalentChains
    if (overrideGroups) {
      for (const group of overrideGroups) {
        const hcMatch = group.find(id => out.HC?.includes(id))
        const lcMatch = group.find(id => out.LC?.includes(id))
        if (hcMatch) {
          out.HC = Array.from(new Set([...(out.HC ?? []), ...group]))
        } else if (lcMatch) {
          out.LC = Array.from(new Set([...(out.LC ?? []), ...group]))
        }
      }
    }
    return out
  }, [detections, meta.equivalentChains])

  // Group detections for display: one chip per equivalent-chain bucket.
  const detectionChips = useMemo(() => {
    type Bucket = { type: 'HC' | 'LC'; subclass: string; chains: string[] }
    const buckets = new Map<string, Bucket>()
    for (const d of detections) {
      const sub = d.cls.subclass ?? 'unknown'
      const key = `${d.cls.type}/${sub}`
      if (!buckets.has(key)) buckets.set(key, { type: d.cls.type === 'HC' ? 'HC' : 'LC', subclass: sub, chains: [] })
      buckets.get(key)!.chains.push(d.chainId)
    }
    return Array.from(buckets.values())
  }, [detections])

  // Detected IgG subclasses (for mutation filtering).
  const detectedSubclasses = useMemo(() => {
    const s = new Set<string>()
    for (const d of detections) {
      if (d.cls.type === 'HC' && d.cls.subclass) s.add(d.cls.subclass)
    }
    return s
  }, [detections])

  /* ── Mutation picker ─────────────────────────────────────────────── */
  const [allRows, setAllRows] = useState<MutationRow[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())

  useEffect(() => {
    fetch('/api/mutations')
      .then(r => r.ok ? r.json() : [])
      .then((data: MutationRow[]) => setAllRows(data))
      .catch(() => {})
  }, [])

  /* ── Manual chain picks for rows without a chain field ────────────── */
  // When a Mutations DB row has an empty `chain`, the user picks target
  // chains here. Manual picks BYPASS equivalentChainsMap expansion — the
  // mutation is applied only to the chains in this list. Keyed by row.id.
  const [manualChainsByMutationId, setManualChainsByMutationId] =
    useState<Record<number, string[]>>({})

  const allDetectedChainIds = useMemo(
    () => detections.map(d => d.chainId),
    [detections]
  )

  const isUnsetChain = (row: MutationRow): boolean => {
    const c = (row.chain || '').trim()
    return c === ''
  }

  /** Effective target chains for a row.
   *  Precedence: manual override > equivalentChainsMap[row.chain]. */
  const resolveTargetChains = useCallback((row: MutationRow): string[] => {
    const manual = manualChainsByMutationId[row.id]
    if (manual && manual.length > 0) return manual
    return equivalentChainsMap[row.chain] ?? []
  }, [manualChainsByMutationId, equivalentChainsMap])

  const setManualChainsForRow = useCallback((rowId: number, chains: string[]) => {
    setManualChainsByMutationId(prev => {
      if (chains.length === 0) {
        if (!(rowId in prev)) return prev
        const next = { ...prev }
        delete next[rowId]
        return next
      }
      return { ...prev, [rowId]: chains }
    })
  }, [])

  const filteredRows = useMemo(() => {
    if (detectedSubclasses.size === 0) {
      // No detection yet — show universal rows only.
      return allRows.filter(r => !r.igg_subclass || r.igg_subclass.trim() === '')
    }
    return allRows.filter(r => {
      const tags = (r.igg_subclass || '').split(',').map(s => s.trim()).filter(Boolean)
      if (tags.length === 0) return true                  // universal
      return tags.some(t => detectedSubclasses.has(t))
    })
  }, [allRows, detectedSubclasses])

  const toggleChecked = useCallback((id: number) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /* ── Live validation: collisions + out-of-range positions ────────── */
  const validationIssues = useMemo<ValidationIssue[]>(() => {
    const issues: ValidationIssue[] = []
    // Map (chainId, position) → rowId(s) of selected mutations that touch it.
    const targets = new Map<string, number[]>()
    for (const id of checked) {
      const row = allRows.find(r => r.id === id)
      if (!row) continue
      const targetChains = resolveTargetChains(row)
      if (targetChains.length === 0) {
        const msg = isUnsetChain(row)
          ? 'Row has no chain set — pick one or more chains manually.'
          : `No ${row.chain} chains detected in the loaded structure.`
        issues.push({ rowId: id, kind: 'no-target-chain', severity: 'error', message: msg })
        continue
      }
      const tokens = row.mutations.split(',').map(t => t.trim()).filter(Boolean)
      for (const tok of tokens) {
        const p = parseMutation(tok)
        if (!p) continue
        for (const ch of targetChains) {
          const key = `${ch}:${p.position}`
          if (!targets.has(key)) targets.set(key, [])
          targets.get(key)!.push(id)
        }
        // Out-of-range check uses the FIRST target chain's detection
        // (chains in the same equivalent group share residue ranges).
        const det = detections.find(d => d.chainId === targetChains[0])
        if (det && mapEuToAuthSeqId(chains.find(c => c.id === det.chainId)!.residues, p.position, det.cls) === null) {
          issues.push({ rowId: id, kind: 'out-of-range', severity: 'warning', message: `Position ${p.position} not in chain ${targetChains[0]} (${det.cls.region}) — DVBFixer will skip it.` })
        }
      }
    }
    // Collisions: any (chain, position) hit by more than one row.
    for (const [key, ids] of targets.entries()) {
      const unique = Array.from(new Set(ids))
      if (unique.length > 1) {
        for (const id of unique) {
          issues.push({ rowId: id, kind: 'conflict', severity: 'error', message: `Conflicts with another selection at ${key}.` })
        }
      }
    }
    return issues
  }, [checked, allRows, resolveTargetChains, detections, chains])

  const issuesByRow = useMemo(() => {
    const m = new Map<number, ValidationIssue[]>()
    for (const it of validationIssues) {
      if (!m.has(it.rowId)) m.set(it.rowId, [])
      m.get(it.rowId)!.push(it)
    }
    return m
  }, [validationIssues])

  /* ── Pipeline config ─────────────────────────────────────────────── */
  const [glycanMode, setGlycanMode] = useState<'auto' | 'with' | 'without'>('auto')
  const [scheme, setScheme] = useState<'EU' | 'Kabat'>('EU')
  const effectiveHasGlycan = glycanMode === 'auto' ? hasGlycanAuto : glycanMode === 'with'

  // Build the preview of mutate args that will be sent.
  const previewMutateArgs = useMemo<string[]>(() => {
    const out: string[] = []
    for (const id of checked) {
      const row = allRows.find(r => r.id === id)
      if (!row) continue
      const targetChains = resolveTargetChains(row)
      const tokens = row.mutations.split(',').map(t => t.trim()).filter(Boolean)
      for (const tok of tokens) {
        const p = parseMutation(tok)
        if (!p) continue
        for (const ch of targetChains) {
          try { out.push(mutateArgFor(ch, p)) } catch { /* unknown AA — ignore in preview */ }
        }
      }
    }
    return out
  }, [checked, allRows, resolveTargetChains])

  /* ── Run + SSE handler ───────────────────────────────────────────── */
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<ProgressState>({ step: 0, total: 0, name: '' })
  const [runError, setRunError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Only ERROR-severity issues block the Run button. Warnings (currently:
  // out-of-range residues) are non-blocking — DVBFixer's recent versions
  // silently skip residues missing from the structure rather than failing.
  const hasBlockingIssues = validationIssues.some(i => i.severity === 'error')
  const canRun = checked.size > 0
    && !hasBlockingIssues
    && isPrimaryLoaded
    && phase !== 'running'

  const handleRun = useCallback(async () => {
    if (!canRun) return
    setPhase('running')
    setRunError(null)
    setProgress({ step: 0, total: 0, name: 'starting' })
    abortRef.current = new AbortController()
    try {
      const res = await fetch('/api/antibody-engineer/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          inputFile,
          mutationIds: Array.from(checked).sort((a, b) => a - b),
          equivalentChainsMap,
          // Per-row chain overrides (rows whose `chain` field is empty).
          // Only include checked rows that have non-empty manual picks —
          // keeps the request body tight and prevents stale entries from
          // earlier sessions polluting the run.
          manualChainsByMutationId: Object.fromEntries(
            Object.entries(manualChainsByMutationId)
              .filter(([id, chs]) => checked.has(Number(id)) && chs.length > 0)
          ),
          hasGlycan: effectiveHasGlycan,
          scheme,
        }),
        signal: abortRef.current.signal,
      })
      if (!res.ok || !res.body) {
        const errBody = await res.text()
        setRunError(`HTTP ${res.status}: ${errBody}`)
        setPhase('error')
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let finalOutput: string | null = null
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let ev: any
            try { ev = JSON.parse(line.slice(6)) } catch { continue }
            if (ev.status === 'running') {
              setProgress({ step: ev.step, total: ev.total, name: ev.name })
            } else if (ev.status === 'done' && ev.name === 'cached') {
              setPhase('cached')
              finalOutput = ev.outputFile
            } else if (ev.status === 'done') {
              setProgress({ step: ev.step, total: ev.total, name: ev.name, outputFile: ev.outputFile })
            } else if (ev.status === 'error') {
              setRunError(`${ev.name}: ${ev.stderr}`)
              setPhase('error')
              return
            } else if (ev.status === 'complete') {
              finalOutput = ev.outputFile
            }
          }
        }
      }
      // Stream closed.
      if (finalOutput) {
        await loadOutputIntoPrimary(finalOutput)
        useStructureStore.getState().bumpLibraryVersion()
        if (phase !== 'cached') setPhase('done')
      }
    } catch (e: any) {
      setRunError(e?.message ?? String(e))
      setPhase('error')
    }
  }, [canRun, inputFile, checked, equivalentChainsMap, effectiveHasGlycan, scheme, phase])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
    setPhase('idle')
  }, [])

  /* ── Render ──────────────────────────────────────────────────────── */
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%', overflow: 'auto' }}>
      {/* SECTION 1 — Input + detection */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
          Input structure
        </Typography>
        <FormControl size="small" fullWidth sx={{ mt: 1 }}>
          <InputLabel>Structure</InputLabel>
          <Select
            label="Structure"
            value={inputFile}
            onChange={(e) => { userPickedInputRef.current = true; setInputFile(e.target.value) }}
            sx={{ fontSize: '0.8rem' }}
          >
            {inputOptions.map(s => (
              <MenuItem key={s.id} value={s.file} sx={{ fontSize: '0.75rem' }}>
                {s.name || s.file}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {!isPrimaryLoaded && (
          <Alert severity="info" sx={{ mt: 1, py: 0.25, fontSize: '0.75rem' }}>
            Load this structure into the primary 3D viewer to enable chain detection + validation.
          </Alert>
        )}

        {isPrimaryLoaded && (
          <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
            {detectionChips.length === 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                No antibody chains detected in this structure.
              </Typography>
            )}
            {detectionChips.map(b => (
              <Chip
                key={`${b.type}/${b.subclass}/${b.chains.join(',')}`}
                label={`${b.type} ${b.subclass} — ${b.chains.join(', ')}`}
                size="small"
                color={b.type === 'HC' ? 'primary' : 'secondary'}
                variant="outlined"
                sx={{ fontSize: '0.7rem' }}
              />
            ))}
            <Box sx={{ flex: 1 }} />
            <Chip
              label={hasGlycanAuto ? 'Glycans present' : 'No glycans'}
              size="small"
              color={hasGlycanAuto ? 'success' : 'default'}
              sx={{ fontSize: '0.65rem', height: 20 }}
            />
          </Box>
        )}
      </Paper>

      {/* SECTION 2 — Mutation picker */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
            Mutations
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.65rem' }}>
            {detectedSubclasses.size > 0
              ? `filtered for ${Array.from(detectedSubclasses).join(', ')} + universal`
              : 'universal only — load a structure to filter'}
          </Typography>
        </Box>
        {filteredRows.length === 0 ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            No matching mutations in the database.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {filteredRows.map(row => {
              const rowIssues = issuesByRow.get(row.id) ?? []
              const isChecked = checked.has(row.id)
              const unsetChain = isUnsetChain(row)
              const manualPicks = manualChainsByMutationId[row.id] ?? []
              return (
                <Box key={row.id} sx={{ display: 'flex', alignItems: 'center', py: 0.25, gap: 0.5 }}>
                  <Tooltip placement="right" title={
                    <Box sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                      {row.mutations} ({unsetChain ? 'chain unset — pick manually' : row.chain})
                      {row.igg_subclass && ` · ${row.igg_subclass}`}
                    </Box>
                  }>
                    <FormControlLabel
                      sx={{ flex: 1, m: 0 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={isChecked}
                          onChange={() => toggleChecked(row.id)}
                        />
                      }
                      label={
                        <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>
                          {row.mutation_name}
                        </Typography>
                      }
                    />
                  </Tooltip>

                  {/* Manual chain picker for empty-chain rows. Bypasses
                   *  equivalentChainsMap expansion — the mutation is applied
                   *  ONLY to the chains the user selects here. */}
                  {unsetChain && (
                    <FormControl size="small" sx={{ minWidth: 110, maxWidth: 180 }}>
                      <Select
                        multiple
                        displayEmpty
                        value={manualPicks}
                        onChange={(e) => {
                          const v = e.target.value
                          const next = typeof v === 'string'
                            ? v.split(',').filter(Boolean)
                            : (v as string[])
                          setManualChainsForRow(row.id, next)
                        }}
                        renderValue={(sel) => {
                          const arr = sel as string[]
                          if (arr.length === 0) return <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic', fontSize: '0.7rem' }}>pick chain…</Typography>
                          return <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>{arr.join(', ')}</Typography>
                        }}
                        sx={{ height: 26, fontSize: '0.7rem', '& .MuiSelect-select': { py: 0.25, pl: 0.75 } }}
                      >
                        {allDetectedChainIds.length === 0 && (
                          <MenuItem disabled value="">
                            <Typography variant="caption" sx={{ fontStyle: 'italic' }}>No antibody chains detected</Typography>
                          </MenuItem>
                        )}
                        {allDetectedChainIds.map(id => (
                          <MenuItem key={id} value={id} dense>
                            <Checkbox checked={manualPicks.includes(id)} size="small" sx={{ p: 0.5 }} />
                            <ListItemText primary={id} slotProps={{ primary: { sx: { fontSize: '0.75rem' } } }} />
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}

                  {rowIssues.map((iss, k) => (
                    <Tooltip key={k} title={iss.message}>
                      <Chip
                        label={iss.kind}
                        size="small"
                        color={iss.severity === 'error' ? 'error' : 'warning'}
                        variant="outlined"
                        sx={{ fontSize: '0.6rem', height: 18 }}
                      />
                    </Tooltip>
                  ))}
                </Box>
              )
            })}
          </Box>
        )}

        {/* Equivalent-chain expansion preview */}
        {checked.size > 0 && previewMutateArgs.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
              Will be applied to:
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
              {/* Show the equiv-chain buckets only for rows that ACTUALLY
               *  use them (i.e. at least one checked row has a non-empty
               *  chain that maps into this bucket and is NOT overridden by
               *  manualChainsByMutationId). */}
              {Object.entries(equivalentChainsMap)
                .filter(([type]) => Array.from(checked).some(id => {
                  const r = allRows.find(x => x.id === id)
                  if (!r) return false
                  if (isUnsetChain(r)) return false
                  if ((manualChainsByMutationId[id]?.length ?? 0) > 0) return false
                  return r.chain === type
                }))
                .map(([type, ids]) => (
                  <Chip
                    key={type}
                    label={`${type}: ${ids.join(', ')}`}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: '0.65rem', height: 20 }}
                  />
                ))}
              {/* Manual rows: one chip per row showing the user-picked chains. */}
              {Array.from(checked).map(id => {
                const r = allRows.find(x => x.id === id)
                if (!r) return null
                const manual = manualChainsByMutationId[id]
                if (!manual || manual.length === 0) return null
                return (
                  <Chip
                    key={`manual-${id}`}
                    label={`${r.mutation_name}: ${manual.join(', ')}`}
                    size="small"
                    color="warning"
                    variant="outlined"
                    sx={{ fontSize: '0.65rem', height: 20 }}
                  />
                )
              })}
            </Box>
            <Tooltip title={
              <Box sx={{ fontFamily: 'monospace', fontSize: '0.65rem', whiteSpace: 'pre-wrap' }}>
                {previewMutateArgs.map(a => `--mutate ${a}`).join('\n')}
              </Box>
            }>
              <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.6rem', display: 'block', mt: 0.5, cursor: 'help' }}>
                {previewMutateArgs.length} mutation arg{previewMutateArgs.length === 1 ? '' : 's'} — hover for full list
              </Typography>
            </Tooltip>
          </Box>
        )}
      </Paper>

      {/* SECTION 3 — Pipeline + Run */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
          Pipeline
        </Typography>

        {/* Numbering scheme — top of the pipeline block, left-aligned. */}
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
            Numbering scheme
          </Typography>
          <ToggleButtonGroup
            size="small"
            value={scheme}
            exclusive
            onChange={(_e, v) => v && setScheme(v)}
            sx={{ mt: 0.5 }}
          >
            <ToggleButton value="EU" sx={{ fontSize: '0.7rem', py: 0.25 }}>EU</ToggleButton>
            <ToggleButton value="Kabat" sx={{ fontSize: '0.7rem', py: 0.25 }}>Kabat</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
            Glycan handling
          </Typography>
          <RadioGroup
            value={glycanMode}
            onChange={(e) => setGlycanMode(e.target.value as any)}
            sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.75rem' } }}
          >
            <FormControlLabel value="auto" control={<Radio size="small" />} label={`Auto (${hasGlycanAuto ? 'with glycans' : 'no glycans'})`} />
            <FormControlLabel value="with" control={<Radio size="small" />} label="Force: with glycans (7 steps)" />
            <FormControlLabel value="without" control={<Radio size="small" />} label="Force: no glycans (5 steps)" />
          </RadioGroup>
        </Box>

        <Box sx={{ mt: 1, p: 0.75, bgcolor: 'action.hover', borderRadius: 1 }}>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', whiteSpace: 'pre-wrap' }}>
            {(effectiveHasGlycan
              ? ['renumber --scheme ' + scheme, 'prepare --mutate ...', 'convert', 'minimize --no-solvent', 'protonate', 'minimize --no-solvent', 'convert --to-charmm']
              : ['renumber --scheme ' + scheme, 'prepare --mutate ...', 'minimize --no-solvent', 'protonate', 'minimize --no-solvent']
            ).map((s, i) => `${i + 1}. ${s}`).join('\n')}
          </Typography>
        </Box>

        {/* Run / progress / errors */}
        <Box sx={{ mt: 1.5 }}>
          {phase === 'running' && (
            <>
              <LinearProgress
                variant="determinate"
                value={progress.total > 0 ? (progress.step / progress.total) * 100 : 0}
                sx={{ mb: 0.5 }}
              />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Step {progress.step}/{progress.total}: {progress.name}
                </Typography>
                <Button size="small" onClick={handleCancel} sx={{ fontSize: '0.65rem' }}>Cancel</Button>
              </Box>
            </>
          )}
          {phase === 'idle' && (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              onClick={handleRun}
              disabled={!canRun}
              fullWidth
            >
              Run pipeline
            </Button>
          )}
          {phase === 'done' && (
            <Alert severity="success" sx={{ py: 0.25, fontSize: '0.75rem' }}>
              Pipeline complete. Output loaded into the primary 3D viewer.
              <Button size="small" sx={{ ml: 1, fontSize: '0.65rem' }} onClick={() => setPhase('idle')}>Run another</Button>
            </Alert>
          )}
          {phase === 'cached' && (
            <Alert severity="info" sx={{ py: 0.25, fontSize: '0.75rem' }}>
              Already computed for this input + mutation combination — loaded existing structure.
              <Button size="small" sx={{ ml: 1, fontSize: '0.65rem' }} onClick={() => setPhase('idle')}>OK</Button>
            </Alert>
          )}
          {phase === 'error' && (
            <Alert severity="error" sx={{ py: 0.5, fontSize: '0.75rem' }}>
              <Box sx={{ fontFamily: 'monospace', fontSize: '0.7rem', whiteSpace: 'pre-wrap' }}>
                {runError}
              </Box>
              <Button size="small" sx={{ mt: 0.5, fontSize: '0.65rem' }} onClick={() => { setPhase('idle'); setRunError(null) }}>
                Reset
              </Button>
            </Alert>
          )}
        </Box>
      </Paper>
    </Box>
  )
}

/**
 * Auto-load a PDB output into the PRIMARY 3D viewer (clone of the
 * DVBFixerPanel.handleRun post-success snippet). Updates fileName so other
 * panels react. Failures are warned but not fatal — the SSE stream has
 * already reported success.
 */
async function loadOutputIntoPrimary(outputFile: string): Promise<void> {
  const plugin = useStructureStore.getState().plugin
  if (!plugin) return
  try {
    const fileRes = await fetch(`/structures/${encodeURI(outputFile)}`)
    if (!fileRes.ok) return
    const text = await fileRes.text()
    const format = outputFile.endsWith('.cif') || outputFile.endsWith('.mmcif') ? 'mmcif' : 'pdb'
    await plugin.clear()
    const data = await plugin.builders.data.rawData({ data: text, label: outputFile })
    const trajectory = await plugin.builders.structure.parseTrajectory(data, format as any)
    await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')
    useStructureStore.getState().setFileName(outputFile)
  } catch (err) {
    console.warn('[antibody-engineer] auto-load output failed:', err)
  }
}
