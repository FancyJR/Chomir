#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Local desktop client: Vue(8080) + Express(8787) + Electron window.
 */
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const http = require('http')

const root = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'
const children = []

function run (cmd, args, name) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: isWin
  })
  child.on('exit', (code, signal) => {
    if (signal) return
    if (code && code !== 0) {
      console.error(`[dev:${name}] exited with ${code}`)
    }
  })
  children.push(child)
  return child
}

function waitFor (url, timeoutMs = 90000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timeout waiting for ${url}`))
          return
        }
        setTimeout(tick, 400)
      })
      req.setTimeout(2000, () => req.destroy())
    }
    tick()
  })
}

function shutdown () {
  for (const child of children) {
    try {
      if (!child.killed) child.kill('SIGTERM')
    } catch (e) { /* ignore */ }
  }
}

process.on('SIGINT', () => {
  shutdown()
  process.exit(0)
})
process.on('SIGTERM', () => {
  shutdown()
  process.exit(0)
})

function packageManager () {
  const r = spawnSync('yarn', ['--version'], { stdio: 'ignore', shell: isWin })
  return r.status === 0 ? 'yarn' : 'npm'
}

const pm = packageManager()
console.log('[dev] starting Vue (8080) + API (8787) + Electron…')

if (pm === 'yarn') {
  run('yarn', ['serve'], 'serve')
  run('yarn', ['server'], 'server')
} else {
  run('npm', ['run', 'serve'], 'serve')
  run('npm', ['run', 'server'], 'server')
}

waitFor('http://127.0.0.1:8787/api/debug-env')
  .then(() => waitFor('http://127.0.0.1:8080'))
  .then(() => {
    const electronBin = require('electron')
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        AIFRONT_DESKTOP: '1',
        AIFRONT_DEV_URL: 'http://127.0.0.1:8080',
        AIFRONT_DEV_API: 'http://127.0.0.1:8787'
      },
      shell: isWin
    })
    children.push(child)
    child.on('exit', (code) => {
      shutdown()
      process.exit(code || 0)
    })
  })
  .catch((err) => {
    console.error('[dev] failed:', err.message)
    shutdown()
    process.exit(1)
  })
