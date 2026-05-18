#!/usr/bin/env node
/**
 * Smart dev launcher.
 *
 *   - If DATABASE_URL is already set → just runs `vite` (user is responsible
 *     for their own postgres).
 *   - Otherwise, if `docker` (or `docker-compose`) is available → starts the
 *     bundled postgres container via docker-compose.yml, waits for it to be
 *     ready, sets DATABASE_URL automatically, then runs `vite`.
 *   - If docker is unavailable → still runs `vite`; the Mutations tab will
 *     show a "DATABASE_URL not configured" notice but everything else works.
 *
 * Stopping `npm run dev` does NOT kill the container — leave it up for next
 * time, or run `npm run db:down` to stop & remove it.
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const PORT = 5432
const URL = 'postgres://tarantino:tarantino@localhost:5432/tarantino'

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
  return r.status === 0
}

function dockerCompose() {
  // Prefer `docker compose` (v2 plugin) over the legacy `docker-compose` binary
  if (which('docker')) {
    const probe = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    if (probe.status === 0) return ['docker', ['compose']]
  }
  if (which('docker-compose')) return ['docker-compose', []]
  return null
}

function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.end(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for port ${port}`))
        setTimeout(tryOnce, 500)
      })
    }
    tryOnce()
  })
}

async function main() {
  if (process.env.DATABASE_URL) {
    console.log('[dev] DATABASE_URL already set — skipping auto-postgres.')
    spawnVite()
    return
  }

  const dc = dockerCompose()
  if (!dc) {
    console.warn('[dev] docker not found — running without auto-postgres.')
    console.warn('      The Mutations tab will show a configuration message.')
    console.warn('      To set up postgres manually, see README.md.')
    spawnVite()
    return
  }

  const [exe, baseArgs] = dc
  console.log('[dev] starting bundled postgres (docker-compose up -d db)…')
  const up = spawnSync(exe, [...baseArgs, 'up', '-d', 'db'], { stdio: 'inherit' })
  if (up.status !== 0) {
    console.warn('[dev] docker-compose up failed — running without DATABASE_URL.')
    spawnVite()
    return
  }

  try {
    await waitForPort(PORT)
    console.log(`[dev] postgres ready on :${PORT}`)
  } catch (e) {
    console.warn(`[dev] postgres did not become ready: ${e.message} — running anyway.`)
    spawnVite()
    return
  }

  process.env.DATABASE_URL = URL
  console.log(`[dev] DATABASE_URL = ${URL}`)
  spawnVite()
}

function spawnVite() {
  const args = process.argv.slice(2)
  const child = spawn('npx', ['vite', ...args], { stdio: 'inherit', env: process.env })
  child.on('close', (code) => process.exit(code ?? 0))
}

main()
