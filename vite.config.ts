import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { apiPlugin } from './server/api-plugin'

function walkPdbFiles(dir: string, baseDir: string, out: string[]) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip dot-prefixed and underscore-prefixed directories (e.g. _dvb_failed/,
    // .git/). Outputs of failed DVBFixer runs are moved into _dvb_failed/ so
    // they don't pollute the library.
    if (item.isDirectory() && (item.name.startsWith('_') || item.name.startsWith('.'))) {
      continue
    }
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      walkPdbFiles(full, baseDir, out)
    } else if (item.isFile()) {
      const lower = item.name.toLowerCase()
      if (lower.endsWith('.pdb') || lower.endsWith('.cif') || lower.endsWith('.mmcif')) {
        out.push(path.relative(baseDir, full).replace(/\\/g, '/'))
      }
    }
  }
}

/** Synthetic id of the virtual root folder. Its `children` array is the
 *  authoritative ordering of top-level library entries (folders and
 *  lineage-root structures). Always present after the first scan. */
const ROOT_ID = '__root__'

function scanStructuresDir(structuresDir: string) {
  if (!fs.existsSync(structuresDir)) return []

  // Read manual index if exists (may contain entries with `parent` for
  // lineage hierarchy, plus user-defined folders).
  const indexPath = path.join(structuresDir, 'index.json')
  let manual: any[] = []
  if (fs.existsSync(indexPath)) {
    try { manual = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
  }

  // Recursively scan for .pdb/.cif/.mmcif on disk
  const allFiles: string[] = []
  walkPdbFiles(structuresDir, structuresDir, allFiles)
  const onDisk = new Set(allFiles)

  // Drop manual STRUCTURE entries whose file is missing from disk.
  // Folder entries (kind === 'folder') have no on-disk file and must
  // always survive the prune.
  let aliveManual = manual.filter((e: any) =>
    e.kind === 'folder' || onDisk.has(e.file)
  )
  let mutated = aliveManual.length !== manual.length

  // Strip orphan `parent` references on STRUCTURES pointing to files
  // no longer present ON DISK — leftovers from old star/swap bugs.
  aliveManual = aliveManual.map((e: any) => {
    if (e.kind !== 'folder' && e.parent && !onDisk.has(e.parent)) {
      mutated = true
      const { parent, ...rest } = e
      void parent
      return rest
    }
    return e
  })

  // Auto-detect on-disk files that have no manual entry yet.
  const manualFiles = new Set(
    aliveManual.filter((e: any) => e.kind !== 'folder').map((e: any) => e.file)
  )
  const autoEntries = allFiles
    .filter(f => !manualFiles.has(f))
    .map(f => {
      const id = f.replace(/\.(pdb|cif|mmcif)$/i, '')
      const base = path.basename(f).replace(/\.(pdb|cif|mmcif)$/i, '')
      return {
        id,
        kind: 'structure',
        file: f,
        // Preserve the filename's actual case.
        name: base,
        organism: '',
        chains: 0,
        residues: 0,
        description: f.includes('/')
          ? `From ${path.dirname(f)}`
          : 'Auto-detected from structures/ folder',
      }
    })

  // Merge manual + auto into one list, then ensure the __root__ folder
  // exists and contains a valid ordering of every lineage-root entry.
  let entries: any[] = [...aliveManual, ...autoEntries]

  // Build a set of every known entry id (folders use `id`, structures
  // use `file`). Every reference in folder.children must point here.
  const allIds = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'folder') allIds.add(e.id)
    else allIds.add(e.file)
  }

  // Find or create the synthetic root folder.
  let rootIdx = entries.findIndex(e => e.kind === 'folder' && e.id === ROOT_ID)
  let root: any
  if (rootIdx < 0) {
    root = { id: ROOT_ID, kind: 'folder', name: '__root__', children: [] }
    entries.push(root)
    rootIdx = entries.length - 1
    mutated = true
  } else {
    root = entries[rootIdx]
    if (!Array.isArray(root.children)) { root.children = []; mutated = true }
  }

  // Prune stale refs from every folder's children: drop ids that no
  // longer exist as entries. Lineage children (structures with `parent`)
  // ARE allowed in folder.children — the frontend suppresses their
  // default lineage rendering when they're explicitly placed.
  // Also drop the same id appearing in MULTIPLE folder.children arrays
  // — a structure belongs to at most one folder. Earlier-seen wins.
  const seenInFolder = new Set<string>()
  for (const e of entries) {
    if (e.kind !== 'folder' || !Array.isArray(e.children)) continue
    const filtered: string[] = []
    for (const id of e.children) {
      if (!allIds.has(id)) continue                          // stale ref
      if (seenInFolder.has(id)) continue                     // dup across folders
      seenInFolder.add(id)
      filtered.push(id)
    }
    if (filtered.length !== e.children.length) {
      e.children = filtered
      mutated = true
    }
  }

  // Set of every id that's already placed somewhere in folder.children.
  const placed = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'folder' && Array.isArray(e.children)) {
      for (const id of e.children) placed.add(id)
    }
  }

  // Any lineage-root entry (folder OR structure without a parent) that
  // isn't placed in any folder lands in __root__.children. This both
  // initialises the layout on first run AND auto-adopts newly auto-
  // detected files dropped into structures/.
  for (const e of entries) {
    let id: string
    if (e.kind === 'folder') {
      if (e.id === ROOT_ID) continue       // root never references itself
      id = e.id
    } else {
      if (e.parent) continue               // lineage child, not a folder member
      id = e.file
    }
    if (!placed.has(id)) {
      root.children.push(id)
      placed.add(id)
      mutated = true
    }
  }

  if (mutated) {
    try { fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2)) } catch {}
  }

  return entries
}

export default defineConfig({
  plugins: [
    react(),
    apiPlugin(),
    {
      name: 'serve-structures',
      configureServer(server) {
        server.middlewares.use('/structures', (req, res, next) => {
          const structuresDir = path.resolve(__dirname, 'structures')

          if (req.url?.startsWith('/index.json') || req.url === '/') {
            // Always scan folder fresh — no caching
            const entries = scanStructuresDir(structuresDir)
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-store')
            res.end(JSON.stringify(entries))
            return
          }

          const filePath = path.join(structuresDir, decodeURIComponent(req.url!))
          const resolved = path.resolve(filePath)
          if (!resolved.startsWith(structuresDir)) {
            res.statusCode = 403
            res.end('Forbidden')
            return
          }
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            res.setHeader('Content-Type', 'text/plain')
            res.end(fs.readFileSync(resolved, 'utf-8'))
          } else {
            next()
          }
        })
      },
      closeBundle() {
        const src = path.resolve(__dirname, 'structures')
        const dest = path.resolve(__dirname, 'dist/structures')
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true })
          // Generate merged index for production
          const entries = scanStructuresDir(src)
          fs.writeFileSync(path.join(dest, 'index.json'), JSON.stringify(entries, null, 2))
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: [
      'style-to-js',
      'style-to-object',
      'hast-util-to-jsx-runtime',
      'react-markdown',
    ],
  },
  ssr: {
    noExternal: ['molstar'],
  },
})
