/**
 * Ensures the correct platform-specific rollup native binding is installed.
 * Needed because npm sometimes skips optional native deps on install.
 * See: https://github.com/npm/cli/issues/4828
 *
 * Supports: macOS arm64/x64, Linux arm64/x64
 */
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const ROLLUP_BINDINGS = {
  'darwin-arm64': '@rollup/rollup-darwin-arm64',
  'darwin-x64': '@rollup/rollup-darwin-x64',
  'linux-x64': '@rollup/rollup-linux-x64-gnu',
  'linux-arm64': '@rollup/rollup-linux-arm64-gnu',
}

const key = `${process.platform}-${process.arch}`
const pkg = ROLLUP_BINDINGS[key]

if (!pkg) {
  console.log(`[postinstall] No rollup binding for ${key}, skipping`)
  process.exit(0)
}

if (existsSync(join(root, 'node_modules', pkg))) {
  process.exit(0)
}

console.log(`[postinstall] Installing ${pkg} for ${key}...`)
try {
  execSync(`npm install --no-save --ignore-scripts ${pkg}`, {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
  console.log(`[postinstall] ${pkg} installed`)
} catch (e) {
  console.warn(`[postinstall] Warning: failed to install ${pkg} — run 'npm install ${pkg}' manually`)
}
