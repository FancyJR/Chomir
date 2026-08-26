/**
 * 会话级 Abort（对标 panda-code interrupt）
 * abort 后保留 aborted 状态直到 endRun，避免 isAborted 误报 false。
 * 支持 pendingAbort：停止按钮早于 beginRun 时也能生效。
 */

const controllers = new Map()
const pendingAborts = new Set()

function beginRun (sessionId) {
  if (!sessionId) return new AbortController()
  const prev = controllers.get(sessionId)
  if (prev) {
    try { prev.abort() } catch (e) { /* ignore */ }
  }
  const c = new AbortController()
  controllers.set(sessionId, c)
  if (pendingAborts.has(sessionId)) {
    pendingAborts.delete(sessionId)
    try { c.abort() } catch (e) { /* ignore */ }
  }
  return c
}

function abortRun (sessionId) {
  if (!sessionId) return false
  const c = controllers.get(sessionId)
  if (!c) {
    pendingAborts.add(sessionId)
    return true
  }
  if (c.signal.aborted) return true
  try { c.abort() } catch (e) { /* ignore */ }
  // 不 delete：保留 signal.aborted，供 isAborted / 循环检查
  return true
}

function endRun (sessionId) {
  if (!sessionId) return
  controllers.delete(sessionId)
  pendingAborts.delete(sessionId)
}

function getSignal (sessionId) {
  const c = controllers.get(sessionId)
  return c ? c.signal : null
}

function isAborted (sessionId) {
  if (!sessionId) return false
  if (pendingAborts.has(sessionId)) return true
  const c = controllers.get(sessionId)
  return !!(c && c.signal.aborted)
}

function isAbortError (err) {
  if (!err) return false
  if (err.code === 'ABORTED') return true
  if (err.name === 'AbortError') return true
  const msg = String(err.message || '')
  return msg === '已取消' || /aborted|AbortError|The operation was aborted/i.test(msg)
}

function hasActiveRuns () {
  return controllers.size > 0
}

module.exports = {
  beginRun,
  abortRun,
  endRun,
  getSignal,
  isAborted,
  isAbortError,
  hasActiveRuns
}
