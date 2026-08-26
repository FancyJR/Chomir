/**
 * Hooks（对标 panda-code utils/hooks）
 *
 * .panda/hooks.json 支持两种写法：
 *
 * 1) 简易（兼容旧版）：
 * {
 *   "PreToolUse": [{ "matcher": "bash|write_file", "message": "...", "deny": false }],
 *   "PostToolUse": [{ "matcher": "edit_file", "message": "..." }],
 *   "Stop": [{ "blockIfNoVerify": true }]
 * }
 *
 * 2) Shell command（对齐 Claude Code）：
 * {
 *   "PreToolUse": [{
 *     "matcher": "Bash|bash",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "python3 .panda/hooks/check_bash.py",
 *       "timeout": 30
 *     }]
 *   }]
 * }
 * 或扁平：{ "matcher": "bash", "type": "command", "command": "…" }
 *
 * Shell 协议：
 * - stdin：JSON 事件载荷（tool_name / tool_input / cwd 等）
 * - exit 0：成功；stdout 可注入模型（Post/Stop）或仅记笔记（Pre）
 * - exit 2：阻塞 — Pre 拒工具 / Stop 强制续跑；stderr 给模型
 * - 其他 exit：stderr 记用户侧笔记，不阻塞
 * - stdout 若为 JSON 且 decision:"block" / permissionDecision:"deny" → 同 exit 2
 *
 * 环境变量：CLAUDE_PROJECT_DIR、PANDA_PROJECT_DIR、PANDA_HOOK_EVENT
 */

const fsp = require('fs').promises
const path = require('path')
const { spawn } = require('child_process')

async function loadHooks (projectRoot) {
  try {
    return JSON.parse(await fsp.readFile(path.resolve(projectRoot, '.panda', 'hooks.json'), 'utf8'))
  } catch (e) {
    return {}
  }
}

function matchTool (matcher, toolName) {
  if (!matcher || matcher === '*') return true
  const name = String(toolName || '')
  // Claude 工具名大小写不敏感；也匹配 mcp__* 前缀场景
  try {
    return new RegExp('^(' + matcher + ')$', 'i').test(name)
  } catch (e) {
    return matcher.split('|').map(s => s.trim().toLowerCase()).includes(name.toLowerCase())
  }
}

/**
 * 展开 Claude 嵌套 hooks[] 与扁平条目为统一列表
 * @returns {Array<{ matcher?: string, type: string, command?: string, message?: string, timeout?: number, deny?: boolean, block?: boolean, ... }>}
 */
function expandHookEntries (list) {
  const out = []
  for (const entry of (Array.isArray(list) ? list : [])) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.hooks) && entry.hooks.length) {
      for (const h of entry.hooks) {
        out.push(Object.assign({}, entry, h, { hooks: undefined }))
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

function parseHookStdout (stdout) {
  const text = String(stdout || '').trim()
  if (!text) return { json: null, plainText: '' }
  // 尝试整段 JSON，或最后一行 JSON
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch (e) {
      return null
    }
  }
  let json = tryParse(text)
  if (!json) {
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
    if (lines.length) json = tryParse(lines[lines.length - 1])
  }
  return { json, plainText: text }
}

function decisionBlocks (json) {
  if (!json || typeof json !== 'object') return { block: false, reason: '' }
  if (json.decision === 'block' || json.continue === false || json.preventContinuation === true) {
    return { block: true, reason: json.reason || json.message || 'hook decision: block' }
  }
  const specific = json.hookSpecificOutput || {}
  const perm = specific.permissionDecision || json.permissionDecision
  if (perm === 'deny' || perm === 'block') {
    return {
      block: true,
      reason: specific.permissionDecisionReason || json.reason || json.message || 'hook permissionDecision: deny'
    }
  }
  return { block: false, reason: '' }
}

/**
 * 执行 type=command 的 shell hook
 * @returns {Promise<{ status: number, stdout: string, stderr: string, aborted?: boolean }>}
 */
function execCommandHook (hook, jsonInput, projectRoot, signal) {
  const command = String(hook.command || '').trim()
  if (!command) {
    return Promise.resolve({ status: 1, stdout: '', stderr: 'empty hook command' })
  }

  const timeoutMs = Math.max(
    1000,
    (Number(hook.timeout) > 0 ? Number(hook.timeout) : 30) * 1000
  )
  const shell = hook.shell || process.env.PANDA_HOOK_SHELL || process.env.SHELL || '/bin/bash'
  const useShell = shell === 'bash' || shell.endsWith('/bash') || shell === 'sh' || shell.endsWith('/sh') ||
    shell === 'zsh' || shell.endsWith('/zsh')

  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(r)
    }

    const env = Object.assign({}, process.env, {
      CLAUDE_PROJECT_DIR: projectRoot,
      PANDA_PROJECT_DIR: projectRoot,
      PANDA_HOOK_EVENT: String(hook._event || ''),
      PWD: projectRoot
    })

    let child
    try {
      if (useShell) {
        child = spawn(shell, ['-lc', command], {
          cwd: projectRoot,
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } else {
        child = spawn(command, {
          cwd: projectRoot,
          env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      }
    } catch (e) {
      finish({ status: 1, stdout: '', stderr: e.message || String(e) })
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch (e) { /* ignore */ }
      finish({ status: 124, stdout, stderr: stderr + '\n[hook timeout ' + timeoutMs + 'ms]', aborted: true })
    }, timeoutMs)

    const onAbort = () => {
      try { child.kill('SIGTERM') } catch (e) { /* ignore */ }
      finish({ status: 130, stdout, stderr: stderr + '\n[aborted]', aborted: true })
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => {
      finish({ status: 1, stdout, stderr: stderr + '\n' + (e.message || e) })
    })
    child.on('close', (code) => {
      finish({ status: code == null ? 1 : code, stdout, stderr })
    })

    try {
      child.stdin.write(typeof jsonInput === 'string' ? jsonInput : JSON.stringify(jsonInput))
      child.stdin.end()
    } catch (e) {
      try { child.kill('SIGTERM') } catch (e2) { /* ignore */ }
      finish({ status: 1, stdout, stderr: 'failed to write hook stdin: ' + (e.message || e) })
    }
  })
}

async function applyCommandHook (hook, payload, projectRoot, runtime) {
  const signal = runtime && runtime.signal
  const result = await execCommandHook(
    Object.assign({}, hook, { _event: payload.hook_event_name }),
    JSON.stringify(payload),
    projectRoot,
    signal
  )
  const { json, plainText } = parseHookStdout(result.stdout)
  const fromJson = decisionBlocks(json)
  const blocked = result.status === 2 || fromJson.block
  const reason = fromJson.reason ||
    (result.stderr && String(result.stderr).trim()) ||
    (plainText && blocked ? plainText : '') ||
    ('hook exit ' + result.status)

  return {
    blocked,
    reason: blocked ? reason : '',
    note: !blocked && (plainText || (result.stderr && result.status !== 0 ? result.stderr.trim() : ''))
      ? String(plainText || result.stderr).trim().slice(0, 2000)
      : '',
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json
  }
}

async function runPreToolHooks (projectRoot, toolName, args, runtime) {
  const hooks = await loadHooks(projectRoot)
  const list = expandHookEntries(hooks.PreToolUse)
  const notes = []
  let deny = false
  let denyMessage = ''

  for (const h of list) {
    if (!matchTool(h.matcher, toolName)) continue

    const isCmd = h.type === 'command' || (!!h.command && h.type !== 'prompt' && h.type !== 'message')
    if (isCmd && h.command) {
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: args || {},
        cwd: projectRoot,
        session_id: (runtime && runtime.sessionId) || null
      }
      try {
        const r = await applyCommandHook(h, payload, projectRoot, runtime)
        if (r.note) notes.push('Hook(cmd): ' + r.note.slice(0, 400))
        if (r.blocked) {
          deny = true
          denyMessage = r.reason || ('Hook 拒绝了工具：' + toolName)
        }
      } catch (e) {
        notes.push('Hook 执行失败（不阻塞）：' + (e.message || e))
      }
      continue
    }

    // 简易 message / deny
    if (h.message) notes.push(h.message)
    else notes.push('PreToolUse: ' + toolName)
    if (h.deny === true || h.block === true) {
      deny = true
      denyMessage = h.message || ('Hook 拒绝了工具：' + toolName)
    }
  }

  return { notes, deny, denyMessage }
}

async function runPostToolHooks (projectRoot, toolName, result, runtime) {
  const hooks = await loadHooks(projectRoot)
  const list = expandHookEntries(hooks.PostToolUse)
  const notes = []

  for (const h of list) {
    if (!matchTool(h.matcher, toolName)) continue

    const isCmd = h.type === 'command' || (!!h.command && h.type !== 'prompt' && h.type !== 'message')
    if (isCmd && h.command) {
      const payload = {
        hook_event_name: 'PostToolUse',
        tool_name: toolName,
        tool_input: (runtime && runtime._lastToolArgs) || {},
        tool_response: {
          ok: !!(result && result.ok),
          content: String((result && result.content) || '').slice(0, 8000)
        },
        cwd: projectRoot,
        session_id: (runtime && runtime.sessionId) || null
      }
      try {
        const r = await applyCommandHook(h, payload, projectRoot, runtime)
        if (r.blocked) {
          // PostToolUse exit 2：立刻告知模型（对齐 show stderr to model）
          notes.push('PostToolUse hook block：' + (r.reason || r.stderr || '').slice(0, 800))
        } else if (r.note) {
          notes.push('Hook(cmd): ' + r.note.slice(0, 400))
        }
      } catch (e) {
        notes.push('PostToolUse hook 失败：' + (e.message || e))
      }
      continue
    }

    notes.push(h.message || ('PostToolUse: ' + toolName))
  }
  return notes
}

/**
 * 助手无工具收工时调用（对标 executeStopHooks）
 * @returns {{ preventContinuation: boolean, blockingErrors: string[], notes: string[] }}
 */
async function runStopHooks (projectRoot, runtime, assistantText) {
  const hooks = await loadHooks(projectRoot)
  const list = expandHookEntries(hooks.Stop)
  const notes = []
  const blockingErrors = []
  let preventContinuation = false

  const changed = (runtime && runtime.changedFiles) || []
  const didVerify = !!(runtime && runtime.didVerify)
  const pendingTodos = Array.isArray(runtime && runtime.todos)
    ? runtime.todos.filter(t => t && t.status !== 'completed' && t.status !== 'cancelled')
    : []

  for (const h of list) {
    const isCmd = h.type === 'command' || (!!h.command && h.type !== 'prompt' && h.type !== 'message')
    if (isCmd && h.command) {
      const payload = {
        hook_event_name: 'Stop',
        stop_hook_active: true,
        cwd: projectRoot,
        session_id: (runtime && runtime.sessionId) || null,
        last_assistant_message: String(assistantText || '').slice(0, 4000),
        changed_files: changed.map(f => f.file || f).slice(0, 40),
        did_verify: didVerify
      }
      try {
        const r = await applyCommandHook(h, payload, projectRoot, runtime)
        if (r.blocked) {
          blockingErrors.push(r.reason || 'Stop blocked by shell hook. Keep working.')
        } else if (r.note) {
          notes.push('Stop hook: ' + r.note.slice(0, 400))
        }
        if (r.json && (r.json.continue === false || r.json.preventContinuation === true)) {
          preventContinuation = true
        }
      } catch (e) {
        notes.push('Stop hook 失败：' + (e.message || e))
      }
      continue
    }

    if (h.continue === false || h.preventContinuation === true) {
      preventContinuation = true
      notes.push(h.message || 'Stop hook: preventContinuation')
      continue
    }
    if (h.blockIfNoVerify && changed.length && !didVerify) {
      blockingErrors.push(h.message || 'Stop blocked: files changed but agent_verify not run. Keep working.')
      continue
    }
    if (h.blockIfIncompleteTodos && pendingTodos.length) {
      blockingErrors.push(h.message || ('Stop blocked: incomplete todos remain (' + pendingTodos.length + '). Keep working.'))
      continue
    }
    if (h.block === true || h.decision === 'block') {
      blockingErrors.push(h.message || 'Stop blocked by hook. Keep working — do not summarize.')
      continue
    }
    if (h.message) notes.push(h.message)
  }

  // 内置默认 Stop 门控（PANDA_STOP_GATE=0 / CLAW_STOP_GATE=0 关闭）
  const stopGateOff = process.env.PANDA_STOP_GATE === '0' || process.env.CLAW_STOP_GATE === '0'
  if (!stopGateOff && !list.length) {
    if (runtime && runtime.pendingDiagErrors) {
      blockingErrors.push(
        'Stop gate: unresolved <new-diagnostics> errors remain. Fix them with edit_file before finishing.\n' +
        String(runtime.pendingDiagSummary || '').slice(0, 800)
      )
    } else if (runtime && runtime.pendingCommandFail) {
      blockingErrors.push(
        'Stop gate: last bash/build failed. Fix from stderr and re-run until exit 0.\n' +
        String(runtime.pendingCommandSummary || '').slice(0, 800)
      )
    } else if (runtime && runtime.verifyFailed && (runtime.verifyAttempts || 0) < 2) {
      // 默认 soft：对齐 panda-code（不硬锁 Stop）；PANDA_VERIFY_HARD=1 才 blocking
      const hard = process.env.PANDA_VERIFY_HARD === '1' || process.env.CLAW_VERIFY_HARD === '1'
      const msg = 'Verify was FAIL — fix issues or explain blockers; avoid infinite Verify loops.'
      if (hard) blockingErrors.push('Stop gate: ' + msg)
      else notes.push('NOTE: ' + msg)
    } else if (runtime && runtime.lastEditFailed) {
      blockingErrors.push(
        'Stop gate: last file edit failed. Read again and retry edit before finishing.'
      )
    } else if (pendingTodos.length) {
      blockingErrors.push(
        'Stop gate: incomplete todos — finish or update todos before ending.\n' +
        pendingTodos.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n')
      )
    } else if (changed.length >= 1 && !didVerify) {
      const vp = require('./verifyPolicy')
      if (vp.requiresAgentVerify(runtime, runtime && runtime.lastUserGoal)) {
        const hard = process.env.PANDA_VERIFY_HARD === '1' || process.env.CLAW_VERIFY_HARD === '1'
        const msg = 'Non-trivial files changed — consider Agent(Verify) before claiming done (panda-code soft nudge).'
        if (hard) {
          blockingErrors.push('Stop gate: files changed but agent_verify not run. Verify before finishing.')
        } else {
          notes.push('NOTE: ' + msg)
        }
      }
    }
  }

  return { preventContinuation, blockingErrors, notes }
}

/**
 * 通用事件 hook 运行器（UserPromptSubmit / SessionStart / PermissionRequest / PostToolUseFailure）
 */
async function runNamedHooks (eventName, projectRoot, payload, runtime, opts) {
  const hooks = await loadHooks(projectRoot)
  const list = expandHookEntries(hooks[eventName] || [])
  const notes = []
  let deny = false
  let denyMessage = ''
  let allowOverride = false
  const options = opts || {}

  for (const h of list) {
    if (options.toolName && h.matcher && !matchTool(h.matcher, options.toolName)) continue

    const isCmd = h.type === 'command' || (!!h.command && h.type !== 'prompt' && h.type !== 'message')
    if (isCmd && h.command) {
      const body = Object.assign({
        hook_event_name: eventName,
        cwd: projectRoot,
        session_id: (runtime && runtime.sessionId) || null
      }, payload || {})
      try {
        const r = await applyCommandHook(h, body, projectRoot, runtime)
        if (r.note) notes.push(eventName + ': ' + r.note.slice(0, 400))
        if (r.blocked) {
          deny = true
          denyMessage = r.reason || (eventName + ' hook blocked')
        }
        const perm = (r.json && (r.json.permissionDecision || (r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision)))
        if (perm === 'allow' || perm === 'approve') allowOverride = true
        if (perm === 'deny' || perm === 'block') {
          deny = true
          denyMessage = r.reason || (eventName + ' permissionDecision: deny')
        }
      } catch (e) {
        notes.push(eventName + ' hook 失败：' + (e.message || e))
      }
      continue
    }

    if (h.message) notes.push(h.message)
    if (h.deny === true || h.block === true) {
      deny = true
      denyMessage = h.message || (eventName + ' blocked')
    }
    if (h.permissionDecision === 'allow') allowOverride = true
    if (h.permissionDecision === 'deny') {
      deny = true
      denyMessage = h.message || (eventName + ' deny')
    }
  }

  return { notes, deny, denyMessage, allowOverride }
}

async function runUserPromptSubmitHooks (projectRoot, prompt, runtime) {
  return runNamedHooks('UserPromptSubmit', projectRoot, {
    prompt: String(prompt || '').slice(0, 8000)
  }, runtime)
}

async function runSessionStartHooks (projectRoot, runtime, source) {
  return runNamedHooks('SessionStart', projectRoot, {
    source: source || 'startup',
    permission_mode: (runtime && runtime.permissionMode) || null
  }, runtime)
}

/**
 * 权限弹窗前：hook 可 allow/deny，跳过 UI
 */
async function runPermissionRequestHooks (projectRoot, req, runtime) {
  return runNamedHooks('PermissionRequest', projectRoot, {
    tool_name: req && req.tool,
    tool_input: (req && req.args) || { detail: req && req.detail },
    risk: (req && req.risk) || 'write'
  }, runtime, { toolName: req && req.tool })
}

async function runPostToolUseFailureHooks (projectRoot, toolName, result, runtime) {
  return runNamedHooks('PostToolUseFailure', projectRoot, {
    tool_name: toolName,
    tool_input: (runtime && runtime._lastToolArgs) || {},
    error: String((result && result.content) || '').slice(0, 4000)
  }, runtime, { toolName })
}

async function runPermissionDeniedHooks (projectRoot, toolName, args, decision, runtime) {
  return runNamedHooks('PermissionDenied', projectRoot, {
    tool_name: toolName,
    tool_input: args || {},
    reason: (decision && decision.reason) || '',
    source: (decision && decision.source) || ''
  }, runtime, { toolName })
}

async function runPreCompactHooks (projectRoot, meta, runtime) {
  return runNamedHooks('PreCompact', projectRoot, {
    trigger: (meta && meta.trigger) || 'auto',
    tokens: (meta && meta.tokens) || 0
  }, runtime)
}

async function runPostCompactHooks (projectRoot, meta, runtime) {
  return runNamedHooks('PostCompact', projectRoot, {
    trigger: (meta && meta.trigger) || 'auto',
    tokens: (meta && meta.tokens) || 0,
    summary_chars: (meta && meta.summaryChars) || 0
  }, runtime)
}

async function runSubagentStartHooks (projectRoot, meta, runtime) {
  return runNamedHooks('SubagentStart', projectRoot, {
    agent_id: (meta && meta.agentId) || '',
    agent_type: (meta && meta.agentType) || 'fork',
    goal: String((meta && meta.goal) || '').slice(0, 2000)
  }, runtime)
}

async function runSubagentStopHooks (projectRoot, meta, runtime) {
  return runNamedHooks('SubagentStop', projectRoot, {
    agent_id: (meta && meta.agentId) || '',
    agent_type: (meta && meta.agentType) || 'fork',
    status: (meta && meta.status) || 'done',
    result: String((meta && meta.result) || '').slice(0, 4000)
  }, runtime)
}

async function runSessionEndHooks (projectRoot, runtime, reason) {
  return runNamedHooks('SessionEnd', projectRoot, {
    reason: reason || 'turn_end',
    permission_mode: (runtime && runtime.permissionMode) || null
  }, runtime)
}

module.exports = {
  loadHooks,
  runPreToolHooks,
  runPostToolHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  runSessionStartHooks,
  runPermissionRequestHooks,
  runPostToolUseFailureHooks,
  runPermissionDeniedHooks,
  runPreCompactHooks,
  runPostCompactHooks,
  runSubagentStartHooks,
  runSubagentStopHooks,
  runSessionEndHooks,
  execCommandHook,
  expandHookEntries,
  matchTool
}
