#!/usr/bin/env node
/**
 * Pack @aifront/dsh-subagent-shiyunn8n with bundled shiyunn8n runtime.
 * Enforces 3MB cap on vendor bundle.
 * Usage: node scripts/pack-dsh-subagent-shiyunn8n.cjs
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const MAX_BYTES = 3 * 1024 * 1024
const root = path.resolve(__dirname, '..')
const pkgDir = path.join(root, 'packages', 'dsh-subagent-shiyunn8n')
const vendorDir = path.join(pkgDir, 'vendor', 'shiyunn8n-runtime')
const outDir = path.join(root, 'deepseek-harness-Kylin-desktop', 'overlays', 'kylin', 'dropins')

function dirSizeBytes(dir) {
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) total += dirSizeBytes(p)
    else total += st.size
  }
  return total
}

function copyRuntime() {
  const src = path.join(root, 'shiyunn8n')
  if (!fs.existsSync(src)) {
    console.error('missing shiyunn8n runtime at', src)
    process.exit(1)
  }
  fs.rmSync(vendorDir, { recursive: true, force: true })
  fs.mkdirSync(vendorDir, { recursive: true })
  fs.cpSync(src, vendorDir, {
    recursive: true,
    filter: (srcPath) => {
      const base = path.basename(srcPath)
      if (base === 'node_modules' || base === '.git') return false
      return true
    },
  })
  const binDir = path.join(vendorDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, 'shiyunn8n-agent.js'),
    [
      '#!/usr/bin/env node',
      "'use strict'",
      "require('../../server/cli/shiyunn8nAgent.js')",
      '',
    ].join('\n'),
  )
  fs.mkdirSync(path.join(vendorDir, 'server', 'cli'), { recursive: true })
  fs.cpSync(
    path.join(root, 'server', 'cli', 'shiyunn8nAgent.js'),
    path.join(vendorDir, 'server', 'cli', 'shiyunn8nAgent.js'),
    { force: true },
  )
}

if (!fs.existsSync(pkgDir)) {
  console.error('missing', pkgDir)
  process.exit(1)
}

copyRuntime()
const bytes = dirSizeBytes(vendorDir)
const mb = (bytes / (1024 * 1024)).toFixed(2)
console.log(`vendor bundle: ${mb} MB (${bytes} bytes)`)
if (bytes > MAX_BYTES) {
  console.error(`ERROR: vendor bundle exceeds 3MB cap (${mb} MB)`)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const packed = spawnSync('npm', ['pack', '--pack-destination', outDir], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (packed.status !== 0) {
  console.error(packed.stderr || packed.stdout)
  process.exit(packed.status || 1)
}
const name = String(packed.stdout || '').trim().split(/\n/).filter(Boolean).pop()
const tgzPath = path.join(outDir, name)
const tgzSize = fs.statSync(tgzPath).size
console.log('packed:', tgzPath, `(${(tgzSize / (1024 * 1024)).toFixed(2)} MB compressed)`)
if (tgzSize > MAX_BYTES) {
  console.error(`ERROR: compressed tgz exceeds 3MB (${(tgzSize / (1024 * 1024)).toFixed(2)} MB)`)
  process.exit(1)
}
