/**
 * 浏览器控制台 / 运行时错误采集
 * 供 Panda 排查页面报错时自动读取
 */

const MAX_ENTRIES = 120
const DEDUPE_MS = 2500
const FLUSH_MS = 800
const POST_URL = '/api/panda/console'

/** @type {Array<object>} */
const ring = []
/** @type {Map<string, number>} */
const recentKeys = new Map()

let installed = false
let flushTimer = null
let pendingPush = []
let sessionIdHint = ''

function nowIso () {
  return new Date().toISOString()
}

function makeKey (entry) {
  return [entry.level, entry.source, String(entry.message || '').slice(0, 240), String(entry.stack || '').slice(0, 120)].join('|')
}

function pushEntry (raw) {
  if (!raw || !raw.message) return null
  const entry = {
    id: 'ce_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 8),
    ts: Date.now(),
    at: nowIso(),
    level: raw.level || 'error',
    source: raw.source || 'console',
    message: String(raw.message).slice(0, 4000),
    stack: raw.stack ? String(raw.stack).slice(0, 8000) : '',
    url: raw.url ? String(raw.url).slice(0, 500) : (typeof location !== 'undefined' ? location.href : ''),
    line: raw.line != null ? raw.line : null,
    column: raw.column != null ? raw.column : null,
    route: raw.route || ''
  }

  // 过滤构建/热更新噪音
  const msg = entry.message
  if (/\[HMR\]|hot-update|webpackHotUpdate|Download the Vue Devtools/i.test(msg)) return null

  const key = makeKey(entry)
  const last = recentKeys.get(key) || 0
  if (Date.now() - last < DEDUPE_MS) return null
  recentKeys.set(key, Date.now())
  if (recentKeys.size > 400) {
    const cutoff = Date.now() - 60000
    for (const [k, t] of recentKeys) {
      if (t < cutoff) recentKeys.delete(k)
    }
  }

  try {
    if (typeof window !== 'undefined' && window.__VUE_ROUTER_ROUTE__) {
      entry.route = String(window.__VUE_ROUTER_ROUTE__)
    } else if (typeof location !== 'undefined') {
      entry.route = location.hash || location.pathname || ''
    }
  } catch (e) { /* ignore */ }

  ring.push(entry)
  if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES)
  pendingPush.push(entry)
  scheduleFlush()
  return entry
}

function scheduleFlush () {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushToServer(sessionIdHint).catch(() => {})
  }, FLUSH_MS)
}

function serializeArg (a) {
  if (a == null) return String(a)
  if (a instanceof Error) {
    return a.stack || (a.name + ': ' + a.message)
  }
  if (typeof a === 'string') return a
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a)
    } catch (e) {
      return Object.prototype.toString.call(a)
    }
  }
  return String(a)
}

function wrapConsole (level) {
  const orig = console[level]
  if (typeof orig !== 'function') return
  console[level] = function (...args) {
    try {
      const message = args.map(serializeArg).join(' ')
      const err = args.find(a => a instanceof Error)
      pushEntry({
        level,
        source: 'console.' + level,
        message,
        stack: err && err.stack ? err.stack : ''
      })
    } catch (e) { /* ignore */ }
    return orig.apply(console, args)
  }
}

/**
 * @param {import('vue').default} [Vue]
 */
export function installConsoleCapture (Vue) {
  if (installed || typeof window === 'undefined') return
  installed = true

  wrapConsole('error')
  wrapConsole('warn')

  window.addEventListener('error', (event) => {
    try {
      if (event.error) {
        pushEntry({
          level: 'error',
          source: 'window.onerror',
          message: event.error.message || event.message || 'Error',
          stack: event.error.stack || '',
          url: event.filename || '',
          line: event.lineno,
          column: event.colno
        })
        return
      }
      // 资源加载失败
      const t = event.target
      if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG')) {
        pushEntry({
          level: 'error',
          source: 'resource',
          message: 'Failed to load ' + t.tagName.toLowerCase() + ': ' + (t.src || t.href || ''),
          url: t.src || t.href || ''
        })
      } else if (event.message) {
        pushEntry({
          level: 'error',
          source: 'window.onerror',
          message: event.message,
          url: event.filename || '',
          line: event.lineno,
          column: event.colno
        })
      }
    } catch (e) { /* ignore */ }
  }, true)

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason
      pushEntry({
        level: 'error',
        source: 'unhandledrejection',
        message: reason instanceof Error
          ? (reason.name + ': ' + reason.message)
          : serializeArg(reason),
        stack: reason instanceof Error ? (reason.stack || '') : ''
      })
    } catch (e) { /* ignore */ }
  })

  if (Vue && Vue.config) {
    const prevErr = Vue.config.errorHandler
    Vue.config.errorHandler = function (err, vm, info) {
      try {
        pushEntry({
          level: 'error',
          source: 'vue.errorHandler',
          message: (err && err.message) ? err.message : String(err),
          stack: (err && err.stack) ? err.stack : '',
          route: info ? ('vue:' + info) : ''
        })
      } catch (e) { /* ignore */ }
      if (typeof prevErr === 'function') return prevErr.apply(this, arguments)
      if (typeof console !== 'undefined' && console.error) console.error(err)
    }
  }

  window.__CLAW_CONSOLE__ = {
    getRecent: getRecentErrors,
    clear: clearLocal,
    flush: flushToServer,
    setSession: setCaptureSessionId
  }
}

export function setCaptureSessionId (id) {
  sessionIdHint = id ? String(id) : ''
}

export function getRecentErrors (limit = 40, options = {}) {
  const level = options.level || 'all'
  let list = ring.slice()
  if (level === 'error') list = list.filter(e => e.level === 'error')
  else if (level === 'warn') list = list.filter(e => e.level === 'warn' || e.level === 'error')
  if (options.since) list = list.filter(e => e.ts >= options.since)
  return list.slice(-Math.max(1, Math.min(200, limit)))
}

export function clearLocal () {
  ring.length = 0
  pendingPush = []
}

export function formatErrorsForAgent (entries) {
  const list = entries || getRecentErrors(30, { level: 'error' })
  if (!list.length) return ''
  const lines = ['【浏览器控制台最近错误（自动采集）】']
  list.forEach((e, i) => {
    lines.push(
      (i + 1) + '. [' + e.level + '/' + e.source + '] ' + e.at +
      (e.route ? ' @' + e.route : '')
    )
    lines.push('   ' + e.message)
    if (e.url && e.line != null) lines.push('   at ' + e.url + ':' + e.line + (e.column != null ? ':' + e.column : ''))
    if (e.stack) {
      const stackLines = String(e.stack).split('\n').slice(0, 8).join('\n   ')
      lines.push('   ' + stackLines)
    }
  })
  lines.push('请根据以上堆栈定位源码并修复；需要时可再调 browser_console 工具拉完整日志。')
  return lines.join('\n')
}

export async function flushToServer (sessionId) {
  const batch = pendingPush.splice(0, pendingPush.length)
  if (!batch.length) return { ok: true, sent: 0 }
  const sid = sessionId || sessionIdHint || ''
  try {
    const res = await fetch(POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, entries: batch }),
      keepalive: true
    })
    return { ok: res.ok, sent: batch.length }
  } catch (e) {
    // 上报失败时塞回队列（防丢），但限制长度
    pendingPush = batch.concat(pendingPush).slice(-MAX_ENTRIES)
    return { ok: false, sent: 0 }
  }
}
