/**
 * 交互式权限请求（对标 panda-code permissions UI）
 * 默认快速路径：autoApprove 时绝不 await，避免 Edit「卡死」观感。
 * pending 带 sessionId + payload，供 mid-run reconnect 恢复弹窗。
 */

const pending = new Map()

function createPermissionGate (sendEvent, options = {}) {
  const autoApprove = !!options.autoApprove
  const signal = options.signal || null
  // 对齐 Ink：等人点选，不因 20s 静默拒绝；仅 abort / 显式超时（PANDA_PERM_TIMEOUT_MS）才结束
  const envTo = Number(process.env.PANDA_PERM_TIMEOUT_MS || process.env.CLAW_PERM_TIMEOUT_MS || 0)
  const timeoutMs = options.timeoutMs != null
    ? options.timeoutMs
    : (envTo > 0 ? envTo : 0)
  return async function requirePermission (req) {
    if (autoApprove && !req.forceAsk) return true
    if (req.risk === 'read' && !req.forceAsk) return true
    if (signal && signal.aborted) return false

    const id = 'perm_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 6)
    const sessionId = options.sessionId || (req && req.sessionId) || ''
    const payload = {
      id,
      tool: req.tool,
      detail: req.detail,
      risk: req.risk || 'write',
      diff: req.diff || '',
      preview: req.preview || '',
      forceAsk: !!req.forceAsk,
      reason: req.reason || '',
      suggestions: Array.isArray(req.suggestions) ? req.suggestions : [],
      sessionId
    }
    sendEvent('panda_permission', payload)
    sendEvent('panda_status', {
      message: '等待你点「允许」：' + (req.tool || '') + (req.detail ? ' · ' + req.detail : '') + '（或勾选自动批准）',
      phase: 'permission'
    })

    return await new Promise((resolve) => {
      let settled = false
      let beat = 0
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(hb)
        if (signal) signal.removeEventListener('abort', onAbort)
        pending.delete(id)
        try {
          const runHub = require('./runHub')
          runHub.clearPendingPermission(sessionId, id)
          if (sessionId) {
            runHub.emit(sessionId, 'panda_permission_resolved', { id, allow: !!ok, sessionId })
          }
        } catch (e) { /* ignore */ }
        resolve(!!ok)
      }
      const onAbort = () => finish(false)
      const timer = timeoutMs > 0
        ? setTimeout(() => finish(false), timeoutMs)
        : null
      const hb = setInterval(() => {
        beat += 2
        sendEvent('panda_status', {
          message: '仍在等待权限… ' + beat + 's · 请点「允许」或 Esc 拒绝' +
            (timeoutMs > 0 ? '（' + Math.max(0, Math.ceil((timeoutMs / 1000) - beat)) + 's 后超时）' : ''),
          phase: 'permission_wait',
          elapsed: beat
        })
      }, 2000)
      pending.set(id, { resolve: finish, req: req || {}, sessionId, payload })
      if (signal) {
        if (signal.aborted) {
          finish(false)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

/**
 * @param {string} id
 * @param {boolean} allow
 * @param {{
 *   sessionId?: string,
 *   permissionMode?: string,
 *   sessionAllow?: boolean,
 *   sessionDeny?: boolean,
 *   persistDeny?: boolean,
 *   persistAllow?: boolean,
 *   allowRule?: { toolName?: string, ruleContent?: string, prefix?: boolean },
 *   projectRoot?: string
 * }} [extras]
 */
function resolvePermission (id, allow, extras) {
  const p = pending.get(id)
  if (!p) return false

  const ex = extras || {}
  const sessionId = ex.sessionId || p.sessionId || ''
  const req = p.req || {}

  try {
    if (sessionId && (ex.permissionMode || ex.sessionAllow || ex.sessionDeny)) {
      const sessionRuntime = require('./sessionRuntime')
      const patch = {}
      if (ex.permissionMode) patch.permissionMode = ex.permissionMode
      if (ex.sessionAllow && allow) {
        const tool = String(req.tool || 'edit_file')
        if (req.risk === 'bash' || tool === 'bash' || tool === 'bash_bg') {
          patch.appendSessionAllow = { toolName: 'bash', ruleContent: null, prefix: false }
        } else {
          ;['edit_file', 'write_file', 'apply_patch', 'edit_lines', 'notebook_edit'].forEach(t => {
            sessionRuntime.applyPatch(sessionId, {
              appendSessionAllow: { toolName: t, ruleContent: null, prefix: false }
            })
          })
        }
      }
      if (ex.sessionDeny && !allow) {
        const tool = String(req.tool || '')
        const detail = String(req.detail || '').slice(0, 120)
        patch.appendSessionDeny = {
          toolName: tool,
          ruleContent: detail || null,
          prefix: !detail
        }
      }
      if (Object.keys(patch).length) sessionRuntime.applyPatch(sessionId, patch)
    }

    if (ex.persistDeny && !allow && ex.projectRoot) {
      const permissionRules = require('./permissionRules')
      const tool = String(req.tool || '')
      const detail = String(req.detail || '').slice(0, 120)
      void permissionRules.appendPersistentRule(ex.projectRoot, 'deny', tool, detail)
    }

    if (ex.persistAllow && allow && ex.projectRoot) {
      const permissionRules = require('./permissionRules')
      const rule = ex.allowRule || {}
      const tool = rule.toolName || String(req.tool || '')
      const detail = rule.ruleContent != null
        ? String(rule.ruleContent)
        : String(req.detail || '').slice(0, 160)
      void permissionRules.appendPersistentRule(
        ex.projectRoot,
        'allow',
        tool,
        detail,
        { prefix: !!rule.prefix }
      )
    }
  } catch (e) {
    console.warn('[panda] resolvePermission side-effects:', e.message || e)
  }

  pending.delete(id)
  try {
    const runHub = require('./runHub')
    runHub.clearPendingPermission(sessionId, id)
  } catch (e) { /* ignore */ }
  p.resolve(!!allow)
  return true
}

function listPending (sessionId) {
  const sid = String(sessionId || '').trim()
  const out = []
  for (const [id, p] of pending) {
    if (sid && p.sessionId && p.sessionId !== sid) continue
    out.push(p.payload || { id, tool: (p.req && p.req.tool) || '', sessionId: p.sessionId })
  }
  return out
}

module.exports = {
  createPermissionGate,
  resolvePermission,
  listPending
}
