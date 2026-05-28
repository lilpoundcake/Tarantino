/**
 * Vite dev-server plugin exposing two HTTP APIs:
 *
 *   POST   /api/dvbfixer/:command   — run a DVBFixer subcommand on an input
 *                                     file and produce output in
 *                                     structures/dvb_<command>_<ts>/.
 *   GET    /api/mutations           — list mutations
 *   POST   /api/mutations           — create
 *   PUT    /api/mutations/:id       — update
 *   DELETE /api/mutations/:id       — delete
 *
 * Env vars:
 *   DVBFIXER_CMD   default 'dvbfixer'  — how to invoke the CLI
 *   DATABASE_URL   postgres connection string
 */

import type { Plugin, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { COMMANDS } from './dvbfixer-spec'

// Defer the pg import so the plugin loads even if pg is missing or DB is unset.
type PgClient = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}
let pgPool: PgClient | null = null

// Project-root path used to locate the git-tracked mutations backup
// (`mutations.json`). Set once by the Vite plugin's `configureServer`
// hook; falls back to `process.cwd()` if a request races startup.
let projectRoot: string | null = null

function mutationsBackupPath(): string {
  return path.join(projectRoot ?? process.cwd(), 'mutations.json')
}

/**
 * Snapshot the full mutations table to `mutations.json` at repo root.
 * Called after every successful CRUD write so the git-tracked backup
 * stays in sync with the live DB. Failures are warned but not fatal —
 * a dump miss is better than crashing the API.
 */
async function dumpMutationsToBackup(pg: PgClient) {
  try {
    const { rows } = await pg.query(
      'SELECT id, chain, mutation_name, mutations, igg_subclass FROM mutations ORDER BY id ASC'
    )
    fs.writeFileSync(mutationsBackupPath(), JSON.stringify(rows, null, 2) + '\n')
  } catch (err) {
    console.warn('[api] failed to dump mutations backup:', err)
  }
}

/**
 * If the mutations table is empty and a backup file exists at repo root,
 * seed the table from it. Runs once on first connection — subsequent
 * runs find the table non-empty and skip. This means a fresh clone with
 * the committed `mutations.json` gets the team's mutation library
 * automatically.
 */
async function seedMutationsFromBackup(pg: PgClient) {
  const filePath = mutationsBackupPath()
  if (!fs.existsSync(filePath)) return
  try {
    const { rows: countRows } = await pg.query('SELECT COUNT(*)::int AS n FROM mutations')
    if ((countRows[0]?.n ?? 0) > 0) return
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) return
    const data = JSON.parse(raw) as Array<{
      id?: number
      chain?: string
      mutation_name?: string
      mutations?: string
      igg_subclass?: string
    }>
    if (!Array.isArray(data) || data.length === 0) return
    for (const row of data) {
      if (row.id !== undefined) {
        await pg.query(
          'INSERT INTO mutations (id, chain, mutation_name, mutations, igg_subclass) VALUES ($1, $2, $3, $4, $5)',
          [row.id, row.chain ?? '', row.mutation_name ?? '', row.mutations ?? '', row.igg_subclass ?? '']
        )
      } else {
        await pg.query(
          'INSERT INTO mutations (chain, mutation_name, mutations, igg_subclass) VALUES ($1, $2, $3, $4)',
          [row.chain ?? '', row.mutation_name ?? '', row.mutations ?? '', row.igg_subclass ?? '']
        )
      }
    }
    // Bump the auto-id sequence above any explicitly-inserted ids so new
    // rows don't collide.
    await pg.query("SELECT setval('mutations_id_seq', COALESCE((SELECT MAX(id) FROM mutations), 1))")
    console.log(`[api] seeded ${data.length} mutations from mutations.json`)
  } catch (err) {
    console.warn('[api] failed to seed mutations from backup:', err)
  }
}

export async function getPg(): Promise<PgClient | null> {
  if (pgPool) return pgPool
  const url = process.env.DATABASE_URL
  if (!url) return null
  try {
    const pg = await import('pg')
    const { Pool } = pg.default ?? pg
    const pool = new Pool({ connectionString: url })
    // Auto-create schema. `igg_subclass` is the per-row antibody
    // subclass tag (e.g. IgG1 / IgG2 / IgG4) — empty string by default.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mutations (
        id SERIAL PRIMARY KEY,
        chain TEXT NOT NULL,
        mutation_name TEXT NOT NULL,
        mutations TEXT NOT NULL,
        igg_subclass TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Migrate older deployments whose table predates igg_subclass.
    await pool.query(
      `ALTER TABLE mutations ADD COLUMN IF NOT EXISTS igg_subclass TEXT NOT NULL DEFAULT ''`
    )
    pgPool = pool as unknown as PgClient
    // Seed from the git-tracked backup file if the table is empty.
    await seedMutationsFromBackup(pgPool)
    return pgPool
  } catch (err) {
    console.error('[api] postgres init failed:', err)
    return null
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * SSE helpers (used by /api/antibody-engineer/run and any future
 * long-running orchestrator that wants real-time progress).
 * ──────────────────────────────────────────────────────────────────────── */

/** Set SSE headers and flush so the browser begins reading. Call once
 *  before the first sseSend(). */
export function writeSSEHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeat upstream proxy buffering (nginx, etc.) so events arrive promptly.
    'X-Accel-Buffering': 'no',
  })
  // res.flushHeaders exists on Node's ServerResponse — try-cast for compat.
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()
}

/** Emit one SSE message. Single-channel: client switches on payload.status. */
export function sseSend(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Read the entire request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: any) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Build CLI argument list from form values + the command's flag spec. */
function buildArgs(commandName: string, values: Record<string, any>): string[] {
  const def = COMMANDS.find(c => c.name === commandName)
  if (!def) throw new Error(`Unknown DVBFixer command: ${commandName}`)
  const args: string[] = []
  for (const flag of def.flags) {
    const v = values[flag.flag]
    if (v === undefined || v === '' || v === null) continue
    if (flag.type === 'bool') {
      if (v === true) args.push(flag.flag)
    } else if (flag.type === 'number') {
      args.push(flag.flag, String(v))
    } else if (flag.repeatable && typeof v === 'string') {
      // Comma-separated input → multiple --flag <value> pairs
      const items = v.split(',').map(s => s.trim()).filter(Boolean)
      for (const item of items) {
        args.push(flag.flag, item)
      }
    } else if (flag.multi && typeof v === 'string') {
      // Whitespace-separated input → single --flag followed by all values
      // (Python argparse nargs='+'), e.g. `--ff a.xml b.xml`
      const items = v.split(/\s+/).map(s => s.trim()).filter(Boolean)
      if (items.length > 0) {
        args.push(flag.flag, ...items)
      }
    } else {
      args.push(flag.flag, String(v))
    }
  }
  return args
}

/**
 * Spawn dvbfixer and capture stdout + stderr.
 *
 * Exported so multi-step orchestrators (e.g. `server/antibody-pipeline.ts`)
 * can chain DVBFixer commands without duplicating the spawn / env-var logic.
 */
export function runDvbfixer(
  command: string,
  inputFile: string,
  outputFile: string,
  extraArgs: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = process.env.DVBFIXER_CMD || 'dvbfixer'
  // Allow DVBFIXER_CMD to be a multi-word command like "micromamba run -n tarantino dvbfixer"
  const parts = cmd.split(/\s+/).filter(Boolean)
  const exe = parts[0]
  const baseArgs = parts.slice(1)
  const args = [...baseArgs, command, inputFile, '-o', outputFile, ...extraArgs]

  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: process.cwd() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + '\n' + String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export function apiPlugin(): Plugin {
  return {
    name: 'tarantino-api',
    configureServer(server: ViteDevServer) {
      const structuresDir = path.resolve(server.config.root, 'structures')
      // Remember the repo root so the mutations backup writer / seeder
      // can find `mutations.json` regardless of which working directory
      // the dev server was launched from.
      projectRoot = server.config.root

      // ── DVBFixer runner ────────────────────────────────────────────────
      server.middlewares.use('/api/dvbfixer', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean)
          // For requests like POST /api/dvbfixer/split → urlParts = ['split']
          const command = urlParts[0]
          if (!command) return sendJson(res, 400, { error: 'missing command' })

          const def = COMMANDS.find(c => c.name === command)
          if (!def) return sendJson(res, 404, { error: `unknown command: ${command}` })

          const bodyText = await readBody(req)
          const body = JSON.parse(bodyText || '{}') as { inputFile?: string; values?: Record<string, any> }
          if (!body.inputFile) return sendJson(res, 400, { error: 'inputFile required' })

          const inputAbsPath = path.join(structuresDir, body.inputFile)
          const inputResolved = path.resolve(inputAbsPath)
          if (!inputResolved.startsWith(structuresDir) || !fs.existsSync(inputResolved)) {
            return sendJson(res, 400, { error: `input not found: ${body.inputFile}` })
          }

          // Output subfolder: structures/dvb_<command>_<YYYYMMDD-HHMMSS>/
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const subdirName = `dvb_${command}_${ts}`
          const outDir = path.join(structuresDir, subdirName)
          fs.mkdirSync(outDir, { recursive: true })
          const inputBase = path.basename(inputResolved, path.extname(inputResolved))
          const outFile = path.join(outDir, `${inputBase}_${command}.pdb`)

          const extraArgs = buildArgs(command, body.values || {})
          const result = await runDvbfixer(command, inputResolved, outFile, extraArgs)

          // Failed runs: move the output folder out of the library so it
          // doesn't pollute it. We move to structures/_dvb_failed/<subdir>
          // (the scanner skips dot-prefixed and underscore-prefixed dirs).
          let movedTo: string | null = null
          if (result.code !== 0) {
            try {
              const failedRoot = path.join(structuresDir, '_dvb_failed')
              fs.mkdirSync(failedRoot, { recursive: true })
              const dest = path.join(failedRoot, subdirName)
              // If a previous failure with same timestamp exists (rare), append a suffix
              let finalDest = dest
              let counter = 1
              while (fs.existsSync(finalDest)) {
                finalDest = `${dest}_${counter++}`
              }
              fs.renameSync(outDir, finalDest)
              movedTo = path.relative(structuresDir, finalDest).replace(/\\/g, '/')
            } catch (err) {
              console.warn('[api] failed to move failed run:', err)
              // Fallback: try to remove the empty/junk output dir
              try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}
            }
          }

          // Register the output in structures/index.json as a CHILD of the input.
          // Library renders this hierarchically (parent → child).
          if (result.code === 0 && fs.existsSync(outFile)) {
            try {
              const indexPath = path.join(structuresDir, 'index.json')
              let entries: any[] = []
              if (fs.existsSync(indexPath)) {
                try { entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
              }
              const relFile = path.relative(structuresDir, outFile).replace(/\\/g, '/')
              if (!entries.some(e => e.file === relFile)) {
                entries.push({
                  id: relFile,
                  file: relFile,
                  name: `${path.basename(inputResolved, path.extname(inputResolved))} → ${command}`,
                  parent: body.inputFile,
                  command,
                  organism: '',
                  chains: 0,
                  residues: 0,
                  description: `DVBFixer ${command} · ${new Date().toLocaleString()}`,
                })
                fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
              }
            } catch (err) {
              console.warn('[api] failed to write index.json:', err)
            }
          }

          sendJson(res, result.code === 0 ? 200 : 500, {
            ok: result.code === 0,
            command,
            outputFile: path.relative(structuresDir, outFile),
            outputDir: subdirName,
            movedTo,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.code,
          })
        } catch (err: any) {
          sendJson(res, 500, { error: err.message ?? String(err) })
        }
      })

      // ── Mutations CRUD ────────────────────────────────────────────────
      server.middlewares.use('/api/mutations', async (req, res, next) => {
        const pg = await getPg()
        if (!pg) {
          return sendJson(res, 503, { error: 'DATABASE_URL not configured' })
        }
        try {
          const url = req.url || ''
          // Strip query string and split. /api/mutations/123 → ['', '123']
          const pathOnly = url.split('?')[0]
          const idMatch = pathOnly.match(/^\/(\d+)$/)
          const id = idMatch ? parseInt(idMatch[1], 10) : null

          if (req.method === 'GET' && !id) {
            const { rows } = await pg.query(
              'SELECT id, chain, mutation_name, mutations, igg_subclass FROM mutations ORDER BY id ASC'
            )
            return sendJson(res, 200, rows)
          }

          if (req.method === 'POST' && !id) {
            const body = JSON.parse(await readBody(req) || '{}')
            const { chain = '', mutation_name = '', mutations = '', igg_subclass = '' } = body
            const { rows } = await pg.query(
              'INSERT INTO mutations (chain, mutation_name, mutations, igg_subclass) VALUES ($1, $2, $3, $4) RETURNING id, chain, mutation_name, mutations, igg_subclass',
              [chain, mutation_name, mutations, igg_subclass]
            )
            await dumpMutationsToBackup(pg)
            return sendJson(res, 201, rows[0])
          }

          if (req.method === 'PUT' && id) {
            const body = JSON.parse(await readBody(req) || '{}')
            const { chain, mutation_name, mutations, igg_subclass } = body
            const { rows } = await pg.query(
              'UPDATE mutations SET chain = COALESCE($2, chain), mutation_name = COALESCE($3, mutation_name), mutations = COALESCE($4, mutations), igg_subclass = COALESCE($5, igg_subclass) WHERE id = $1 RETURNING id, chain, mutation_name, mutations, igg_subclass',
              [id, chain, mutation_name, mutations, igg_subclass]
            )
            await dumpMutationsToBackup(pg)
            return sendJson(res, 200, rows[0])
          }

          if (req.method === 'DELETE' && id) {
            await pg.query('DELETE FROM mutations WHERE id = $1', [id])
            await dumpMutationsToBackup(pg)
            return sendJson(res, 204, {})
          }

          return next()
        } catch (err: any) {
          sendJson(res, 500, { error: err.message ?? String(err) })
        }
      })

      // ── Spec exposure (so frontend doesn't import server/) ────────────
      server.middlewares.use('/api/dvbfixer-spec', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        sendJson(res, 200, COMMANDS)
      })

      // ── Update library entry metadata ─────────────────────────────────
      // PUT /api/library/meta { file, name?, organism?, method?, resolution?, description? }
      // Persists user edits from the Info panel into index.json so they
      // survive across structure switches and page reloads.
      server.middlewares.use('/api/library/meta', async (req, res, next) => {
        if (req.method !== 'PUT' && req.method !== 'POST') return next()
        try {
          const body = JSON.parse(await readBody(req) || '{}')
          const file = body.file as string | undefined
          if (!file) return sendJson(res, 400, { error: 'file required' })

          const indexPath = path.join(structuresDir, 'index.json')
          let entries: any[] = []
          if (fs.existsSync(indexPath)) {
            try { entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
          }

          let idx = entries.findIndex(e => e.file === file)
          if (idx === -1) {
            // Auto-detected — promote into index.json
            const absPath = path.resolve(path.join(structuresDir, file))
            if (!absPath.startsWith(structuresDir) || !fs.existsSync(absPath)) {
              return sendJson(res, 404, { error: 'file not found on disk' })
            }
            entries.push({
              id: file,
              file,
              // Preserve the filename's actual case — extension-stripped basename.
              // Previously `.toUpperCase()` here mangled mixed-case names.
              name: path.basename(file).replace(/\.(pdb|cif|mmcif)$/i, ''),
              organism: '', chains: 0, residues: 0,
              description: '',
            })
            idx = entries.length - 1
          }

          const entry = entries[idx]
          // Only patch known meta fields. (Don't blindly merge — we don't want
          // the client to overwrite `id`/`file`/`parent`/`starred` etc.)
          // A `null` value is treated as "delete this key" so the client can
          // remove a manual equivalent-chains override and fall back to
          // auto-detection without leaving an empty array in index.json.
          for (const key of ['name', 'organism', 'method', 'resolution', 'description', 'iggSubtype', 'allotype', 'equivalentChains'] as const) {
            if (!(key in body)) continue
            if (body[key] === null) delete entry[key]
            else entry[key] = body[key]
          }

          fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
          sendJson(res, 200, { ok: true, entry })
        } catch (err: any) {
          sendJson(res, 500, { error: err.message ?? String(err) })
        }
      })

      // ── Star a library entry ──────────────────────────────────────────
      // POST /api/library/star  { file }
      //   Marks the entry as the DEFAULT to load when clicking its family
      //   root. The tree structure is NOT modified — parent/child stays as
      //   it was. The library UI uses this flag to choose which descendant
      //   to load when the top-level (root of the family) is clicked.
      //   Toggling: clicking again unstars. Only one starred per family.
      server.middlewares.use('/api/library/star', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const body = JSON.parse(await readBody(req) || '{}')
          const file = body.file as string | undefined
          if (!file) return sendJson(res, 400, { error: 'file required' })

          const indexPath = path.join(structuresDir, 'index.json')
          let entries: any[] = []
          if (fs.existsSync(indexPath)) {
            try { entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
          }

          // Build a parent-pointer map of CURRENT entries + everything on disk
          // (so we can compute the "family root" even for auto-detected files).
          const indexFor = (f: string) => entries.findIndex(e => e.file === f)

          // Ensure the target file is persisted (might be auto-detected).
          let idx = indexFor(file)
          if (idx === -1) {
            const absPath = path.resolve(path.join(structuresDir, file))
            if (!absPath.startsWith(structuresDir) || !fs.existsSync(absPath)) {
              return sendJson(res, 404, { error: 'file not found on disk' })
            }
            entries.push({
              id: file,
              file,
              // Preserve the filename's actual case — extension-stripped basename.
              // Previously `.toUpperCase()` here mangled mixed-case names.
              name: path.basename(file).replace(/\.(pdb|cif|mmcif)$/i, ''),
              organism: '', chains: 0, residues: 0,
              description: '',
            })
            idx = entries.length - 1
          }

          const target = entries[idx]
          // Walk up the parent chain to find the family root.
          const familyRootFile = (() => {
            let cur = target
            const seen = new Set<string>()
            while (cur.parent && !seen.has(cur.parent)) {
              seen.add(cur.parent)
              const parentIdx = indexFor(cur.parent)
              if (parentIdx === -1) break
              cur = entries[parentIdx]
            }
            return cur.file
          })()

          // Walk down to collect ALL entries in this family (root + every descendant).
          const familyFiles = new Set<string>([familyRootFile])
          let changed = true
          while (changed) {
            changed = false
            for (const e of entries) {
              if (e.parent && familyFiles.has(e.parent) && !familyFiles.has(e.file)) {
                familyFiles.add(e.file)
                changed = true
              }
            }
          }

          // Toggle: if already starred, unstar; otherwise star (and unstar siblings).
          const wasStarred = !!target.starred
          for (const e of entries) {
            if (familyFiles.has(e.file)) e.starred = false
          }
          if (!wasStarred) target.starred = true

          fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
          sendJson(res, 200, { ok: true, entries })
        } catch (err: any) {
          sendJson(res, 500, { error: err.message ?? String(err) })
        }
      })

      // ── Antibody Engineer pipeline (SSE) ─────────────────────────────
      // POST /api/antibody-engineer/run streams progress for the
      // multi-step DVBFixer pipeline that applies one or more selected
      // Mutations DB rows (with equivalent-chain fan-out) to a structure.
      server.middlewares.use('/api/antibody-engineer/run', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const bodyText = await readBody(req)
          const body = JSON.parse(bodyText || '{}') as {
            inputFile?: string
            mutationIds?: number[]
            equivalentChainsMap?: Record<string, string[]>
            hasGlycan?: boolean
            scheme?: 'EU' | 'Kabat'
          }
          if (!body.inputFile) return sendJson(res, 400, { error: 'inputFile required' })
          if (!Array.isArray(body.mutationIds) || body.mutationIds.length === 0) {
            return sendJson(res, 400, { error: 'mutationIds required (non-empty array)' })
          }
          if (typeof body.hasGlycan !== 'boolean') return sendJson(res, 400, { error: 'hasGlycan required' })
          if (body.scheme !== 'EU' && body.scheme !== 'Kabat') return sendJson(res, 400, { error: 'scheme must be EU or Kabat' })

          const inputAbs = path.resolve(structuresDir, body.inputFile)
          if (!inputAbs.startsWith(structuresDir) || !fs.existsSync(inputAbs)) {
            return sendJson(res, 404, { error: 'inputFile not found under structures/' })
          }

          // Dynamic imports so SSE-specific deps stay out of cold-path code.
          const { runEngineerPipeline, engineerChecksum, findCachedEntry } =
            await import('./antibody-pipeline')

          // Compute checksum + lookup cache. Cache hit = no pipeline run.
          const checksum = engineerChecksum({
            inputFile: body.inputFile,
            mutationIds: body.mutationIds,
            hasGlycan: body.hasGlycan,
            scheme: body.scheme,
          })

          writeSSEHeaders(res)
          let aborted = false
          req.on('close', () => { aborted = true })

          const cached = findCachedEntry(structuresDir, body.inputFile, checksum)
          if (cached) {
            sseSend(res, { step: 0, total: 0, name: 'cached', status: 'done', outputFile: cached.file })
            sseSend(res, { step: 0, total: 0, status: 'complete', outputFile: cached.file, entry: cached })
            res.end()
            return
          }

          // Look up the selected mutation rows from postgres. The Mutations
          // DB is the source of truth for what to mutate; the engineer tool
          // only references them by id.
          const pg = await getPg()
          if (!pg) {
            sseSend(res, { step: 0, total: 0, name: 'validate', status: 'error', stderr: 'DATABASE_URL not configured — mutations table unavailable.' })
            res.end()
            return
          }
          const { rows } = await pg.query(
            'SELECT id, chain, mutation_name, mutations FROM mutations WHERE id = ANY($1::int[]) ORDER BY id ASC',
            [body.mutationIds]
          )
          if (rows.length !== body.mutationIds.length) {
            const found = new Set(rows.map((r: any) => r.id))
            const missing = body.mutationIds.filter(id => !found.has(id))
            sseSend(res, { step: 0, total: 0, name: 'validate', status: 'error', stderr: `Mutation row(s) not found: ${missing.join(', ')}` })
            res.end()
            return
          }

          await runEngineerPipeline({
            structuresDir,
            inputFile: body.inputFile,
            mutationRows: rows as any,
            mutationIds: body.mutationIds,
            equivalentChainsMap: body.equivalentChainsMap ?? {},
            hasGlycan: body.hasGlycan,
            scheme: body.scheme,
            checksum,
            onEvent: (e) => sseSend(res, e),
            isAborted: () => aborted,
          })

          res.end()
        } catch (err: any) {
          // SSE response may already be writing — try a final error frame.
          try {
            sseSend(res, { step: 0, total: 0, name: 'fatal', status: 'error', stderr: err?.message ?? String(err) })
            res.end()
          } catch {
            sendJson(res, 500, { error: err?.message ?? String(err) })
          }
        }
      })

      // ── Health / config ───────────────────────────────────────────────
      server.middlewares.use('/api/status', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const pg = await getPg()
        const dvbfixer = process.env.DVBFIXER_CMD || 'dvbfixer'
        sendJson(res, 200, {
          dvbfixer,
          databaseConfigured: !!process.env.DATABASE_URL,
          databaseConnected: !!pg,
        })
      })
    },
  }
}
