#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Shared electron-builder runner for dist:mac / dist:win / dist:linux
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'

function run (cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: isWin
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

function pm () {
  try {
    spawnSync('yarn', ['--version'], { stdio: 'ignore', shell: isWin })
    return 'yarn'
  } catch (e) {
    return 'npm'
  }
}

const target = process.argv[2]
if (!['mac', 'win', 'linux'].includes(target)) {
  console.error('Usage: node scripts/desktop-dist.mjs <mac|win|linux>')
  process.exit(1)
}

const pkgManager = pm()
console.log(`[dist:${target}] building Vue frontend…`)
if (pkgManager === 'yarn') run('yarn', ['build'])
else run('npm', ['run', 'build'])

const distIndex = path.join(root, 'dist', 'index.html')
if (!fs.existsSync(distIndex)) {
  console.error('[dist] missing dist/index.html after yarn build')
  process.exit(1)
}

const builderArgs = {
  mac: ['--mac', 'dmg', 'dir'],
  win: ['--win', 'nsis', '--x64'],
  linux: ['--linux', 'AppImage', 'deb', '--x64']
}[target]

console.log(`[dist:${target}] packaging with electron-builder…`)
if (pkgManager === 'yarn') {
  run('yarn', ['electron-builder', '--config', 'electron-builder.yml', ...builderArgs])
} else {
  run('npx', ['electron-builder', '--config', 'electron-builder.yml', ...builderArgs])
}

console.log(`[dist:${target}] done → ${path.join(root, 'release')}`)
