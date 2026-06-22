/**
 * Multi-step DVBFixer orchestrator for the Antibody Engineer tool.
 *
 * Given a structure + a set of selected Mutations DB rows + an
 * equivalent-chain map, runs the appropriate DVBFixer pipeline (with or
 * without glycan steps) and emits step-by-step SSE events via a callback.
 *
 * The orchestrator is transport-agnostic — `onEvent` is invoked once per
 * step start/end and the api-plugin glues it to `text/event-stream`.
 */

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { runDvbfixer } from './api-plugin'

export type SSEEvent =
  | { step: 0;       total: number; name: 'cached';  status: 'done'; outputFile: string }
  | { step: number;  total: number; name: string;    status: 'running' }
  | { step: number;  total: number; name: string;    status: 'done'; outputFile: string }
  | { step: number;  total: number; name: string;    status: 'error'; stderr: string }
  | { step: number;  total: number;                  status: 'complete'; outputFile: string; entry: IndexEntry }

interface IndexEntry {
  id: string
  file: string
  name: string
  parent: string
  command: string
  mutationIds: number[]
  mutationsResolved: string
  _engineerChecksum: string
  hasGlycan: boolean
  scheme: 'EU' | 'Kabat'
  organism: string
  chains: number
  residues: number
  description: string
  /** Antibody metadata inherited from the input entry, if present. */
  allotype?: string
  iggSubtype?: string
}

export interface MutationRow {
  id: number
  chain: string                 // 'HC' | 'LC' (per the user's new mutations DB convention)
  mutations: string             // comma-separated tokens, e.g. 'M252Y,S254T,T256E' or 'G446del,K447del'
  mutation_name: string
}

export interface PipelineInput {
  structuresDir: string
  inputFile: string             // relative to structuresDir, e.g. 'FcRn.pdb'
  mutationRows: MutationRow[]
  mutationIds: number[]
  /** chain-type ('HC' / 'LC') → real chain ids (e.g. ['H','I']). */
  equivalentChainsMap: Record<string, string[]>
  /** Optional per-mutation-id override of target chains. When set for a
   *  mutation id, the equivalent-chains expansion is BYPASSED for that
   *  row — only the listed chains receive the mutation. Used by the AE
   *  panel when a Mutations DB row has an empty `chain` field. */
  manualChainsByMutationId?: Record<number, string[]>
  hasGlycan: boolean
  scheme: 'EU' | 'Kabat'
  checksum: string
  onEvent: (e: SSEEvent) => void
  isAborted: () => boolean
}

/* ────────────────────────────────────────────────────────────────────────
 * Mutation parsing + expansion
 * ──────────────────────────────────────────────────────────────────────── */

const AA1_TO_AA3: Record<string, string> = {
  A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS',
  E: 'GLU', Q: 'GLN', G: 'GLY', H: 'HIS', I: 'ILE',
  L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO',
  S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL',
}

const MUT_TOKEN_RE = /^([A-Z])(\d+)([A-Z]|del)$/i

interface ParsedMutation {
  wt: string
  resnum: number
  mut: string
  del: boolean
}

export function parseMutationToken(tok: string): ParsedMutation | null {
  const m = tok.trim().match(MUT_TOKEN_RE)
  if (!m) return null
  const tail = m[3].toLowerCase()
  if (tail === 'del') return { wt: m[1].toUpperCase(), resnum: parseInt(m[2], 10), mut: 'del', del: true }
  return { wt: m[1].toUpperCase(), resnum: parseInt(m[2], 10), mut: m[3].toUpperCase(), del: false }
}

/**
 * Expand a list of mutation rows into per-(chain, mutation) `--mutate`
 * argument strings, fanning out across every equivalent chain.
 *
 * Example: row { chain:'HC', mutations:'M252Y,S254T' } with
 * equivMap.HC = ['H','I'] → [
 *   'H:252:TYR', 'I:252:TYR', 'H:254:THR', 'I:254:THR'
 * ]
 */
export function expandMutations(
  rows: MutationRow[],
  equivMap: Record<string, string[]>,
  manualMap: Record<number, string[]> = {},
): string[] {
  const out: string[] = []
  for (const row of rows) {
    const tokens = row.mutations.split(',').map(t => t.trim()).filter(Boolean)
    // Resolve target chains. Precedence: manual override > equivalent-chains
    // expansion > raw row.chain. The manual override BYPASSES equivalence
    // expansion — used by the AE panel when a Mutations DB row has an
    // empty `chain` field and the user picks chains themselves.
    const manual = manualMap[row.id]
    const targetChains = (manual && manual.length > 0)
      ? manual
      : (equivMap[row.chain] ?? (row.chain ? [row.chain] : []))
    if (targetChains.length === 0) {
      throw new Error(`No chains resolved for mutation row #${row.id} (chain='${row.chain}'). Provide equivalentChainsMap.${row.chain} or a manualChainsByMutationId entry.`)
    }
    for (const tok of tokens) {
      const p = parseMutationToken(tok)
      if (!p) {
        throw new Error(`Mutation row #${row.id} (${row.mutation_name}): unparseable token '${tok}'.`)
      }
      for (const ch of targetChains) {
        if (p.del) {
          out.push(`${ch}:${p.resnum}:del`)
        } else {
          const aa3 = AA1_TO_AA3[p.mut]
          if (!aa3) {
            throw new Error(`Mutation row #${row.id}: unknown target amino acid '${p.mut}' in token '${tok}'.`)
          }
          out.push(`${ch}:${p.resnum}:${aa3}`)
        }
      }
    }
  }
  return out
}

/** Throw if any (chain, resnum) appears in more than one `--mutate` arg.
 *  Frontend already validates; this is a defensive duplicate check. */
export function validateNoDuplicateTargets(args: string[]): void {
  const seen = new Map<string, string>()
  for (const a of args) {
    const parts = a.split(':')
    const key = `${parts[0]}:${parts[1]}`
    if (seen.has(key)) {
      throw new Error(`Conflict: two selected mutations both target ${key} ('${seen.get(key)}' and '${a}').`)
    }
    seen.set(key, a)
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Pipeline shape
 * ──────────────────────────────────────────────────────────────────────── */

interface PipelineStep {
  command: 'renumber' | 'prepare' | 'convert' | 'minimize' | 'protonate'
  extraArgs: string[]
}

export function pipelineSteps(
  scheme: 'EU' | 'Kabat',
  hasGlycan: boolean,
  mutateArgs: string[],
): PipelineStep[] {
  const mutateFlags: string[] = mutateArgs.flatMap(a => ['--mutate', a])
  // DVBFixer's --scheme expects lowercase tokens. Frontend uses
  // capitalised labels (EU / Kabat); translate here.
  const schemeArg = scheme.toLowerCase()
  if (hasGlycan) {
    // 7-step glycan pipeline (per the user's spec):
    return [
      { command: 'renumber', extraArgs: ['--scheme', schemeArg] },
      { command: 'prepare',  extraArgs: mutateFlags },
      { command: 'convert',  extraArgs: [] },                       // no --to-charmm (GLYCAM form)
      { command: 'minimize', extraArgs: ['--no-solvent'] },
      { command: 'protonate', extraArgs: [] },
      { command: 'minimize', extraArgs: ['--no-solvent'] },
      { command: 'convert',  extraArgs: ['--to-charmm'] },
    ]
  }
  // 5-step no-glycan pipeline (per the user's confirmation):
  return [
    { command: 'renumber', extraArgs: ['--scheme', schemeArg] },
    { command: 'prepare',  extraArgs: mutateFlags },
    { command: 'minimize', extraArgs: ['--no-solvent'] },
    { command: 'protonate', extraArgs: [] },
    { command: 'minimize', extraArgs: ['--no-solvent'] },
  ]
}

/* ────────────────────────────────────────────────────────────────────────
 * Dedup checksum
 * ──────────────────────────────────────────────────────────────────────── */

export function engineerChecksum(p: {
  inputFile: string
  mutationIds: number[]
  hasGlycan: boolean
  scheme: 'EU' | 'Kabat'
}): string {
  const canonical = JSON.stringify({
    inputFile: p.inputFile,
    mutationIds: [...p.mutationIds].sort((a, b) => a - b),
    hasGlycan: p.hasGlycan,
    scheme: p.scheme,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/** Look up an existing engineered output for the same input+mutation combo. */
export function findCachedEntry(structuresDir: string, inputFile: string, checksum: string): IndexEntry | null {
  const indexPath = path.join(structuresDir, 'index.json')
  if (!fs.existsSync(indexPath)) return null
  try {
    const entries: any[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    const hit = entries.find(e => e?.parent === inputFile && e?._engineerChecksum === checksum && fs.existsSync(path.join(structuresDir, e.file)))
    return hit ?? null
  } catch {
    return null
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Orchestrator
 * ──────────────────────────────────────────────────────────────────────── */

function tsTag(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function safeReadIndex(indexPath: string): any[] {
  if (!fs.existsSync(indexPath)) return []
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch { return [] }
}

function writeIndex(indexPath: string, entries: any[]): void {
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
}

/**
 * Register a plain intermediate entry for an in-pipeline output so the
 * library tree shows the parent → child relationship the same way the
 * existing single-command /api/dvbfixer route does.
 */
function registerIntermediateEntry(
  indexPath: string,
  inputFile: string,
  outputFile: string,
  command: string,
): void {
  const entries = safeReadIndex(indexPath)
  const inputBase = path.basename(inputFile, path.extname(inputFile))
  const outBase = path.basename(outputFile)
  // Inherit allotype / iggSubtype from the immediate input entry —
  // identity tags propagate down the lineage chain so the user only
  // sees them filled at the top once.
  const inputEntry = entries.find((e: any) => e && e.file === inputFile && e.kind !== 'folder')
  const inherited: Record<string, string> = {}
  if (inputEntry?.allotype && typeof inputEntry.allotype === 'string' && inputEntry.allotype.trim() !== '') {
    inherited.allotype = inputEntry.allotype
  }
  if (inputEntry?.iggSubtype && typeof inputEntry.iggSubtype === 'string' && inputEntry.iggSubtype.trim() !== '') {
    inherited.iggSubtype = inputEntry.iggSubtype
  }
  entries.push({
    id: outputFile,
    file: outputFile,
    name: `${inputBase} → ${command}`,
    parent: inputFile,
    command,
    organism: '',
    chains: 0,
    residues: 0,
    description: `DVBFixer ${command} · ${new Date().toLocaleString()} · ${outBase}`,
    ...inherited,
  })
  writeIndex(indexPath, entries)
}

function moveDirToFailed(structuresDir: string, srcDir: string): string | null {
  try {
    const failedRoot = path.join(structuresDir, '_engineer_failed')
    fs.mkdirSync(failedRoot, { recursive: true })
    const dest = path.join(failedRoot, path.basename(srcDir))
    fs.renameSync(srcDir, dest)
    return path.relative(structuresDir, dest).replace(/\\/g, '/')
  } catch {
    return null
  }
}

export async function runEngineerPipeline(p: PipelineInput): Promise<void> {
  // Build + validate the --mutate args ONCE; if anything's malformed,
  // surface it as a synthetic step-0 error BEFORE running the CLI.
  let mutateArgs: string[]
  try {
    mutateArgs = expandMutations(p.mutationRows, p.equivalentChainsMap, p.manualChainsByMutationId)
    validateNoDuplicateTargets(mutateArgs)
  } catch (err: any) {
    p.onEvent({ step: 0, total: 0, name: 'validate', status: 'error', stderr: err.message ?? String(err) })
    return
  }
  if (mutateArgs.length === 0) {
    p.onEvent({ step: 0, total: 0, name: 'validate', status: 'error', stderr: 'No mutations resolved — nothing to do.' })
    return
  }

  const steps = pipelineSteps(p.scheme, p.hasGlycan, mutateArgs)
  const total = steps.length
  const indexPath = path.join(p.structuresDir, 'index.json')

  // Track every output directory we create so we can roll them all into
  // `_engineer_failed/` if any step blows up.
  const createdDirs: string[] = []

  let currentInputAbs = path.resolve(p.structuresDir, p.inputFile)
  let currentInputRel = p.inputFile

  // Sanity: input must exist and live under structuresDir.
  if (!currentInputAbs.startsWith(path.resolve(p.structuresDir))) {
    p.onEvent({ step: 0, total, name: 'validate', status: 'error', stderr: 'Input path escapes structures/.' })
    return
  }
  if (!fs.existsSync(currentInputAbs)) {
    p.onEvent({ step: 0, total, name: 'validate', status: 'error', stderr: `Input not found: ${p.inputFile}` })
    return
  }

  const inputBase = path.basename(p.inputFile, path.extname(p.inputFile))

  for (let i = 0; i < steps.length; i++) {
    if (p.isAborted()) {
      p.onEvent({ step: i + 1, total, name: steps[i].command, status: 'error', stderr: 'Aborted by client.' })
      // Best-effort cleanup of partial outputs.
      for (const d of createdDirs) moveDirToFailed(p.structuresDir, d)
      return
    }

    const step = steps[i]
    // Suffix with step index so the same command appearing twice in the
    // pipeline (minimize, convert) doesn't collide on output dir.
    const subdir = `dvb_${step.command}_${tsTag()}_s${i + 1}`
    const outDir = path.join(p.structuresDir, subdir)
    fs.mkdirSync(outDir, { recursive: true })
    createdDirs.push(outDir)

    const currentBase = path.basename(currentInputRel, path.extname(currentInputRel))
    const outFileAbs = path.join(outDir, `${currentBase}_${step.command}.pdb`)
    const outFileRel = path.relative(p.structuresDir, outFileAbs).replace(/\\/g, '/')

    p.onEvent({ step: i + 1, total, name: step.command, status: 'running' })

    const res = await runDvbfixer(step.command, currentInputAbs, outFileAbs, step.extraArgs)
    if (res.code !== 0) {
      // Move every dir we created (including this one) to _engineer_failed/
      // so a partial pipeline doesn't pollute the library.
      for (const d of createdDirs) moveDirToFailed(p.structuresDir, d)
      p.onEvent({ step: i + 1, total, name: step.command, status: 'error', stderr: res.stderr || res.stdout || `exit ${res.code}` })
      return
    }
    if (!fs.existsSync(outFileAbs)) {
      for (const d of createdDirs) moveDirToFailed(p.structuresDir, d)
      p.onEvent({ step: i + 1, total, name: step.command, status: 'error', stderr: `Step exited 0 but did not produce ${outFileRel}.\nstdout: ${res.stdout}\nstderr: ${res.stderr}` })
      return
    }

    // Register intermediate entries (parent → previous step's output) so the
    // library shows the chain. Skip the LAST step — that one gets the rich
    // engineer entry below.
    if (i < steps.length - 1) {
      registerIntermediateEntry(indexPath, currentInputRel, outFileRel, step.command)
    }

    p.onEvent({ step: i + 1, total, name: step.command, status: 'done', outputFile: outFileRel })

    currentInputAbs = outFileAbs
    currentInputRel = outFileRel
  }

  // Final step done — write the rich engineer entry.
  const finalRel = currentInputRel
  const nameTags = p.mutationRows.map(r => r.mutation_name).join(' + ')

  // Inherit antibody metadata from the input entry. We mostly carry
  // forward whichever fields are user-editable identity tags — allotype
  // and iggSubtype don't change as a result of running prepare /
  // minimize / convert / glycam pipelines, so inheriting them by
  // default saves the user from re-entering them in the Info panel on
  // every engineered variant. If the input has neither set, the output
  // simply lacks them (the Info panel will show the empty fields and
  // the user can fill in if they want).
  const allEntries = safeReadIndex(indexPath)
  const inputEntry = allEntries.find((e: any) => e && e.file === p.inputFile && e.kind !== 'folder')
  const inherited: Partial<IndexEntry> = {}
  if (inputEntry?.allotype && typeof inputEntry.allotype === 'string' && inputEntry.allotype.trim() !== '') {
    inherited.allotype = inputEntry.allotype
  }
  if (inputEntry?.iggSubtype && typeof inputEntry.iggSubtype === 'string' && inputEntry.iggSubtype.trim() !== '') {
    inherited.iggSubtype = inputEntry.iggSubtype
  }

  const entry: IndexEntry = {
    id: finalRel,
    file: finalRel,
    name: `${inputBase} — ${nameTags}`,
    parent: p.inputFile,                                  // ORIGINAL input, not previous step
    command: 'antibody-engineer',
    mutationIds: [...p.mutationIds].sort((a, b) => a - b),
    mutationsResolved: mutateArgs.join(' '),
    _engineerChecksum: p.checksum,
    hasGlycan: p.hasGlycan,
    scheme: p.scheme,
    organism: '',
    chains: 0,
    residues: 0,
    description: `Antibody engineer · ${p.hasGlycan ? 'glycan' : 'no-glycan'} · ${p.scheme} · ${new Date().toLocaleString()}`,
    ...inherited,
  }
  allEntries.push(entry)
  writeIndex(indexPath, allEntries)

  p.onEvent({ step: total, total, status: 'complete', outputFile: finalRel, entry })
}
