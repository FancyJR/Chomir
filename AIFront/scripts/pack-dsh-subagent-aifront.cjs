#!/usr/bin/env node
/**
 * Pack @aifront/dsh-subagent-aifront into a dropin tarball for Kylin Desktop overlays.
 * Usage: node scripts/pack-dsh-subagent-aifront.cjs
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkgDir = path.join(root, 'packages', 'dsh-subagent-aifront')
const outDir = path.join(root, 'deepseek-harness-Kylin-desktop', 'overlays', 'kylin', 'dropins')

if (!fs.existsSync(pkgDir)) {
  console.error('missing', pkgDir)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const packed = spawnSync('npm', ['pack', '--pack-destination', outDir], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32'
})
if (packed.status !== 0) {
  console.error(packed.stderr || packed.stdout)
  process.exit(packed.status || 1)
}
const name = String(packed.stdout || '').trim().split(/\n/).filter(Boolean).pop()
console.log('packed:', path.join(outDir, name))
console.log('Next: yarn start / seed in deepseek-harness-Kylin-desktop, then apply cordis.patch.example.yml')
