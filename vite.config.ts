import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

function scanStructuresDir(structuresDir: string) {
  if (!fs.existsSync(structuresDir)) return []

  // Read manual index if exists
  const indexPath = path.join(structuresDir, 'index.json')
  let manual: any[] = []
  if (fs.existsSync(indexPath)) {
    try { manual = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) } catch {}
  }
  const manualFiles = new Set(manual.map((e: any) => e.file))

  // Scan folder for .pdb/.cif/.mmcif not already in index
  const files = fs.readdirSync(structuresDir).filter(f => {
    const ext = f.toLowerCase()
    return (ext.endsWith('.pdb') || ext.endsWith('.cif') || ext.endsWith('.mmcif'))
      && !manualFiles.has(f)
  })

  const autoEntries = files.map(f => {
    const id = f.replace(/\.(pdb|cif|mmcif)$/i, '')
    return {
      id,
      file: f,
      name: id.toUpperCase(),
      organism: '',
      chains: 0,
      residues: 0,
      description: 'Auto-detected from structures/ folder',
    }
  })

  return [...manual, ...autoEntries]
}

export default defineConfig({
  plugins: [
    react(),
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
