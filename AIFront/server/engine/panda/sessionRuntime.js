/**
 * 活跃会话 runtime 注册表：支持运行中 Shift+Tab / Yes-all / deny 回写闸门
 *（对齐 panda-code 对 live toolPermissionContext 的更新）
 */

const active = new Map()

function register (sessionId, runtime) {
  const id = String(sessionId || '').trim()
  if (!id || !runtime) return
  active.set(id, runtime)
}

function unregister (sessionId) {
  const id = String(sessionId || '').trim()
  if (id) active.delete(id)
}

function get (sessionId) {
  return active.get(String(sessionId || '').trim()) || null
}

/**
 * @param {string} sessionId
 * @param {{
 *   permissionMode?: string,
 *   agentMode?: string,
 *   sessionAllow?: Array,
 *   sessionDeny?: Array,
 *   appendSessionAllow?: object|string,
 *   appendSessionDeny?: object|string
 * }} patch
 */
function applyPatch (sessionId, patch) {
  const runtime = get(sessionId)
  if (!runtime || !patch) return { ok: false, reason: 'no_active_runtime' }

  if (patch.permissionMode) {
    const m = String(patch.permissionMode).trim()
    runtime.permissionMode = m
    if (m === 'plan') {
      runtime.mode = 'plan'
    } else if (runtime.mode === 'plan' && m !== 'plan') {
      runtime.mode = 'default'
    }
  }
  if (patch.agentMode != null) {
    runtime.mode = patch.agentMode === 'plan' ? 'plan' : 'default'
  }
  if (Array.isArray(patch.sessionAllow)) {
    runtime.sessionAllowRules = patch.sessionAllow.slice()
  }
  if (Array.isArray(patch.sessionDeny)) {
    runtime.sessionDenyRules = patch.sessionDeny.slice()
  }
  if (patch.appendSessionAllow) {
    if (!Array.isArray(runtime.sessionAllowRules)) runtime.sessionAllowRules = []
    runtime.sessionAllowRules.push(patch.appendSessionAllow)
  }
  if (patch.appendSessionDeny) {
    if (!Array.isArray(runtime.sessionDenyRules)) runtime.sessionDenyRules = []
    runtime.sessionDenyRules.push(patch.appendSessionDeny)
  }
  if (patch._sessionStartHooksDone) {
    runtime._sessionStartHooksDone = true
  }

  if (runtime.sendEvent) {
    runtime.sendEvent('panda_mode', {
      mode: runtime.mode,
      permissionMode: runtime.permissionMode,
      live: true
    })
  }

  return {
    ok: true,
    permissionMode: runtime.permissionMode,
    mode: runtime.mode,
    sessionAllow: (runtime.sessionAllowRules || []).length,
    sessionDeny: (runtime.sessionDenyRules || []).length
  }
}

/**
 * 运行中插话（steer）：下一轮 round 开头注入，避免整轮重开（省时间/token）
 */
function pushSteer (sessionId, text, extras) {
  const runtime = get(sessionId)
  if (!runtime) return { ok: false, reason: 'no_active_runtime' }
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: 'empty' }
  if (!Array.isArray(runtime.steerQueue)) runtime.steerQueue = []
  runtime.steerQueue.push({
    text: t.slice(0, 8000),
    images: (extras && extras.images) || [],
    at: Date.now()
  })
  if (runtime.sendEvent) {
    runtime.sendEvent('panda_status', {
      message: '已接收插话 · 下一轮注入（#' + runtime.steerQueue.length + '）',
      phase: 'steer'
    })
    runtime.sendEvent('panda_block', {
      type: 'system',
      content: '⇄ Steer queued：' + t.slice(0, 120)
    })
  }
  return { ok: true, queued: runtime.steerQueue.length }
}

function drainSteer (sessionId) {
  const runtime = get(sessionId)
  if (!runtime || !Array.isArray(runtime.steerQueue) || !runtime.steerQueue.length) return []
  return runtime.steerQueue.splice(0, runtime.steerQueue.length)
}

module.exports = {
  register,
  unregister,
  get,
  applyPatch,
  pushSteer,
  drainSteer
}
