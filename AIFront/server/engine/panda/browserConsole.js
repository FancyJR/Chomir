/**
 * 浏览器控制台错误环缓冲（前端上报，Agent 用 browser_console 读取）
 */

const MAX_GLOBAL = 300
const MAX_SESSION = 150

/** @type {Array<object>} */
const globalRing = []
/** @type {Map<string, Array<object>>} */
const bySession = new Map()

function normalizeEntry (raw) {
  if (!raw || typeof raw !== 'object') return null
  const message = String(raw.message || '').trim()
  if (!message) return null
  return {
    id: raw.id || ('ce_' + Date.now().toString(16)),
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
    at: raw.at || new Date().toISOString(),
    level: raw.level === 'warn' ? 'warn' : 'error',
    source: String(raw.source || 'browser').slice(0, 80),
    message: message.slice(0, 4000),
    stack: String(raw.stack || '').slice(0, 8000),
    url: String(raw.url || '').slice(0, 500),
    line: raw.line != null ? raw.line : null,
    column: raw.column != null ? raw.column : null,
    route: String(raw.route || '').slice(0, 200),
    sessionId: raw.sessionId ? String(raw.sessionId) : ''
  }
}

function pushToRing (ring, entry, max) {
  ring.push(entry)
  if (ring.length > max) ring.splice(0, ring.length - max)
}

function ingest (entries, sessionId) {
  const list = Array.isArray(entries) ? entries : [entries]
  let n = 0
  for (const raw of list) {
    const entry = normalizeEntry(raw)
    if (!entry) continue
    if (sessionId) entry.sessionId = String(sessionId)
    pushToRing(globalRing, entry, MAX_GLOBAL)
    if (entry.sessionId) {
      if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, [])
      pushToRing(bySession.get(entry.sessionId), entry, MAX_SESSION)
    }
    n++
  }
  return n
}

function filterList (list, options = {}) {
  let out = list.slice()
  const level = options.level || 'all'
  if (level === 'error') out = out.filter(e => e.level === 'error')
  else if (level === 'warn') out = out.filter(e => e.level === 'warn' || e.level === 'error')
  if (options.since) out = out.filter(e => e.ts >= options.since)
  if (options.query) {
    const q = String(options.query).toLowerCase()
    out = out.filter(e =>
      (e.message && e.message.toLowerCase().includes(q)) ||
      (e.stack && e.stack.toLowerCase().includes(q)) ||
      (e.url && e.url.toLowerCase().includes(q)) ||
      (e.route && e.route.toLowerCase().includes(q))
    )
  }
  const limit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 40))
  return out.slice(-limit)
}

function list (options = {}) {
  const sessionId = options.sessionId ? String(options.sessionId) : ''
  let base = globalRing
  if (sessionId && bySession.has(sessionId)) {
    // 会话优先，再并入全局里同会话没有的近期错误
    const sess = bySession.get(sessionId) || []
    const ids = new Set(sess.map(e => e.id))
    const extra = globalRing.filter(e => !ids.has(e.id)).slice(-60)
    base = sess.concat(extra).sort((a, b) => a.ts - b.ts)
  }
  return filterList(base, options)
}

function clear (sessionId) {
  if (sessionId) {
    bySession.delete(String(sessionId))
    const sid = String(sessionId)
    for (let i = globalRing.length - 1; i >= 0; i--) {
      if (globalRing[i].sessionId === sid) globalRing.splice(i, 1)
    }
    return { ok: true, scope: 'session' }
  }
  globalRing.length = 0
  bySession.clear()
  return { ok: true, scope: 'all' }
}

function formatForAgent (entries) {
  const list = entries || []
  if (!list.length) {
    return '（暂无浏览器控制台错误。请先在页面复现报错，或确认前端已加载 consoleCapture。）'
  }
  const lines = ['浏览器控制台最近 ' + list.length + ' 条：']
  list.forEach((e, i) => {
    lines.push(
      (i + 1) + '. [' + e.level + '/' + e.source + '] ' + (e.at || '') +
      (e.route ? ' route=' + e.route : '')
    )
    lines.push('   ' + e.message)
    if (e.url) {
      lines.push('   url=' + e.url + (e.line != null ? (':' + e.line + (e.column != null ? ':' + e.column : '')) : ''))
    }
    if (e.stack) {
      lines.push('   stack:\n   ' + String(e.stack).split('\n').slice(0, 10).join('\n   '))
    }
  })
  return lines.join('\n')
}

function stats () {
  return {
    global: globalRing.length,
    sessions: [...bySession.entries()].map(([id, arr]) => ({ sessionId: id, count: arr.length }))
  }
}

module.exports = {
  ingest,
  list,
  clear,
  formatForAgent,
  stats
}
