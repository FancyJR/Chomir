/**
 * MCP 客户端（对齐 panda-code services/mcp）
 *
 * - 配置：.panda/mcp.json
 * - 传输：stdio（默认）| http/sse（url）
 * - OAuth：oauth.accessToken / client_credentials / 持久化 refresh（.panda/mcp-oauth.json）
 * - 自动连接 + 工具以 mcp__server__tool 名挂到主 Agent（无需手动 mcp_call）
 *
 * mcp.json 示例：
 * {
 *   "autoConnect": true,
 *   "servers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "remote": {
 *       "type": "http",
 *       "url": "https://example.com/mcp",
 *       "headers": { "Authorization": "Bearer …" },
 *       "oauth": { "clientId": "…", "clientSecret": "…", "scopes": "…" }
 *     }
 *   }
 * }
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function configPath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'mcp.json')
}

function oauthStorePath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'mcp-oauth.json')
}

async function loadMcpConfig (projectRoot) {
  try {
    const raw = await fsp.readFile(configPath(projectRoot), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : { servers: {}, autoConnect: true }
  } catch (e) {
    return { servers: {}, autoConnect: true }
  }
}

async function saveMcpConfig (projectRoot, cfg) {
  await fsp.mkdir(path.resolve(projectRoot, '.panda'), { recursive: true })
  await fsp.writeFile(configPath(projectRoot), JSON.stringify(cfg, null, 2), 'utf8')
}

async function loadOAuthStore (projectRoot) {
  try {
    return JSON.parse(await fsp.readFile(oauthStorePath(projectRoot), 'utf8'))
  } catch (e) {
    return {}
  }
}

async function saveOAuthStore (projectRoot, store) {
  await fsp.mkdir(path.resolve(projectRoot, '.panda'), { recursive: true })
  await fsp.writeFile(oauthStorePath(projectRoot), JSON.stringify(store, null, 2), 'utf8')
}

/** 对标 normalizeNameForMCP */
function normalizeNameForMCP (name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'server'
}

function buildMcpToolName (serverName, toolName) {
  return 'mcp__' + normalizeNameForMCP(serverName) + '__' + String(toolName || '')
}

function parseMcpToolName (fullName) {
  const s = String(fullName || '')
  if (!s.startsWith('mcp__')) return null
  const rest = s.slice('mcp__'.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  return {
    serverName: rest.slice(0, idx),
    toolName: rest.slice(idx + 2)
  }
}

function isMcpToolName (name) {
  return /^mcp__/.test(String(name || ''))
}

/**
 * 磁盘持久化 OAuth provider（static token + refresh + client info）
 * 对标 SDK OAuthClientProvider；authorization_code 需用户完成浏览器授权后写入 store
 */
function createFileOAuthProvider (projectRoot, serverName, oauthCfg = {}) {
  const { ClientCredentialsProvider } = require('@modelcontextprotocol/sdk/client/auth-extensions.js')

  // 纯机对机：优先 client_credentials
  if (oauthCfg.clientId && oauthCfg.clientSecret && oauthCfg.grantType !== 'authorization_code') {
    return new ClientCredentialsProvider({
      clientId: oauthCfg.clientId,
      clientSecret: oauthCfg.clientSecret,
      clientName: 'AIFront-Panda',
      scope: oauthCfg.scopes || oauthCfg.scope || undefined
    })
  }

  // 文件 / 静态 token provider
  return {
    get redirectUrl () {
      return oauthCfg.redirectUrl || 'http://127.0.0.1:8787/api/panda/mcp/oauth/callback'
    },
    get clientMetadata () {
      return {
        client_name: 'AIFront-Panda',
        redirect_uris: [this.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: oauthCfg.clientSecret ? 'client_secret_basic' : 'none'
      }
    },
    async clientInformation () {
      const store = await loadOAuthStore(projectRoot)
      const slot = store[serverName] || {}
      if (slot.clientInformation) return slot.clientInformation
      if (oauthCfg.clientId) {
        return {
          client_id: oauthCfg.clientId,
          client_secret: oauthCfg.clientSecret
        }
      }
      return undefined
    },
    async saveClientInformation (info) {
      const store = await loadOAuthStore(projectRoot)
      store[serverName] = Object.assign({}, store[serverName], { clientInformation: info })
      await saveOAuthStore(projectRoot, store)
    },
    async tokens () {
      if (oauthCfg.accessToken) {
        return {
          access_token: oauthCfg.accessToken,
          token_type: 'Bearer',
          refresh_token: oauthCfg.refreshToken
        }
      }
      const store = await loadOAuthStore(projectRoot)
      const slot = store[serverName] || {}
      return slot.tokens || undefined
    },
    async saveTokens (tokens) {
      const store = await loadOAuthStore(projectRoot)
      store[serverName] = Object.assign({}, store[serverName], { tokens, updatedAt: new Date().toISOString() })
      await saveOAuthStore(projectRoot, store)
    },
    redirectToAuthorization (url) {
      // 非交互环境：记下待授权 URL，由 /mcp 或事件展示
      const pending = global.__pandaMcpOAuthPending || (global.__pandaMcpOAuthPending = {})
      const u = String(url)
      pending[serverName] = { url: u, at: Date.now() }
      try {
        const parsed = new URL(u)
        const st = parsed.searchParams.get('state')
        if (st) {
          loadOAuthStore(projectRoot).then(store => {
            store[serverName] = Object.assign({}, store[serverName], { oauthState: st })
            return saveOAuthStore(projectRoot, store)
          }).catch(() => {})
        }
      } catch (e) { /* ignore */ }
      console.warn('[mcp-oauth] 需要浏览器授权 ' + serverName + ':\n' + url)
    },
    async saveCodeVerifier (verifier) {
      const store = await loadOAuthStore(projectRoot)
      store[serverName] = Object.assign({}, store[serverName], { codeVerifier: verifier })
      await saveOAuthStore(projectRoot, store)
    },
    async codeVerifier () {
      const store = await loadOAuthStore(projectRoot)
      return (store[serverName] && store[serverName].codeVerifier) || ''
    }
  }
}

class McpSdkSession {
  constructor (name, spec, projectRoot) {
    this.name = name
    this.spec = spec
    this.projectRoot = projectRoot
    this.client = null
    this.transport = null
    this.tools = []
    this.resources = []
    this.ready = false
    this.lastError = null
  }

  async connect () {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const type = String(this.spec.type || (this.spec.command ? 'stdio' : 'http')).toLowerCase()

    this.client = new Client(
      { name: 'AIFront-Panda', version: '1.0.0' },
      { capabilities: {} }
    )

    if (type === 'stdio' || this.spec.command) {
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
      const env = Object.assign({}, process.env, this.spec.env || {})
      // Stdio transport 要求 env 值为 string
      const cleanEnv = {}
      for (const [k, v] of Object.entries(env)) {
        if (v == null) continue
        cleanEnv[k] = String(v)
      }
      this.transport = new StdioClientTransport({
        command: this.spec.command,
        args: Array.isArray(this.spec.args) ? this.spec.args : [],
        env: cleanEnv,
        cwd: this.spec.cwd || this.projectRoot,
        stderr: 'pipe'
      })
    } else if (type === 'sse') {
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')
      const opts = { requestInit: { headers: Object.assign({}, this.spec.headers || {}) } }
      if (this.spec.oauth) {
        opts.authProvider = createFileOAuthProvider(this.projectRoot, this.name, this.spec.oauth)
      }
      this.transport = new SSEClientTransport(new URL(this.spec.url), opts)
    } else {
      // http / streamable
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const opts = { requestInit: { headers: Object.assign({}, this.spec.headers || {}) } }
      if (this.spec.oauth || (this.spec.headers && /Bearer/i.test(JSON.stringify(this.spec.headers)))) {
        if (this.spec.oauth) {
          opts.authProvider = createFileOAuthProvider(this.projectRoot, this.name, this.spec.oauth)
        }
      }
      this.transport = new StreamableHTTPClientTransport(new URL(this.spec.url), opts)
    }

    await this.client.connect(this.transport)
    this.ready = true

    try {
      const toolsRes = await this.client.listTools()
      this.tools = Array.isArray(toolsRes.tools) ? toolsRes.tools : []
    } catch (e) {
      this.tools = []
    }
    try {
      const resRes = await this.client.listResources()
      this.resources = Array.isArray(resRes.resources) ? resRes.resources : []
    } catch (e) {
      this.resources = []
    }

    return {
      tools: this.tools.length,
      resources: this.resources.length,
      toolNames: this.tools.map(t => t.name)
    }
  }

  async callTool (toolName, args) {
    if (!this.client || !this.ready) throw new Error('MCP 未连接：' + this.name)
    const result = await this.client.callTool({
      name: toolName,
      arguments: args || {}
    })
    return result
  }

  async readResource (uri) {
    if (!this.client || !this.ready) throw new Error('MCP 未连接：' + this.name)
    return await this.client.readResource({ uri })
  }

  async stop () {
    try {
      if (this.transport && typeof this.transport.close === 'function') await this.transport.close()
    } catch (e) { /* ignore */ }
    try {
      if (this.client && typeof this.client.close === 'function') await this.client.close()
    } catch (e) { /* ignore */ }
    this.ready = false
    this.client = null
    this.transport = null
  }
}

const sessions = new Map() // projectRoot::name -> McpSdkSession

function sessionKey (projectRoot, name) {
  return projectRoot + '::' + name
}

function resolveServerNameFromNormalized (projectRoot, normalized) {
  // 连接表里用原始 name；工具名用 normalize。反查：
  for (const [key, s] of sessions) {
    if (!key.startsWith(projectRoot + '::')) continue
    if (normalizeNameForMCP(s.name) === normalized) return s.name
  }
  return normalized
}

async function connectServer (projectRoot, name) {
  const cfg = await loadMcpConfig(projectRoot)
  const spec = cfg.servers && cfg.servers[name]
  if (!spec) {
    throw new Error('MCP server 未配置：' + name + '（请编辑 .panda/mcp.json）')
  }
  if (!spec.command && !spec.url) {
    throw new Error('MCP server ' + name + ' 需要 command（stdio）或 url（http/sse）')
  }

  const key = sessionKey(projectRoot, name)
  if (sessions.has(key)) {
    await sessions.get(key).stop()
    sessions.delete(key)
  }

  const session = new McpSdkSession(name, spec, projectRoot)
  try {
    const info = await session.connect()
    sessions.set(key, session)
    return {
      name,
      tools: info.toolNames,
      toolCount: info.tools,
      resources: info.resources,
      registeredAs: session.tools.map(t => buildMcpToolName(name, t.name))
    }
  } catch (e) {
    session.lastError = e.message || String(e)
    await session.stop()
    throw e
  }
}

/**
 * 自动连接 mcp.json 中全部 server（autoConnect !== false）
 */
async function ensureConnected (projectRoot, options = {}) {
  const cfg = await loadMcpConfig(projectRoot)
  if (cfg.autoConnect === false && !options.force) {
    return { connected: await listConnected(projectRoot), skipped: true }
  }
  const names = Object.keys(cfg.servers || {})
  const results = []
  for (const name of names) {
    const key = sessionKey(projectRoot, name)
    const existing = sessions.get(key)
    const spec = (cfg.servers && cfg.servers[name]) || {}
    const isRemote = !!(spec.url || /^(http|sse)/i.test(String(spec.type || '')))
    // 远程 MCP：未 ready 则自动重连；stdio 仅在 force/reconnect 时重建
    if (existing && existing.ready && !options.reconnect) {
      results.push({ name, ok: true, reused: true })
      continue
    }
    if (existing && !existing.ready && isRemote) {
      try {
        const info = await connectServer(projectRoot, name)
        results.push({ name, ok: true, reconnected: true, tools: info.tools, registeredAs: info.registeredAs })
      } catch (e) {
        results.push({ name, ok: false, error: e.message || String(e), reconnectAttempt: true })
      }
      continue
    }
    try {
      const info = await connectServer(projectRoot, name)
      results.push({ name, ok: true, tools: info.tools, registeredAs: info.registeredAs })
    } catch (e) {
      results.push({ name, ok: false, error: e.message || String(e) })
    }
  }
  return { connected: await listConnected(projectRoot), results }
}

async function listConnected (projectRoot) {
  const out = []
  for (const [key, s] of sessions) {
    if (!key.startsWith(projectRoot + '::')) continue
    out.push({
      name: s.name,
      ready: s.ready,
      tools: s.tools.map(t => t.name),
      registeredTools: s.tools.map(t => buildMcpToolName(s.name, t.name)),
      resources: s.resources.map(r => r.uri || r.name),
      lastError: s.lastError || null
    })
  }
  return out
}

async function disconnectServer (projectRoot, name) {
  const key = sessionKey(projectRoot, name)
  const s = sessions.get(key)
  if (s) {
    await s.stop()
    sessions.delete(key)
  }
  return { ok: true }
}

async function callMcpTool (projectRoot, server, tool, args) {
  const key = sessionKey(projectRoot, server)
  let s = sessions.get(key)
  if (!s || !s.ready) {
    await connectServer(projectRoot, server)
    s = sessions.get(key)
  }
  const result = await s.callTool(tool, args)
  if (result && Array.isArray(result.content)) {
    return result.content.map(x => (x.text != null ? x.text : JSON.stringify(x))).join('\n')
  }
  if (result && result.structuredContent) {
    return JSON.stringify(result.structuredContent, null, 2)
  }
  return JSON.stringify(result)
}

async function callByQualifiedName (projectRoot, qualifiedName, args) {
  const parsed = parseMcpToolName(qualifiedName)
  if (!parsed || !parsed.toolName) throw new Error('非法 MCP 工具名：' + qualifiedName)
  const server = resolveServerNameFromNormalized(projectRoot, parsed.serverName)
  // 若 normalize 后对不上，尝试原始名等于 parsed.serverName
  let real = server
  const cfg = await loadMcpConfig(projectRoot)
  for (const n of Object.keys(cfg.servers || {})) {
    if (normalizeNameForMCP(n) === parsed.serverName) {
      real = n
      break
    }
  }
  return callMcpTool(projectRoot, real, parsed.toolName, args)
}

async function listMcpResources (projectRoot, server) {
  const key = sessionKey(projectRoot, server)
  let s = sessions.get(key)
  if (!s || !s.ready) {
    await connectServer(projectRoot, server)
    s = sessions.get(key)
  }
  return s.resources
}

async function readMcpResource (projectRoot, server, uri) {
  const key = sessionKey(projectRoot, server)
  let s = sessions.get(key)
  if (!s || !s.ready) {
    await connectServer(projectRoot, server)
    s = sessions.get(key)
  }
  const result = await s.readResource(uri)
  if (result && Array.isArray(result.contents)) {
    return result.contents.map(x => x.text || JSON.stringify(x)).join('\n')
  }
  return JSON.stringify(result)
}

/**
 * 已连接 server 的工具 → OpenAI function tools（mcp__server__tool）
 */
function getOpenAiToolDefinitions (projectRoot) {
  const defs = []
  for (const [key, s] of sessions) {
    if (!key.startsWith(projectRoot + '::') || !s.ready) continue
    for (const tool of s.tools) {
      const name = buildMcpToolName(s.name, tool.name)
      let parameters = tool.inputSchema || { type: 'object', properties: {} }
      if (!parameters.type) parameters = Object.assign({ type: 'object' }, parameters)
      defs.push({
        type: 'function',
        function: {
          name,
          description: '[MCP:' + s.name + '] ' + (tool.description || tool.name).slice(0, 350),
          parameters
        },
        _mcp: true,
        _mcpServer: s.name,
        _mcpTool: tool.name
      })
    }
  }
  return defs
}

function getPendingOAuth () {
  return global.__pandaMcpOAuthPending || {}
}

async function saveOAuthTokens (projectRoot, serverName, tokens) {
  const store = await loadOAuthStore(projectRoot)
  store[serverName] = Object.assign({}, store[serverName], {
    tokens,
    updatedAt: new Date().toISOString()
  })
  await saveOAuthStore(projectRoot, store)
  return { ok: true }
}

/**
 * authorization_code → token（PKCE lite）
 * state 可为 server 名，或 store 内 pending.state；也可 query.server=
 */
async function exchangeAuthorizationCode (projectRoot, opts) {
  const code = String((opts && opts.code) || '').trim()
  if (!code) return { ok: false, error: 'missing code' }
  const state = String((opts && opts.state) || '').trim()
  const cfg = await loadMcpConfig(projectRoot)
  const store = await loadOAuthStore(projectRoot)
  const pending = getPendingOAuth()

  let serverName = String((opts && opts.server) || '').trim()
  if (!serverName && state) {
    if (cfg.servers && cfg.servers[state]) serverName = state
    else {
      for (const [name, slot] of Object.entries(store)) {
        if (slot && (slot.oauthState === state || slot.state === state)) {
          serverName = name
          break
        }
      }
    }
  }
  if (!serverName) {
    const names = Object.keys(pending || {})
    if (names.length === 1) serverName = names[0]
  }
  if (!serverName || !cfg.servers || !cfg.servers[serverName]) {
    return { ok: false, error: '无法解析 server（传 server= 或 state=服务器名）', servers: Object.keys((cfg && cfg.servers) || {}) }
  }

  const spec = cfg.servers[serverName] || {}
  const oauth = spec.oauth || {}
  const slot = store[serverName] || {}
  const clientInfo = slot.clientInformation || {}
  const clientId = oauth.clientId || clientInfo.client_id || ''
  const clientSecret = oauth.clientSecret || clientInfo.client_secret || ''
  const verifier = slot.codeVerifier || ''
  const tokenUrl = oauth.tokenUrl || oauth.token_endpoint ||
    (oauth.issuer ? String(oauth.issuer).replace(/\/$/, '') + '/token' : '') ||
    ''

  if (!tokenUrl) {
    // 无 tokenUrl：先把 code 落盘，便于手工 POST /token
    store[serverName] = Object.assign({}, slot, {
      authorizationCode: code,
      oauthState: state || slot.oauthState,
      updatedAt: new Date().toISOString()
    })
    await saveOAuthStore(projectRoot, store)
    return {
      ok: false,
      pendingCode: true,
      server: serverName,
      error: 'mcp.json 未配置 oauth.tokenUrl；code 已写入 mcp-oauth.json，可用 POST /api/panda/mcp/oauth/token'
    }
  }

  const body = new URLSearchParams()
  body.set('grant_type', 'authorization_code')
  body.set('code', code)
  body.set('redirect_uri', oauth.redirectUrl || 'http://127.0.0.1:8787/api/panda/mcp/oauth/callback')
  if (clientId) body.set('client_id', clientId)
  if (verifier) body.set('code_verifier', verifier)

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (clientSecret && clientId) {
    headers.Authorization = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
  }

  let res
  try {
    res = await fetch(tokenUrl, { method: 'POST', headers, body: body.toString() })
  } catch (e) {
    return { ok: false, error: 'token 请求失败：' + (e.message || e), server: serverName }
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* ignore */ }
  if (!res.ok || !json || !json.access_token) {
    store[serverName] = Object.assign({}, slot, {
      authorizationCode: code,
      lastTokenError: text.slice(0, 2000),
      updatedAt: new Date().toISOString()
    })
    await saveOAuthStore(projectRoot, store)
    return { ok: false, error: 'token 交换失败 HTTP ' + res.status, body: text.slice(0, 800), server: serverName }
  }

  await saveOAuthTokens(projectRoot, serverName, {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type || 'Bearer',
    expires_in: json.expires_in,
    scope: json.scope
  })
  if (pending && pending[serverName]) delete pending[serverName]

  let connected = null
  try {
    connected = await connectServer(projectRoot, serverName)
  } catch (e) {
    return { ok: true, saved: true, server: serverName, connectError: e.message }
  }
  return { ok: true, saved: true, server: serverName, connected }
}

module.exports = {
  loadMcpConfig,
  saveMcpConfig,
  connectServer,
  disconnectServer,
  ensureConnected,
  listConnected,
  callMcpTool,
  callByQualifiedName,
  listMcpResources,
  readMcpResource,
  getOpenAiToolDefinitions,
  buildMcpToolName,
  parseMcpToolName,
  isMcpToolName,
  normalizeNameForMCP,
  getPendingOAuth,
  saveOAuthTokens,
  exchangeAuthorizationCode,
  loadOAuthStore
}
