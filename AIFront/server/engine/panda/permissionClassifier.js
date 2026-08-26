/**
 * Auto mode 分类器（加厚对齐 panda-code yoloClassifier）
 * - 系统提示含 allow/deny/environment（settings.autoMode / config.autoMode）
 * - 注入 CLAUDE.md / Panda.md 摘要
 * - 注入近期 transcript 片段
 * 仅挂在 permissionMode=auto
 */

const fs = require('fs')
const path = require('path')
const { callDeepseekJson } = require('../shared-llm')

const cache = new Map()
const CACHE_TTL_MS = 10 * 60 * 1000

function cacheKey (tool, detail, extra) {
  return String(tool) + '::' + String(detail || '').slice(0, 200) + '::' + String(extra || '').slice(0, 80)
}

function getCached (key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.decision
}

function setCached (key, decision) {
  cache.set(key, { at: Date.now(), decision })
}

function loadAutoModeConfig (projectRoot) {
  const out = { allow: [], soft_deny: [], deny: [], environment: [] }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(projectRoot, '.panda', 'config.json'), 'utf8'))
    const am = cfg.autoMode || cfg.auto_mode || {}
    if (Array.isArray(am.allow)) out.allow = am.allow
    if (Array.isArray(am.soft_deny)) out.soft_deny = am.soft_deny
    if (Array.isArray(am.deny)) out.deny = am.deny
    if (Array.isArray(am.environment)) out.environment = am.environment
  } catch (e) { /* ignore */ }
  try {
    const perms = JSON.parse(fs.readFileSync(path.resolve(projectRoot, '.panda', 'permissions.json'), 'utf8'))
    ;(perms.allow || []).slice(0, 40).forEach(r => out.allow.push('rule allow: ' + r))
    ;(perms.deny || []).slice(0, 40).forEach(r => out.deny.push('rule deny: ' + r))
    ;(perms.ask || []).slice(0, 20).forEach(r => out.soft_deny.push('rule ask: ' + r))
  } catch (e) { /* ignore */ }
  return out
}

function loadProjectInstructions (projectRoot) {
  const chunks = []
  const files = [
    path.join(projectRoot, 'Panda.md'),
    path.join(projectRoot, 'CLAUDE.md'),
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, '.panda', 'Panda.md'),
    path.join(projectRoot, '.claude', 'CLAUDE.md')
  ]
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim()
      if (t) chunks.push('### ' + path.basename(f) + '\n' + t.slice(0, 4000))
    } catch (e) { /* ignore */ }
  }
  return chunks.join('\n\n').slice(0, 8000)
}

function extractTranscript (messages) {
  if (!Array.isArray(messages) || !messages.length) return ''
  const recent = messages.slice(-12)
  const lines = []
  for (const m of recent) {
    const role = m.role || m.type || '?'
    let content = m.content
    if (Array.isArray(content)) {
      content = content.map(c => {
        if (typeof c === 'string') return c
        if (c && c.type === 'text') return c.text
        if (c && c.type === 'tool_use') return '[tool_use ' + c.name + ']'
        if (c && c.type === 'tool_result') return '[tool_result]'
        return ''
      }).join(' ')
    }
    const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    if (text) lines.push(role + ': ' + text)
  }
  return lines.join('\n').slice(0, 3500)
}

function buildSystemPrompt (autoMode) {
  const allow = (autoMode.allow || []).map(d => '- ' + d).join('\n') || '- (none)'
  const deny = [].concat(autoMode.deny || [], autoMode.soft_deny || []).map(d => '- ' + d).join('\n') || '- (none)'
  const env = (autoMode.environment || []).map(d => '- ' + d).join('\n') || '- Local software engineering assistant in a git project.'
  return [
    '你是代码助手的 auto mode 安全分类器（对齐 panda-code yoloClassifier）。',
    '在用户不逐条确认的前提下，判断工具调用是否可自动批准。',
    '只输出 JSON：{ "decision": "allow"|"deny"|"ask", "reason": "简短中文" }',
    '',
    '判定原则：',
    '- deny：破坏性/不可逆、泄露密钥、越权系统、明显违背用户规则。',
    '- ask：有副作用但可能合法，或意图不清、需用户确认。',
    '- allow：只读、工作区内合理写改、低风险开发操作、符合用户明确意图。',
    '- 用户在 CLAUDE.md/Panda.md 中的明确意图应被尊重；但不可据此批准明显恶意破坏。',
    '- Err on the side of blocking when uncertain → prefer ask over allow.',
    '',
    '<user_allow_rules>',
    allow,
    '</user_allow_rules>',
    '<user_deny_rules>',
    deny,
    '</user_deny_rules>',
    '<user_environment>',
    env,
    '</user_environment>'
  ].join('\n')
}

/**
 * @returns {Promise<{ behavior: 'allow'|'deny'|'ask', reason: string, classifier: string, forceAsk?: boolean }|null>}
 */
async function classifyWithLlm (opts) {
  const tool = opts.tool
  const detail = String(opts.detail || '').slice(0, 800)
  const risk = opts.risk || 'write'
  const projectRoot = opts.projectRoot || process.cwd()
  const enabled = opts.enabled !== false
  if (!enabled) return null
  if (process.env.PANDA_AUTO_CLASSIFIER === '0' || process.env.PANDA_YOLO_LLM === '0') {
    return null
  }

  const autoMode = loadAutoModeConfig(projectRoot)
  const instructions = loadProjectInstructions(projectRoot)
  const transcript = extractTranscript(opts.messages || opts.transcript || [])
  const key = cacheKey(tool, detail, (transcript || '').slice(-60))
  const cached = getCached(key)
  if (cached) return Object.assign({}, cached, { classifier: 'llm_cache' })

  const system = buildSystemPrompt(autoMode)
  const userPayload = {
    tool,
    risk,
    detail,
    user_instructions_excerpt: instructions ? instructions.slice(0, 6000) : '',
    recent_transcript: transcript || ''
  }

  try {
    const data = await callDeepseekJson(
      system,
      JSON.stringify(userPayload, null, 2)
    )
    let decision = String((data && data.decision) || 'ask').toLowerCase()
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') decision = 'ask'
    const reason = (data && data.reason) || ('auto 分类器：' + decision)
    const out = {
      behavior: decision,
      reason: reason,
      classifier: 'llm',
      forceAsk: decision === 'ask'
    }
    setCached(key, out)
    return out
  } catch (e) {
    return null
  }
}

function clearClassifierCache () {
  cache.clear()
}

module.exports = {
  classifyWithLlm,
  clearClassifierCache,
  loadAutoModeConfig,
  buildSystemPrompt
}
