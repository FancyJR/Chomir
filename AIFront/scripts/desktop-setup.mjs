#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * AIFront desktop bootstrap — mirror of kylin yarn setup (simplified).
 * Installs deps and verifies Electron binary is present.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function run (cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    ...opts
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function hasYarn () {
  const r = spawnSync('yarn', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return r.status === 0
}

console.log('[setup] installing dependencies…')
if (hasYarn()) {
  run('yarn', ['install'])
} else {
  run('npm', ['install'])
}

const electronPath = path.join(root, 'node_modules', 'electron')
if (!fs.existsSync(electronPath)) {
  console.error('[setup] electron is missing — check package.json devDependencies')
  process.exit(1)
}

const electronCli = path.join(electronPath, 'cli.js')
const probe = spawnSync(process.execPath, [electronCli, '--version'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
})
if (probe.status !== 0) {
  console.warn('[setup] electron binary probe failed; first yarn/npm install may still be downloading it')
  console.warn(String(probe.stderr || probe.stdout || '').slice(0, 400))
} else {
  console.log('[setup] electron', String(probe.stdout || '').trim())
}

if (!fs.existsSync(path.join(root, '.env.local'))) {
  const example = path.join(root, '.env.example')
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, path.join(root, '.env.local'))
    console.log('[setup] created .env.local from .env.example — fill in DEEPSEEK_API_KEY')
  } else {
    console.log('[setup] tip: create .env.local with DEEPSEEK_API_KEY=…')
  }
}

console.log('[setup] done. Next:')
console.log('  yarn dev          # Electron + Vue + API (local client)')
console.log('  yarn dev:web      # browser only (no Electron)')
console.log('  yarn dist:mac     # macOS DMG')
console.log('  yarn dist:win     # Windows NSIS')
console.log('  yarn dist:linux   # Linux AppImage + deb (麒麟/通用)')
