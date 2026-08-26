/**
 * LSP（对标 panda-code services/lsp）
 *
 * - 常驻 stdio Language Server：spawn → initialize → didOpen/didChange/didSave/didClose
 * - 按 extensionToLanguage 路由；被动接收 textDocument/publishDiagnostics
 * - 配置：.panda/lsp.json
 * - 无匹配 server 时回退 builtinDiagnostics（启发式兜底）
 *
 * lsp.json 示例：
 * {
 *   "servers": {
 *     "typescript": {
 *       "command": "npx",
 *       "args": ["--yes", "typescript-language-server", "--stdio"],
 *       "extensionToLanguage": {
 *         ".ts": "typescript", ".tsx": "typescriptreact",
 *         ".js": "javascript", ".jsx": "javascriptreact"
 *       },
 *       "initializationOptions": {},
 *       "startupTimeout": 60,
 *       "maxRestarts": 3
 *     }
 *   }
 * }
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')

function lspConfigPath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'lsp.json')
}

async function loadLspConfig (projectRoot) {
  try {
    return JSON.parse(await fsp.readFile(lspConfigPath(projectRoot), 'utf8'))
  } catch (e) {
    return { servers: {} }
  }
}

function toUri (absPath) {
  return pathToFileURL(path.resolve(absPath)).href
}

function normalizeExt (ext) {
  if (!ext) return ''
  const e = String(ext).toLowerCase()
  return e.startsWith('.') ? e : ('.' + e)
}

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

function defaultLanguageId (relOrAbs) {
  const ext = path.extname(relOrAbs).toLowerCase()
  const map = {
    '.vue': 'vue',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.md': 'markdown',
    '.py': 'python'
  }
  return map[ext] || 'plaintext'
}

/**
 * 手写 JSON-RPC over stdio（Content-Length），避免新增 vscode-jsonrpc 依赖
 */
class LspStdioClient {
  constructor (name, spec, root) {
    this.name = name
    this.spec = spec
    this.root = root
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.initialized = false
    this.capabilities = null
    this.stopping = false
    this.startFailed = false
    this.restartCount = 0
    /** uri -> Diagnostic[] */
    this.diagByUri = new Map()
    /** uri -> waiters */
    this.diagWaiters = new Map()
    this.notifHandlers = new Map()
    this.reqHandlers = new Map()
  }

  onNotification (method, handler) {
    if (!this.notifHandlers.has(method)) this.notifHandlers.set(method, [])
    this.notifHandlers.get(method).push(handler)
  }

  onRequest (method, handler) {
    this.reqHandlers.set(method, handler)
  }

  async start () {
    if (this.proc) return
    this.stopping = false
    this.startFailed = false

    const cmd = this.spec.command
    const args = this.spec.args || []
    if (!cmd) throw new Error('LSP server ' + this.name + ' missing command')

    this.proc = spawn(cmd, args, {
      cwd: this.spec.cwd || this.spec.workspaceFolder || this.root,
      env: Object.assign({}, process.env, this.spec.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    const proc = this.proc
    await new Promise((resolve, reject) => {
      let done = false
      const finish = (fn, v) => {
        if (done) return
        done = true
        cleanup()
        fn(v)
      }
      const onSpawn = () => finish(resolve)
      const onError = (err) => finish(reject, err)
      const cleanup = () => {
        proc.removeListener('spawn', onSpawn)
        proc.removeListener('error', onError)
      }
      proc.once('spawn', onSpawn)
      proc.once('error', onError)
      // 无 spawn 事件的旧 Node：pid 出现即视为就绪
      setTimeout(() => {
        if (proc.pid) finish(resolve)
      }, 80)
    })

    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        const t = String(d).trim()
        if (t) console.log('[lsp:' + this.name + ']', t.slice(0, 400))
      })
    }
    if (proc.stdin) {
      proc.stdin.on('error', () => {})
    }
    proc.stdout.on('data', (chunk) => this.onData(chunk))
    proc.on('exit', (code) => {
      this.proc = null
      this.initialized = false
      for (const [, p] of this.pending) {
        try { p.reject(new Error('LSP exited')) } catch (e) { /* ignore */ }
      }
      this.pending.clear()
      if (!this.stopping && code !== 0 && code != null) {
        console.warn('[lsp] server', this.name, 'crashed code=' + code)
      }
    })
  }

  onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.slice(0, headerEnd).toString('utf8')
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const len = parseInt(m[1], 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + len) return
      const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8')
      this.buffer = this.buffer.slice(bodyStart + len)
      let msg
      try { msg = JSON.parse(body) } catch (e) { continue }
      this.dispatch(msg)
    }
  }

  dispatch (msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (msg.method && msg.id != null && this.reqHandlers.has(msg.method)) {
      Promise.resolve()
        .then(() => this.reqHandlers.get(msg.method)(msg.params || {}))
        .then((result) => {
          this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: result == null ? null : result })
        })
        .catch((err) => {
          this.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err.message || String(err) }
          })
        })
      return
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const uri = msg.params.uri
      const diags = msg.params.diagnostics || []
      this.diagByUri.set(uri, diags)
      const waiters = this.diagWaiters.get(uri) || []
      this.diagWaiters.delete(uri)
      for (const w of waiters) {
        try { w.resolve(diags) } catch (e) { /* ignore */ }
      }
    }
    if (msg.method && this.notifHandlers.has(msg.method)) {
      for (const h of this.notifHandlers.get(msg.method)) {
        try { h(msg.params) } catch (e) { /* ignore */ }
      }
    }
  }

  sendRaw (msg) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('LSP stdin unavailable: ' + this.name)
    }
    const json = JSON.stringify(msg)
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
    this.proc.stdin.write(payload)
  }

  request (method, params, timeoutMs) {
    const id = this.nextId++
    const ms = timeoutMs || 20000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('LSP timeout: ' + method))
      }, ms)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  notify (method, params) {
    this.sendRaw({ jsonrpc: '2.0', method, params })
  }

  waitDiagnostics (uri, timeoutMs) {
    const existing = this.diagByUri.get(uri)
    return new Promise((resolve) => {
      const ms = Math.max(200, timeoutMs || 5000)
      const list = this.diagWaiters.get(uri) || []
      const entry = { resolve }
      list.push(entry)
      this.diagWaiters.set(uri, list)
      setTimeout(() => {
        const cur = this.diagWaiters.get(uri) || []
        const idx = cur.indexOf(entry)
        if (idx >= 0) {
          cur.splice(idx, 1)
          if (cur.length) this.diagWaiters.set(uri, cur)
          else this.diagWaiters.delete(uri)
          resolve(this.diagByUri.get(uri) || existing || [])
        }
      }, ms)
    })
  }

  async initialize () {
    await this.start()
    const rootUri = toUri(this.root)
    const startupTimeout = Math.max(
      5000,
      (Number(this.spec.startupTimeout) > 0 ? Number(this.spec.startupTimeout) : 60) * 1000
    )

    this.onRequest('workspace/configuration', (params) => {
      const items = (params && params.items) || []
      return items.map(() => null)
    })
    this.onRequest('window/workDoneProgress/create', () => null)
    this.onRequest('client/registerCapability', () => null)
    this.onRequest('client/unregisterCapability', () => null)

    const result = await Promise.race([
      this.request('initialize', {
        processId: process.pid,
        rootPath: this.root,
        rootUri,
        locale: 'zh-CN',
        initializationOptions: this.spec.initializationOptions || {},
        capabilities: {
          workspace: {
            workspaceFolders: true,
            configuration: true,
            applyEdit: false
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: true
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: {},
            diagnostic: { dynamicRegistration: false }
          }
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }]
      }, startupTimeout),
      sleep(startupTimeout).then(() => {
        throw new Error('initialize timeout (' + startupTimeout + 'ms)')
      })
    ])

    this.capabilities = (result && result.capabilities) || {}
    this.notify('initialized', {})
    this.initialized = true
    return result
  }

  async stop () {
    this.stopping = true
    try {
      if (this.initialized && this.proc) {
        try { await this.request('shutdown', null, 2000) } catch (e) { /* ignore */ }
        try { this.notify('exit', undefined) } catch (e) { /* ignore */ }
      }
    } finally {
      const proc = this.proc
      this.proc = null
      this.initialized = false
      if (proc) {
        try { proc.kill('SIGTERM') } catch (e) { /* ignore */ }
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL')
          } catch (e) { /* ignore */ }
        }, 1500)
      }
    }
  }
}

class LspManager {
  constructor (projectRoot) {
    this.projectRoot = projectRoot
    this.servers = new Map()
    this.extensionMap = new Map()
    this.opened = new Map()
    this.configMtime = 0
    this.ready = false
  }

  async reloadIfNeeded () {
    let st
    try {
      st = await fsp.stat(lspConfigPath(this.projectRoot))
    } catch (e) {
      st = null
    }
    const mtime = st ? st.mtimeMs : 0
    if (this.ready && mtime === this.configMtime) return
    if (this.ready) await this.shutdown()
    await this.load()
    this.configMtime = mtime
  }

  async load () {
    const cfg = await loadLspConfig(this.projectRoot)
    const servers = cfg.servers || {}
    for (const [name, spec] of Object.entries(servers)) {
      if (!spec || !spec.command) {
        console.warn('[lsp] skip', name, ': missing command')
        continue
      }
      let extMap = spec.extensionToLanguage
      if (!extMap || !Object.keys(extMap).length) {
        extMap = {
          '.ts': 'typescript',
          '.tsx': 'typescriptreact',
          '.js': 'javascript',
          '.jsx': 'javascriptreact',
          '.mjs': 'javascript',
          '.vue': 'vue'
        }
        console.warn('[lsp]', name, '缺少 extensionToLanguage，使用默认 js/ts/vue 映射')
      }
      for (const ext of Object.keys(extMap)) {
        const n = normalizeExt(ext)
        if (!this.extensionMap.has(n)) this.extensionMap.set(n, [])
        this.extensionMap.get(n).push(name)
      }
      const client = new LspStdioClient(
        name,
        Object.assign({}, spec, { extensionToLanguage: extMap }),
        this.projectRoot
      )
      this.servers.set(name, {
        client,
        spec: Object.assign({}, spec, { extensionToLanguage: extMap })
      })
    }
    this.ready = true
  }

  serverNamesForFile (filePath) {
    const ext = normalizeExt(path.extname(filePath))
    return this.extensionMap.get(ext) || []
  }

  hasServerForFile (filePath) {
    return this.serverNamesForFile(filePath).length > 0
  }

  languageIdFor (serverName, filePath) {
    const entry = this.servers.get(serverName)
    const map = (entry && entry.spec && entry.spec.extensionToLanguage) || {}
    const ext = normalizeExt(path.extname(filePath))
    return map[ext] || map[ext.slice(1)] || defaultLanguageId(filePath)
  }

  async ensureClient (serverName) {
    const entry = this.servers.get(serverName)
    if (!entry) return null
    const { client, spec } = entry
    const maxRestarts = Number(spec.maxRestarts) >= 0 ? Number(spec.maxRestarts) : 3
    if (client.initialized && client.proc) return client
    if (client.restartCount > maxRestarts) {
      throw new Error('LSP ' + serverName + ' exceeded maxRestarts (' + maxRestarts + ')')
    }
    try {
      await client.initialize()
    } catch (e) {
      client.restartCount++
      client.startFailed = true
      try { await client.stop() } catch (e2) { /* ignore */ }
      throw e
    }
    return client
  }

  async openFile (absPath, content) {
    await this.reloadIfNeeded()
    const names = this.serverNamesForFile(absPath)
    if (!names.length) return
    const uri = toUri(absPath)
    const text = content != null ? String(content) : await fsp.readFile(absPath, 'utf8')
    for (const name of names) {
      let client
      try {
        client = await this.ensureClient(name)
      } catch (e) {
        console.warn('[lsp] start failed', name, e.message)
        continue
      }
      if (!client) continue
      const languageId = this.languageIdFor(name, absPath)
      const prev = this.opened.get(uri + '::' + name)
      const version = prev ? prev.version + 1 : 1
      if (prev) {
        client.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text }]
        })
      } else {
        client.diagByUri.delete(uri)
        client.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version, text }
        })
      }
      this.opened.set(uri + '::' + name, { serverName: name, version, languageId })
    }
  }

  async changeFile (absPath, content) {
    await this.openFile(absPath, content)
  }

  async saveFile (absPath) {
    await this.reloadIfNeeded()
    const names = this.serverNamesForFile(absPath)
    if (!names.length) return
    const uri = toUri(absPath)
    let text
    try {
      text = await fsp.readFile(absPath, 'utf8')
    } catch (e) {
      text = undefined
    }
    for (const name of names) {
      const entry = this.servers.get(name)
      const client = entry && entry.client
      if (!client || !client.initialized) continue
      const key = uri + '::' + name
      if (!this.opened.has(key)) {
        await this.openFile(absPath, text)
      }
      const params = { textDocument: { uri } }
      if (text != null) params.text = text
      try {
        client.notify('textDocument/didSave', params)
      } catch (e) { /* ignore */ }
    }
  }

  async closeFile (absPath) {
    const uri = toUri(absPath)
    for (const [key, info] of [...this.opened.entries()]) {
      if (!key.startsWith(uri + '::')) continue
      const entry = this.servers.get(info.serverName)
      if (entry && entry.client && entry.client.initialized) {
        try {
          entry.client.notify('textDocument/didClose', { textDocument: { uri } })
        } catch (e) { /* ignore */ }
      }
      this.opened.delete(key)
    }
  }

  async syncAfterWrite (relOrAbs, content) {
    const abs = path.isAbsolute(relOrAbs)
      ? relOrAbs
      : path.resolve(this.projectRoot, relOrAbs)
    try {
      await this.changeFile(abs, content)
      await this.saveFile(abs)
    } catch (e) {
      console.warn('[lsp] syncAfterWrite', e.message)
    }
  }

  async collectDiagnostics (absPath, waitMs) {
    await this.reloadIfNeeded()
    const names = this.serverNamesForFile(absPath)
    if (!names.length) return { fromLsp: false, parts: [], diagnostics: [] }

    let text
    try {
      text = await fsp.readFile(absPath, 'utf8')
    } catch (e) {
      return { fromLsp: true, parts: ['文件不存在'], diagnostics: [] }
    }

    await this.openFile(absPath, text)
    await this.saveFile(absPath)

    const uri = toUri(absPath)
    const wait = waitMs != null ? waitMs : 5000
    const parts = []
    const all = []

    for (const name of names) {
      let client
      try {
        client = await this.ensureClient(name)
      } catch (e) {
        parts.push('【LSP:' + name + '】启动失败：' + e.message)
        continue
      }
      if (!client) continue

      let diags = []
      try {
        const pulledP = client.request('textDocument/diagnostic', {
          textDocument: { uri }
        }, Math.min(wait, 8000)).then((r) => {
          if (!r) return []
          if (Array.isArray(r.items)) return r.items
          if (Array.isArray(r)) return r
          return []
        }).catch(() => null)

        const published = await client.waitDiagnostics(uri, wait)
        const pulled = await pulledP
        diags = (published && published.length)
          ? published
          : (pulled && pulled.length ? pulled : (client.diagByUri.get(uri) || []))
      } catch (e) {
        diags = client.diagByUri.get(uri) || []
        parts.push('【LSP:' + name + '】' + (e.message || e))
      }

      const tagged = diags.map(d => Object.assign({}, d, {
        source: d.source || name
      }))
      all.push(...tagged)
      parts.push('【LSP:' + name + '】\n' + (tagged.length ? formatDiags(tagged) : '(无诊断)'))
    }

    return { fromLsp: true, parts, diagnostics: all }
  }

  status () {
    const rows = []
    for (const [name, entry] of this.servers) {
      const c = entry.client
      const exts = Object.keys((entry.spec && entry.spec.extensionToLanguage) || {})
      rows.push({
        name,
        state: c.initialized && c.proc ? 'running' : (c.startFailed ? 'error' : 'stopped'),
        command: entry.spec.command,
        extensions: exts,
        restarts: c.restartCount
      })
    }
    return rows
  }

  async shutdown () {
    const stops = []
    for (const [, entry] of this.servers) {
      stops.push(entry.client.stop())
    }
    await Promise.allSettled(stops)
    this.servers.clear()
    this.extensionMap.clear()
    this.opened.clear()
    this.ready = false
  }
}

const managers = new Map()

async function getManager (projectRoot) {
  const root = path.resolve(projectRoot)
  let m = managers.get(root)
  if (!m) {
    m = new LspManager(root)
    managers.set(root, m)
  }
  await m.reloadIfNeeded()
  return m
}

function builtinDiagnostics (projectRoot, relPath) {
  const abs = path.resolve(projectRoot, relPath)
  if (!fs.existsSync(abs)) return { ok: false, diagnostics: [], message: '文件不存在' }
  const text = fs.readFileSync(abs, 'utf8')
  const lines = text.split(/\n/)
  const diags = []
  const push = (line, character, severity, message) => {
    diags.push({
      range: { start: { line, character }, end: { line, character: character + 1 } },
      severity,
      source: 'panda-builtin',
      message
    })
  }

  if (relPath.endsWith('.vue')) {
    if (!/<template[\s>]/.test(text)) push(0, 0, 1, '缺少 <template> 块')
    if (!/<script[\s>]/.test(text)) push(0, 0, 2, '缺少 <script> 块')
    lines.forEach((l, i) => {
      if (/\{\{\s*$/.test(l)) push(i, l.length, 2, '可能未闭合的插值 {{')
      if (/v-for=/.test(l) && !/:key=/.test(l) && !/key=/.test(l)) {
        push(i, 0, 2, 'v-for 建议提供 key')
      }
    })
  } else if (/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(relPath)) {
    lines.forEach((l, i) => {
      if (/^\s*debugger\b/.test(l)) push(i, 0, 2, '存在 debugger')
    })
  }

  return { ok: true, diagnostics: diags, source: 'builtin' }
}

function formatDiags (diags) {
  if (!diags || !diags.length) return '(无诊断问题)'
  return diags.map(d => {
    const line = (d.range && d.range.start && d.range.start.line != null)
      ? (d.range.start.line + 1)
      : '?'
    const col = (d.range && d.range.start && d.range.start.character != null)
      ? (d.range.start.character + 1)
      : '?'
    const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info'
    return `L${line}:${col} [${sev}] ${d.message} (${d.source || 'lsp'})`
  }).join('\n')
}

async function getDiagnostics (projectRoot, relPath, opts) {
  const abs = path.resolve(projectRoot, relPath)
  const rel = path.relative(projectRoot, abs) || relPath
  const manager = await getManager(projectRoot)
  const hasServer = manager.hasServerForFile(abs)
  const waitMs = (opts && opts.waitMs) != null
    ? opts.waitMs
    : (hasServer ? 6000 : 0)

  if (hasServer) {
    const collected = await manager.collectDiagnostics(abs, waitMs)
    const startedOk = collected.parts.some(p => p.indexOf('启动失败') < 0 && p.indexOf('【LSP:') === 0)
    if (startedOk || (collected.diagnostics && collected.diagnostics.length)) {
      return {
        ok: true,
        fromLsp: true,
        content: collected.parts.join('\n\n') || '(无诊断)',
        diagnostics: collected.diagnostics
      }
    }
    // 配置了 server 但全部启动失败 → 回退启发式并附失败原因
    const builtin = builtinDiagnostics(projectRoot, rel)
    return {
      ok: true,
      fromLsp: false,
      content: collected.parts.join('\n\n') +
        '\n\n【回退·内置启发式】\n' + formatDiags(builtin.diagnostics) +
        '\n\n提示：typescript-language-server 需要工作区安装 typescript（npm i -D typescript），或在 initializationOptions 指定 tsdk。',
      diagnostics: builtin.diagnostics
    }
  }

  const builtin = builtinDiagnostics(projectRoot, rel)
  const cfg = await loadLspConfig(projectRoot)
  const serverCount = Object.keys(cfg.servers || {}).length
  let tip = ''
  if (!serverCount) {
    tip = '\n\n提示：当前无 LSP server。在 .panda/lsp.json 配置 typescript-language-server 等以启用常驻真 LSP（见 _example）。'
  } else {
    tip = '\n\n提示：已配置 LSP server，但无匹配扩展名 ' + path.extname(rel) + '；检查 extensionToLanguage。'
  }
  return {
    ok: true,
    fromLsp: false,
    content: '【内置启发式】\n' + formatDiags(builtin.diagnostics) + tip,
    diagnostics: builtin.diagnostics
  }
}

async function syncAfterWrite (projectRoot, relPath, content) {
  const manager = await getManager(projectRoot)
  const abs = path.resolve(projectRoot, relPath)
  if (!manager.hasServerForFile(abs)) return { synced: false }
  await manager.syncAfterWrite(abs, content)
  return { synced: true }
}

async function getLspStatus (projectRoot) {
  const cfg = await loadLspConfig(projectRoot)
  const names = Object.keys(cfg.servers || {})
  if (!names.length) {
    return { configured: 0, servers: [], note: '未配置 servers（仅启发式）' }
  }
  const manager = await getManager(projectRoot)
  return {
    configured: names.length,
    servers: manager.status(),
    note: '常驻 LSP：按文件扩展名懒启动'
  }
}

async function shutdownAll () {
  const all = [...managers.values()]
  managers.clear()
  await Promise.allSettled(all.map(m => m.shutdown()))
}

function hasConfiguredServers (projectRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(lspConfigPath(projectRoot), 'utf8'))
    return Object.keys(cfg.servers || {}).length > 0
  } catch (e) {
    return false
  }
}

function postEditDiagTimeoutMs (projectRoot) {
  return hasConfiguredServers(projectRoot) ? 8000 : 1200
}

/**
 * LSP 导航查询（省 token：一次定位替代多次 grep/read）
 * @param {string} projectRoot
 * @param {{ action: string, path: string, line?: number, character?: number, query?: string }} opts
 * line/character 为 1-based（与编辑器一致）
 */
async function lspQuery (projectRoot, opts) {
  const action = String((opts && opts.action) || '').toLowerCase()
  const rel = String((opts && opts.path) || '').trim()
  if (!rel && action !== 'workspacesymbol') {
    return { ok: false, content: '需要 path' }
  }
  if (!hasConfiguredServers(projectRoot) && action !== 'workspacesymbol') {
    return {
      ok: false,
      content: '未配置 LSP（.panda/lsp.json）。请用 grep / read_file；或配置 typescript-language-server 等。'
    }
  }

  const manager = getManager(projectRoot)
  await manager.reloadIfNeeded()

  const formatLoc = (loc) => {
    if (!loc) return ''
    const uri = loc.uri || (loc.targetUri) || ''
    const range = loc.range || loc.targetSelectionRange || loc.targetRange
    let file = uri
    try {
      if (uri.startsWith('file:')) {
        file = path.relative(projectRoot, require('url').fileURLToPath(uri)) || uri
      }
    } catch (e) { /* keep uri */ }
    const line = range && range.start ? (range.start.line + 1) : '?'
    const col = range && range.start ? (range.start.character + 1) : '?'
    return file + ':' + line + ':' + col
  }

  const formatHover = (h) => {
    if (!h) return '(no hover)'
    const c = h.contents
    if (typeof c === 'string') return c.slice(0, 2500)
    if (c && c.value) return String(c.value).slice(0, 2500)
    if (Array.isArray(c)) {
      return c.map(x => (typeof x === 'string' ? x : (x && x.value) || '')).join('\n').slice(0, 2500)
    }
    return JSON.stringify(c).slice(0, 2500)
  }

  if (action === 'workspacesymbol') {
    const q = String((opts && opts.query) || '').trim()
    if (!q) return { ok: false, content: 'workspaceSymbol 需要 query' }
    const names = Object.keys((await loadLspConfig(projectRoot)).servers || {})
    const lines = []
    for (const name of names.slice(0, 3)) {
      let client
      try {
        client = await manager.ensureClient(name)
      } catch (e) {
        lines.push('【' + name + '】启动失败：' + e.message)
        continue
      }
      if (!client) continue
      try {
        const res = await client.request('workspace/symbol', { query: q }, 12000)
        const list = Array.isArray(res) ? res : []
        lines.push('【' + name + '】' + list.length + ' hits')
        list.slice(0, 30).forEach(s => {
          const n = s.name || '?'
          const kind = s.kind != null ? ' kind=' + s.kind : ''
          const loc = s.location ? formatLoc(s.location) : ''
          lines.push('- ' + n + kind + (loc ? ' @ ' + loc : ''))
        })
      } catch (e) {
        lines.push('【' + name + '】' + (e.message || e))
      }
    }
    return { ok: true, content: lines.join('\n').slice(0, 6000) || '(无结果)' }
  }

  const abs = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel)
  let text
  try {
    text = await fsp.readFile(abs, 'utf8')
  } catch (e) {
    return { ok: false, content: '文件不存在：' + rel }
  }
  await manager.openFile(abs, text)
  const names = manager.serverNamesForFile(abs)
  if (!names.length) {
    return { ok: false, content: '无匹配此扩展名的 LSP server：' + rel }
  }

  const line = Math.max(1, parseInt(opts.line, 10) || 1)
  const character = Math.max(1, parseInt(opts.character, 10) || 1)
  const position = { line: line - 1, character: character - 1 }
  const uri = toUri(abs)
  const client = await manager.ensureClient(names[0])
  if (!client) return { ok: false, content: 'LSP 未就绪：' + names[0] }

  const methodMap = {
    definition: 'textDocument/definition',
    def: 'textDocument/definition',
    references: 'textDocument/references',
    refs: 'textDocument/references',
    hover: 'textDocument/hover',
    documentsymbol: 'textDocument/documentSymbol',
    symbols: 'textDocument/documentSymbol'
  }
  const method = methodMap[action]
  if (!method) {
    return {
      ok: false,
      content: '未知 action。可用：definition | references | hover | documentSymbol | workspaceSymbol'
    }
  }

  const params = { textDocument: { uri }, position }
  if (method === 'textDocument/references') {
    params.context = { includeDeclaration: true }
  }
  if (method === 'textDocument/documentSymbol') {
    delete params.position
  }

  try {
    const res = await client.request(method, params, 12000)
    if (method === 'textDocument/hover') {
      return { ok: true, content: formatHover(res).slice(0, 3000) }
    }
    if (method === 'textDocument/documentSymbol') {
      const flat = []
      const walk = (arr, depth) => {
        ;(arr || []).forEach(s => {
          const r = s.range || (s.location && s.location.range)
          const ln = r && r.start ? (r.start.line + 1) : '?'
          flat.push(('  '.repeat(depth)) + (s.name || '?') + ' @' + ln + (s.kind != null ? ' k' + s.kind : ''))
          if (s.children && s.children.length) walk(s.children, depth + 1)
        })
      }
      walk(Array.isArray(res) ? res : [], 0)
      return { ok: true, content: (flat.join('\n') || '(无符号)').slice(0, 6000) }
    }
    const locs = Array.isArray(res) ? res : (res ? [res] : [])
    if (!locs.length) return { ok: true, content: '(无结果)' }
    const lines = locs.slice(0, 40).map(formatLoc).filter(Boolean)
    return { ok: true, content: lines.join('\n').slice(0, 4000) }
  } catch (e) {
    return { ok: false, content: 'LSP ' + action + ' 失败：' + (e.message || e) }
  }
}

module.exports = {
  loadLspConfig,
  getDiagnostics,
  builtinDiagnostics,
  formatDiags,
  syncAfterWrite,
  getLspStatus,
  shutdownAll,
  hasConfiguredServers,
  postEditDiagTimeoutMs,
  getManager,
  lspQuery
}
