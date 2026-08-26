/**
 * 权限规则引擎（对齐 panda-code permissions.ts + filesystem.ts）
 *
 * 判定顺序：
 * 1. 硬安全拒绝（危险 shell / 密钥文件）— bypass-immune
 * 2. 用户 deny / ask / allow 规则 — deny/ask bypass-immune
 * 3. Plan / Verify 模式闸
 * 4. Path safety / 危险 rm — safetyCheck（bypass 下仍 ask）
 * 5. bypassPermissions：过规则后直接 allow（无 LLM）
 * 6. dontAsk：剩余 ask → deny
 * 7. auto：acceptEdits 快路径 → 白名单 → LLM 分类器
 *    （classifierApprovable 的 safetyCheck 可进分类器；否则免疫）
 * 8. acceptEdits / default
 *
 * 规则文件：.panda/permissions.json
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const TOOL_ALIASES = {
  Bash: 'bash',
  bash: 'bash',
  Shell: 'bash',
  Read: 'read_file',
  read_file: 'read_file',
  Write: 'write_file',
  write_file: 'write_file',
  Edit: 'edit_file',
  edit_file: 'edit_file',
  edit_lines: 'edit_lines',
  apply_patch: 'apply_patch',
  Glob: 'glob',
  Grep: 'grep',
  glob: 'glob',
  grep: 'grep',
  WebFetch: 'web_fetch',
  web_fetch: 'web_fetch',
  PowerShell: 'powershell',
  powershell: 'powershell'
}

/**
 * Auto 白名单（对齐 classifierDecision.ts SAFE_YOLO_ALLOWLISTED_TOOLS）
 * 不含 Write/Edit（走 acceptEdits 快路径）；不含 Agent（必须进分类器）
 */
const AUTO_SAFE_ALLOWLIST = new Set([
  'read_file', 'glob', 'grep', 'lsp', 'lsp_diagnostics',
  'todo_write', 'todo_read',
  'task_list', 'task_create', 'task_update', 'task_get', 'task_stop', 'task_output',
  'ask_user', 'enter_plan_mode', 'exit_plan_mode',
  'memory_read', 'session_info', 'config_get', 'mcp_list',
  'skill', 'brief', 'web_search', 'web_fetch',
  // 对齐 TERMINAL_CAPTURE：localhost 只读观测
  'capture_page', 'browser_console'
])

/** default/acceptEdits 下免询问的只读工具（比 auto 白名单略宽，含 memory_append 等） */
const READ_SAFE_TOOLS = new Set([
  ...AUTO_SAFE_ALLOWLIST,
  'memory_append', 'memory',
  'agent_list', 'agent_resume'
])

/** @deprecated 别名，兼容旧引用 */
const YOLO_SAFE_TOOLS = READ_SAFE_TOOLS

/** 硬拒绝：对齐上游「真破坏性」；catastrophic rm 路径用 ask（见 bashDangerousAsk） */
const HARD_DENY_BASH = [
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /\bcurl\b[\s\S]*\|\s*(ba)?sh/i,
  /\bwget\b[\s\S]*\|\s*(ba)?sh/i,
  /\bgit\s+push\s+[^\n]*--force/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bbase64\b[\s\S]*\|\s*(ba)?sh/i,
  />\s*\/dev\/(?!null\b)/i
]

/**
 * 危险 rm 等 → ask（对齐 panda-code pathValidation isDangerousRemovalPath）
 * 非 deny，bypass 下仍要问（safetyCheck 免疫）
 */
function bashDangerousAsk (command) {
  const cmd = String(command || '')
  // rm -rf / 或 $HOME 或系统根
  if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force)\b/i.test(cmd)) {
    if (/\s(\/|\/\*|~|\$HOME|\$\{HOME\})\s*($|[;&|])/.test(cmd) ||
        /\s(\/Users\/|\/home\/|\/usr\/|\/etc\/|\/var\/|\/tmp\/|C:\\\\)\S*/i.test(cmd)) {
      return {
        ask: true,
        reason: '危险删除路径需确认（对齐 panda-code）：' + cmd.slice(0, 100),
        safetyCheck: true,
        classifierApprovable: false
      }
    }
  }
  return { ask: false }
}

const cache = new Map() // projectRoot -> { mtime, rules }

function permissionsFile (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'permissions.json')
}

function normalizeToolName (name) {
  const n = String(name || '').trim()
  if (!n) return ''
  if (TOOL_ALIASES[n]) return TOOL_ALIASES[n]
  const lower = n.toLowerCase()
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower]
  return lower
}

/**
 * Parse "Tool" or "Tool(content)" — content may end with :* for prefix match
 */
function parseRuleString (ruleString) {
  const s = String(ruleString || '').trim()
  if (!s) return null
  const open = s.indexOf('(')
  if (open === -1) {
    return { toolName: normalizeToolName(s), ruleContent: null, prefix: false }
  }
  if (!s.endsWith(')')) {
    return { toolName: normalizeToolName(s), ruleContent: null, prefix: false }
  }
  const toolName = normalizeToolName(s.slice(0, open))
  let content = s.slice(open + 1, -1).trim()
  if (!content || content === '*') {
    return { toolName, ruleContent: null, prefix: false }
  }
  let prefix = false
  if (content.endsWith(':*')) {
    content = content.slice(0, -2)
    prefix = true
  } else if (content.endsWith('*') && !content.endsWith('\\*')) {
    content = content.slice(0, -1)
    prefix = true
  }
  return { toolName, ruleContent: content, prefix }
}

function matchRuleContent (rule, haystack) {
  if (!rule.ruleContent) return true
  const h = String(haystack || '')
  if (rule.prefix) {
    // 前缀须在边界结束，避免 Bash(ls:*) 误匹配 lsof
    if (h === rule.ruleContent) return true
    if (!h.startsWith(rule.ruleContent)) return false
    const next = h.charAt(rule.ruleContent.length)
    return !next || /[\s/\\=:]/.test(next)
  }
  // 路径 glob 简易：* → .*
  if (rule.ruleContent.includes('*') || rule.ruleContent.includes('?')) {
    const re = new RegExp(
      '^' + rule.ruleContent
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$',
      'i'
    )
    return re.test(h)
  }
  return h === rule.ruleContent || h.includes(rule.ruleContent)
}

function matchRule (rule, toolName, detail) {
  if (!rule) return false
  if (rule.toolName !== normalizeToolName(toolName)) return false
  return matchRuleContent(rule, detail)
}

function normalizeRulesList (list) {
  return (Array.isArray(list) ? list : [])
    .map(item => {
      if (item && typeof item === 'object' && item.toolName) {
        return {
          toolName: normalizeToolName(item.toolName),
          ruleContent: item.ruleContent == null ? null : String(item.ruleContent),
          prefix: !!item.prefix
        }
      }
      return parseRuleString(item)
    })
    .filter(Boolean)
}

async function loadPermissionRules (projectRoot) {
  const file = permissionsFile(projectRoot)
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch (e) {
    mtime = 0
  }
  const hit = cache.get(projectRoot)
  if (hit && hit.mtime === mtime) return hit.rules

  let raw = { allow: [], deny: [], ask: [] }
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    raw = {
      allow: parsed.allow || parsed.alwaysAllow || [],
      deny: parsed.deny || parsed.alwaysDeny || [],
      ask: parsed.ask || parsed.alwaysAsk || []
    }
  } catch (e) {
    /* defaults empty */
  }

  // 合并 config.json 里的 permissions（可选）
  try {
    const cfgPath = path.resolve(projectRoot, '.panda', 'config.json')
    const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'))
    if (cfg && cfg.permissions) {
      raw.allow = [].concat(raw.allow, cfg.permissions.allow || [])
      raw.deny = [].concat(raw.deny, cfg.permissions.deny || [])
      raw.ask = [].concat(raw.ask, cfg.permissions.ask || [])
    }
  } catch (e) { /* ignore */ }

  const rules = {
    allow: normalizeRulesList(raw.allow),
    deny: normalizeRulesList(raw.deny),
    ask: normalizeRulesList(raw.ask)
  }
  cache.set(projectRoot, { mtime, rules })
  return rules
}

function findMatching (rulesList, toolName, detail) {
  for (const rule of rulesList) {
    if (matchRule(rule, toolName, detail)) return rule
  }
  return null
}

function detailForTool (tool, args, fallbackDetail) {
  const name = normalizeToolName(tool)
  const a = args || {}
  if (fallbackDetail) return String(fallbackDetail)
  if (name === 'bash' || name === 'bash_bg') return String(a.command || '')
  if (name === 'powershell') return String(a.command || '')
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' ||
      name === 'edit_lines' || name === 'apply_patch') {
    return String(a.path || a.file_path || a.filePath || '')
  }
  try {
    return JSON.stringify(a).slice(0, 200)
  } catch (e) {
    return ''
  }
}

function hardDenyBash (command) {
  const cmd = String(command || '')
  for (const re of HARD_DENY_BASH) {
    if (re.test(cmd)) {
      return { deny: true, reason: '硬安全拒绝（YOLO 无效）：' + cmd.slice(0, 100) }
    }
  }
  return { deny: false }
}

function yoloAskBash (command) {
  // 已废弃：勿在 bypass 中使用。保留别名兼容。
  return bashDangerousAsk(command)
}

function sensitivePathDeny (tool, detail) {
  // 上游无 .env / node_modules 硬拒；敏感路径走 pathSafety ask。
  // 仅对密钥材料硬拒（产品底线，对齐「勿泄露密钥」）。
  const name = normalizeToolName(tool)
  if (!/^(write_file|edit_file|edit_lines|apply_patch|read_file)$/.test(name)) return null
  const p = String(detail || '').replace(/\\/g, '/')
  const base = path.basename(p)
  if (name !== 'read_file' && (base === '.env' || base === '.env.local' || /\.pem$/i.test(base) || /\.key$/i.test(base))) {
    return { behavior: 'deny', reason: '敏感密钥文件受保护：' + base }
  }
  return null
}

/**
 * acceptEdits 下可自动放行的 bash — 见 bashReadOnly.isAcceptEditsBash（按段校验）
 */
const bashReadOnly = require('./bashReadOnly')
const powershellReadOnly = require('./powershellReadOnly')
const bashSplit = require('./bashSplit')

function isShellReadOnly (toolName, detail) {
  if (toolName === 'powershell') return powershellReadOnly.isReadOnlyPowerShell(detail)
  return bashReadOnly.isReadOnlyBash(detail)
}

function isShellAcceptEdits (toolName, detail) {
  if (toolName === 'powershell') return powershellReadOnly.isAcceptEditsPowerShell(detail)
  return bashReadOnly.isAcceptEditsBash(detail)
}
const denialTracking = require('./denialTracking')

/**
 * 建议持久化 allow 规则（对齐 suggestionForExactCommand / suggestionForPrefix）
 * @returns {{ entry: string, label: string, toolName: string, ruleContent: string, prefix: boolean }[]}
 */
function suggestAllowRules (tool, detail) {
  const toolName = normalizeToolName(tool)
  const d = String(detail || '').trim()
  const out = []
  if (toolName === 'bash' || toolName === 'bash_bg') {
    const prefix = bashSplit.suggestBashPrefix(d)
    if (prefix) {
      out.push({
        entry: 'bash(' + prefix + ':*)',
        label: 'Bash(' + prefix + ':*)',
        toolName: 'bash',
        ruleContent: prefix,
        prefix: true
      })
    }
    if (d && (!prefix || d !== prefix)) {
      out.push({
        entry: 'bash(' + d.slice(0, 160) + ')',
        label: 'Bash(' + d.slice(0, 48) + (d.length > 48 ? '…' : '') + ')',
        toolName: 'bash',
        ruleContent: d.slice(0, 160),
        prefix: false
      })
    }
    return out
  }
  if (/^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(toolName) && d) {
    out.push({
      entry: toolName + '(' + d + ')',
      label: toolName + '(' + d.slice(0, 48) + (d.length > 48 ? '…' : '') + ')',
      toolName,
      ruleContent: d,
      prefix: false
    })
    return out
  }
  if (toolName) {
    out.push({
      entry: toolName,
      label: toolName,
      toolName,
      ruleContent: null,
      prefix: false
    })
  }
  return out
}

/** 兼容旧名：bypass 启发式（现仅用于测试/legacy；主路径用 evaluatePermission） */
function classifyYoloAction (tool, detail, risk) {
  const name = normalizeToolName(tool)
  if (AUTO_SAFE_ALLOWLIST.has(name) || READ_SAFE_TOOLS.has(name)) {
    return { behavior: 'allow', reason: '安全工具白名单', classifier: 'allowlist' }
  }
  if (name === 'bash' || name === 'bash_bg') {
    const hard = hardDenyBash(detail)
    if (hard.deny) {
      return { behavior: 'deny', reason: hard.reason, classifier: 'hard_deny' }
    }
    const dang = bashDangerousAsk(detail)
    if (dang.ask) {
      return {
        behavior: 'ask',
        reason: dang.reason,
        classifier: 'dangerous_path',
        forceAsk: true,
        safetyCheck: true,
        classifierApprovable: false
      }
    }
    // 对齐 bypass：过规则后放行，不 forceAsk 解释器长命令
    return { behavior: 'allow', reason: 'bypass 启发式放行', classifier: 'bypass_pass' }
  }
  if (name === 'notebook_edit' || name === 'write_file' || name === 'edit_file' || name === 'apply_patch' || name === 'edit_lines') {
    return { behavior: 'allow', reason: '写操作启发式放行', classifier: 'bypass_write' }
  }
  return { behavior: 'allow', reason: '启发式放行', classifier: 'bypass_other' }
}

/**
 * @returns {Promise<{
 *   behavior: 'allow'|'deny'|'ask',
 *   reason: string,
 *   forceAsk?: boolean,
 *   matched?: object,
 *   source?: string
 * }>}
 */
async function evaluatePermission (opts) {
  const {
    projectRoot,
    tool,
    args,
    detail: detailIn,
    risk = 'write',
    permissionMode = 'acceptEdits',
    sessionAllow = [],
    sessionDeny = [],
    sessionId = '',
    messages = []
  } = opts || {}

  const toolName = normalizeToolName(tool)
  const detail = detailForTool(toolName, args, detailIn)
  const mode = String(permissionMode || 'acceptEdits')
  const suggestions = suggestAllowRules(toolName, detail)

  // 0. 会话级 deny
  const sessDeny = normalizeRulesList(sessionDeny)
  const sd = findMatching(sessDeny, toolName, detail)
  if (sd) {
    return { behavior: 'deny', reason: '会话 deny 规则命中', matched: sd, source: 'session_deny', forceAsk: false }
  }

  // 1. 硬安全 + 敏感路径（bypass-immune）
  if (toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell') {
    const hard = hardDenyBash(detail)
    if (hard.deny) {
      return { behavior: 'deny', reason: hard.reason, source: 'hard_deny', forceAsk: false, suggestions }
    }
    const sec = require('./bashSecurity').analyzeBashSafety(detail)
    if (!sec.ok) {
      return {
        behavior: sec.severity === 'deny' ? 'deny' : 'ask',
        reason: sec.reason,
        source: 'bash_security',
        forceAsk: sec.severity !== 'deny',
        suggestions
      }
    }
  }
  const sens = sensitivePathDeny(toolName, detail)
  if (sens) {
    return { behavior: sens.behavior, reason: sens.reason, source: 'sensitive_path', forceAsk: false }
  }

  // 2. 持久化规则
  const rules = await loadPermissionRules(projectRoot || process.cwd())
  const denyHit = findMatching(rules.deny, toolName, detail)
  if (denyHit) {
    return {
      behavior: 'deny',
      reason: 'deny 规则命中：' + formatRule(denyHit) + '（YOLO 无效）',
      matched: denyHit,
      source: 'always_deny',
      forceAsk: false
    }
  }

  const askHit = findMatching(rules.ask, toolName, detail)
  if (askHit) {
    return {
      behavior: 'ask',
      reason: 'ask 规则命中：' + formatRule(askHit) + '（即使 YOLO 也需确认）',
      matched: askHit,
      source: 'always_ask',
      forceAsk: true
    }
  }

  const sessAllow = normalizeRulesList(sessionAllow)
  const sa = findMatching(sessAllow, toolName, detail)
  if (sa) {
    return { behavior: 'allow', reason: '会话 allow 规则命中', matched: sa, source: 'session_allow' }
  }

  const allowHit = findMatching(rules.allow, toolName, detail)
  if (allowHit) {
    return {
      behavior: 'allow',
      reason: 'allow 规则命中：' + formatRule(allowHit),
      matched: allowHit,
      source: 'always_allow'
    }
  }

  // 3. Plan / Verify 模式
  if (mode === 'plan') {
    if (toolName === 'exit_plan_mode') {
      return { behavior: 'ask', reason: '退出 Plan Mode 需批准计划', forceAsk: true, source: 'mode_plan_exit' }
    }
    if (risk === 'write' || /^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(toolName)) {
      const p = String(detail || '')
      if (p.startsWith('.panda/') || p.includes('/.panda/') || p.includes('.panda/sessions/')) {
        return { behavior: 'allow', reason: 'Plan Mode 允许写 .panda/scratchpad', source: 'mode_plan_scratch' }
      }
      return { behavior: 'deny', reason: 'Plan Mode 禁止写业务代码', source: 'mode_plan' }
    }
  }
  if (mode === 'verify') {
    if (/^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(toolName)) {
      return { behavior: 'deny', reason: 'Verify 模式禁止改项目文件', source: 'mode_verify' }
    }
    if (toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell' || READ_SAFE_TOOLS.has(toolName) || risk === 'read') {
      return { behavior: 'allow', reason: 'Verify 模式允许探测命令', source: 'mode_verify' }
    }
  }

  // 3b. Path safety（写工具）— bypass-immune ask
  // auto + classifierApprovable:true → 延后给分类器（对齐 permissions.ts）
  let deferredSafetyAsk = null
  const pathSafety = require('./pathSafety')
  if (pathSafety.isWriteTool(toolName) && detail) {
    const safety = pathSafety.checkPathSafetyForAutoEdit(detail)
    if (!safety.safe) {
      const askResult = {
        behavior: 'ask',
        reason: safety.message,
        source: 'safety_check',
        forceAsk: true,
        safetyCheck: true,
        classifierApprovable: !!safety.classifierApprovable
      }
      if (mode === 'auto' && safety.classifierApprovable) {
        deferredSafetyAsk = askResult
      } else {
        return askResult
      }
    }
  }

  // bash 危险删除路径 → ask（classifierApprovable:false，始终免疫）
  if ((toolName === 'bash' || toolName === 'bash_bg') && detail) {
    const dang = bashDangerousAsk(detail)
    if (dang.ask) {
      return {
        behavior: 'ask',
        reason: dang.reason,
        source: 'safety_check',
        forceAsk: true,
        safetyCheck: true,
        classifierApprovable: false
      }
    }
  }

  // 4. bypassPermissions（对齐 permissions.ts step 2a）：过规则后直接 allow，无 LLM
  if (mode === 'bypassPermissions' || mode === 'yolo') {
    return {
      behavior: 'allow',
      reason: 'bypassPermissions 放行',
      source: 'mode_bypass',
      forceAsk: false
    }
  }

  // 5. dontAsk：剩余未批准 → deny；只读 bash / 安全工具仍放行
  if (mode === 'dontAsk') {
    if (READ_SAFE_TOOLS.has(toolName) || risk === 'read') {
      return { behavior: 'allow', reason: 'dontAsk 只读放行', source: 'mode_dontAsk', suggestions }
    }
    if ((toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell') &&
        isShellReadOnly(toolName, detail)) {
      return { behavior: 'allow', reason: 'dontAsk · 只读 shell', source: 'mode_dontAsk_readonly', suggestions }
    }
    return {
      behavior: 'deny',
      reason: 'dontAsk 模式：未批准的操作视为拒绝',
      source: 'mode_dontAsk',
      forceAsk: false,
      suggestions
    }
  }

  // 6. auto：acceptEdits 快路径 → 只读 bash → 白名单 → LLM 分类器
  if (mode === 'auto') {
    if (pathSafety.isWriteTool(toolName) && !deferredSafetyAsk) {
      const perms = require('./permissions')
      const inCwd = perms.isInWorkingDir(projectRoot, detail)
      if (inCwd) {
        denialTracking.recordSuccess(sessionId)
        return { behavior: 'allow', reason: 'auto · acceptEdits 快路径（CWD 内写）', source: 'auto_accept_edits', suggestions }
      }
    }
    if (AUTO_SAFE_ALLOWLIST.has(toolName) || risk === 'read') {
      denialTracking.recordSuccess(sessionId)
      return { behavior: 'allow', reason: 'auto · 安全白名单', source: 'auto_allowlist', suggestions }
    }
    if (toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell') {
      if (isShellAcceptEdits(toolName, detail)) {
        denialTracking.recordSuccess(sessionId)
        return { behavior: 'allow', reason: 'auto · acceptEdits shell 快路径（全段）', source: 'auto_accept_shell', suggestions }
      }
      if (isShellReadOnly(toolName, detail)) {
        denialTracking.recordSuccess(sessionId)
        return { behavior: 'allow', reason: 'auto · 只读 shell', source: 'auto_readonly_shell', suggestions }
      }
    }
    let llmOn = true
    try {
      const cfg = JSON.parse(fs.readFileSync(path.resolve(projectRoot || '', '.panda', 'config.json'), 'utf8'))
      if (cfg.autoClassifier === false || cfg.disableAutoMode === true) llmOn = false
    } catch (e) { /* default on */ }
    if (process.env.PANDA_AUTO_CLASSIFIER === '0') llmOn = false
    if (llmOn) {
      try {
        const llm = await require('./permissionClassifier').classifyWithLlm({
          tool: toolName,
          detail,
          risk,
          enabled: true,
          projectRoot: projectRoot || process.cwd(),
          messages: messages || []
        })
        if (llm) {
          if (llm.behavior === 'allow') {
            denialTracking.recordSuccess(sessionId)
            return {
              behavior: 'allow',
              reason: llm.reason,
              source: 'auto_classifier:' + (llm.classifier || 'llm'),
              forceAsk: false,
              suggestions
            }
          }
          if (llm.behavior === 'deny') {
            const st = denialTracking.recordDenial(sessionId)
            if (denialTracking.shouldFallbackToPrompting(st)) {
              return {
                behavior: 'ask',
                reason: 'auto 连续拒绝达上限，回退人工确认：' + (llm.reason || toolName),
                source: 'auto_denial_circuit',
                forceAsk: true,
                suggestions
              }
            }
            return {
              behavior: 'deny',
              reason: llm.reason,
              source: 'auto_classifier:' + (llm.classifier || 'llm'),
              forceAsk: false,
              suggestions
            }
          }
          return {
            behavior: 'ask',
            reason: llm.reason,
            source: 'auto_classifier:' + (llm.classifier || 'llm'),
            forceAsk: true,
            suggestions
          }
        }
      } catch (e) { /* fall through */ }
    }
    if (deferredSafetyAsk) {
      return Object.assign({}, deferredSafetyAsk, { suggestions })
    }
    return {
      behavior: 'ask',
      reason: 'auto 分类器不可用，需确认：' + toolName,
      source: 'auto_fallback_ask',
      forceAsk: true,
      suggestions
    }
  }

  // 7. acceptEdits：CWD 内写；bash 全段 filesystem 或只读
  if (mode === 'acceptEdits') {
    if (pathSafety.isWriteTool(toolName) || risk === 'write') {
      const perms = require('./permissions')
      if (perms.isInWorkingDir(projectRoot, detail)) {
        return { behavior: 'allow', reason: 'acceptEdits · CWD 内写', source: 'mode_acceptEdits', suggestions }
      }
      return {
        behavior: 'ask',
        reason: 'acceptEdits · 工作区外写需确认：' + String(detail || '').slice(0, 120),
        source: 'mode_acceptEdits_outside',
        forceAsk: true,
        suggestions
      }
    }
    if (READ_SAFE_TOOLS.has(toolName) || risk === 'read') {
      return { behavior: 'allow', reason: '只读/安全工具', source: 'safe_tool', suggestions }
    }
    if (toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell') {
      if (isShellAcceptEdits(toolName, detail)) {
        return { behavior: 'allow', reason: 'acceptEdits · 文件系统命令（全段）', source: 'mode_acceptEdits_shell', suggestions }
      }
      if (isShellReadOnly(toolName, detail)) {
        return { behavior: 'allow', reason: 'acceptEdits · 只读 shell', source: 'mode_acceptEdits_readonly', suggestions }
      }
    }
    return { behavior: 'ask', reason: 'acceptEdits 下终端需确认', source: 'mode_acceptEdits_shell', forceAsk: true, suggestions }
  }

  // 8. default：只读工具 / 只读 shell 放行；其余 ask
  if (READ_SAFE_TOOLS.has(toolName) || risk === 'read') {
    return { behavior: 'allow', reason: '只读/安全工具', source: 'safe_tool', suggestions }
  }
  if ((toolName === 'bash' || toolName === 'bash_bg' || toolName === 'powershell') &&
      isShellReadOnly(toolName, detail)) {
    return { behavior: 'allow', reason: 'default · 只读 shell', source: 'mode_default_readonly', suggestions }
  }
  return { behavior: 'ask', reason: 'default 模式需确认', source: 'mode_default', forceAsk: true, suggestions }
}

function formatRule (rule) {
  if (!rule) return ''
  if (!rule.ruleContent) return rule.toolName
  return rule.toolName + '(' + rule.ruleContent + (rule.prefix ? ':*' : '') + ')'
}

async function formatRulesSummary (projectRoot) {
  const rules = await loadPermissionRules(projectRoot)
  const lines = [
    '权限规则（.panda/permissions.json）',
    '判定：deny > ask > allow > 模式；bypass 无 LLM；仅 auto 跑分类器；safetyCheck 免疫 bypass。',
    '',
    'deny (' + rules.deny.length + '):',
    ...(rules.deny.length ? rules.deny.map(r => '  - ' + formatRule(r)) : ['  (无)']),
    'ask (' + rules.ask.length + '):',
    ...(rules.ask.length ? rules.ask.map(r => '  - ' + formatRule(r)) : ['  (无)']),
    'allow (' + rules.allow.length + '):',
    ...(rules.allow.length ? rules.allow.map(r => '  - ' + formatRule(r)) : ['  (无)']),
    '',
    '示例：',
    '  { "allow": ["Bash(npm run build)", "Bash(git status:*)"],',
    '    "deny": ["Bash(rm -rf:*)", "Bash(sudo:*)"],',
    '    "ask": ["Bash(git push:*)"] }'
  ]
  return lines.join('\n')
}

function clearRulesCache (projectRoot) {
  if (projectRoot) cache.delete(projectRoot)
  else cache.clear()
}

async function appendPersistentRule (projectRoot, listName, tool, detail, opts) {
  const root = path.resolve(projectRoot || process.cwd())
  const file = path.join(root, '.panda', 'permissions.json')
  let raw = { allow: [], deny: [], ask: [] }
  try {
    const txt = await fsp.readFile(file, 'utf8')
    raw = Object.assign(raw, JSON.parse(txt))
  } catch (e) { /* new file */ }
  const key = listName === 'ask' ? 'ask' : (listName === 'allow' ? 'allow' : 'deny')
  if (!Array.isArray(raw[key])) raw[key] = []
  const toolName = normalizeToolName(tool) || String(tool || '')
  const d = String(detail || '').trim()
  const asPrefix = !!(opts && opts.prefix)
  let entry
  if (!d) entry = toolName
  else if (asPrefix) entry = toolName + '(' + d + ':*)'
  else entry = toolName + '(' + d + ')'
  if (!raw[key].includes(entry)) raw[key].push(entry)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  clearRulesCache(root)
  return { ok: true, entry, list: key }
}

async function removePersistentRule (projectRoot, listName, match) {
  const root = path.resolve(projectRoot || process.cwd())
  const file = path.join(root, '.panda', 'permissions.json')
  let raw = { allow: [], deny: [], ask: [] }
  try {
    const txt = await fsp.readFile(file, 'utf8')
    raw = Object.assign(raw, JSON.parse(txt))
  } catch (e) {
    return { ok: false, reason: 'no permissions.json' }
  }
  const key = listName === 'ask' ? 'ask' : (listName === 'allow' ? 'allow' : 'deny')
  if (!Array.isArray(raw[key])) raw[key] = []
  const needle = String(match || '').trim()
  const before = raw[key].length
  raw[key] = raw[key].filter(r => {
    const s = String(r)
    return !(s === needle || s.indexOf(needle) >= 0)
  })
  if (raw[key].length === before) return { ok: false, reason: 'no match: ' + needle }
  await fsp.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  clearRulesCache(root)
  return { ok: true, removed: before - raw[key].length, list: key }
}

module.exports = {
  evaluatePermission,
  loadPermissionRules,
  parseRuleString,
  matchRule,
  normalizeToolName,
  classifyYoloAction,
  hardDenyBash,
  formatRulesSummary,
  clearRulesCache,
  appendPersistentRule,
  removePersistentRule,
  suggestAllowRules,
  YOLO_SAFE_TOOLS,
  AUTO_SAFE_ALLOWLIST,
  READ_SAFE_TOOLS,
  HARD_DENY_BASH
}
