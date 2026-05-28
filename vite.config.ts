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

function scanStructuresDir(structuresDir: string) {
  if (!fs.existsSync(structuresDir)) return []

  // Read manual index if exists (may contain entries with `parent` for hierarchy)
  const indexPath = path.join(structuresDir, 'index.json')
  let manual: any[] = []
  if (fs.existsSync(indexPath)) {
    try { manual = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
  }

  // Recursively scan for .pdb/.cif/.mmcif on disk
  const allFiles: string[] = []
  walkPdbFiles(structuresDir, structuresDir, allFiles)
  const onDisk = new Set(allFiles)

  // Drop manual entries whose file is missing from disk (user deleted it).
  // Also strip orphan `parent` references that point to files no longer
  // present ON DISK — these are leftovers from old star/swap bugs and
  // break the family-tree walk in the library. NB: we check against
  // `onDisk`, NOT against the subset of files that happen to be tracked
  // manually in index.json — an auto-detected parent (a PDB the user
  // dropped in without curating index.json) is still a valid parent for
  // DVBFixer child entries. Auto-prune the index.json file so stale state
  // doesn't accumulate.
  let aliveManual = manual.filter((e: any) => onDisk.has(e.file))
  let mutated = aliveManual.length !== manual.length
  aliveManual = aliveManual.map((e: any) => {
    if (e.parent && !onDisk.has(e.parent)) {
      mutated = true
      const { parent, ...rest } = e
      void parent
      return rest
    }
    return e
  })
  if (mutated) {
    try { fs.writeFileSync(indexPath, JSON.stringify(aliveManual, null, 2)) } catch {}
  }

  const manualFiles = new Set(aliveManual.map((e: any) => e.file))

  // Subfolder paths are kept relative (e.g. 'dvb_split_2024-01-01T12-00-00/4hhb_split.pdb').
  const autoEntries = allFiles
    .filter(f => !manualFiles.has(f))
    .map(f => {
      const id = f.replace(/\.(pdb|cif|mmcif)$/i, '')
      const base = path.basename(f).replace(/\.(pdb|cif|mmcif)$/i, '')
      return {
        id,
        file: f,
        // Preserve the filename's actual case — use the basename as-is.
        // Was `base.toUpperCase()` which mangled e.g. mystructure.pdb → MYSTRUCTURE.
        name: base,
        organism: '',
        chains: 0,
        residues: 0,
        description: f.includes('/')
          ? `From ${path.dirname(f)}`
          : 'Auto-detected from structures/ folder',
      }
    })

  return [...aliveManual, ...autoEntries]
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
