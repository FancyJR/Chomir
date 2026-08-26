/* eslint-disable no-console */
const { app, BrowserWindow, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const http = require('http')

process.env.AIFRONT_DESKTOP = '1'

const isDev = !app.isPackaged
const DEV_UI_URL = process.env.AIFRONT_DEV_URL || 'http://127.0.0.1:8080'
const DEV_API_URL = process.env.AIFRONT_DEV_API || 'http://127.0.0.1:8787'

let mainWindow = null
let serverHandle = null

function projectRoot () {
  return path.resolve(__dirname, '..')
}

/** Prefer userData .env.local in packaged builds (asar has no secrets). */
function resolveEnvPath () {
  const candidates = [
    process.env.AIFRONT_ENV_PATH,
    path.join(app.getPath('userData'), '.env.local'),
    path.join(projectRoot(), '.env.local'),
    path.join(path.dirname(process.execPath), '.env.local')
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[1] || candidates[2]
}

function waitForUrl (url, { timeoutMs = 60000, intervalMs = 400 } = {}) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve(url)
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timeout waiting for ${url}`))
          return
        }
        setTimeout(tick, intervalMs)
      })
      req.setTimeout(2000, () => {
        req.destroy()
      })
    }
    tick()
  })
}

async function ensureBackend () {
  if (isDev) {
    // yarn dev 已并发启动 vue-cli(8080) + express(8787)
    await waitForUrl(DEV_API_URL + '/api/debug-env')
    await waitForUrl(DEV_UI_URL)
    return DEV_UI_URL
  }

  process.env.AIFRONT_ENV_PATH = resolveEnvPath()
  const { startServer } = require(path.join(projectRoot(), 'server', 'index.js'))
  const staticDir = path.join(projectRoot(), 'dist')
  serverHandle = await startServer({
    port: process.env.PORT || 8787,
    host: '127.0.0.1',
    staticDir,
    exitOnError: false
  })
  return serverHandle.url
}

function createWindow (url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'AIFront',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.loadURL(url)
}

async function boot () {
  const url = await ensureBackend()
  createWindow(url)
}

app.whenReady().then(() => {
  boot().catch((err) => {
    console.error('[electron] boot failed:', err)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      boot().catch((err) => {
        console.error('[electron] re-boot failed:', err)
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (serverHandle && serverHandle.httpServer) {
    try {
      serverHandle.httpServer.close()
    } catch (e) { /* ignore */ }
  }
})
