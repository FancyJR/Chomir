/**
 * 上下文压缩（对齐 panda-code services/compact）
 * 分层：token 估计 → microcompact（清旧 tool 正文）→ autocompact（LLM 摘要）→ 边界标记
 *
 * 「硬水位」保证（非神话 80% 滑动窗）：
 * - 每次推理前 agent.js 同步调用 maybeCompactMessages（≈ beforeEachInference）
 * - micro：保留最近 MICRO_KEEP_RECENT（默认 5）条可清理 tool 结果全文，更早清成占位
 * - auto：阈值 = contextWindow - outputReserve - 13000（可用 CLAW_* 覆盖），不是裸 80%
 * - system 消息（含 MEMORY 注入）永不丢弃；MEMORY.md 不靠 transcript 保活
 */

const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const { callDeepseekText } = require('../shared-llm')
const { sanitizeMessagesForApi, expandKeepStart } = require('./messageSanitize')

const CONTEXT_WINDOW = parseInt(process.env.CLAW_CONTEXT_WINDOW, 10) || 128000
const MAX_OUTPUT_RESERVE = parseInt(process.env.CLAW_COMPACT_OUTPUT_RESERVE, 10) || 8192
const AUTOCOMPACT_BUFFER = parseInt(process.env.CLAW_AUTOCOMPACT_BUFFER, 10) || 16000
const MICRO_KEEP_RECENT = parseInt(process.env.CLAW_MICROCOMPACT_KEEP, 10) || 5
const CIRCUIT_BREAKER_MAX = 3

const MICRO_CLEARABLE = new Set([
  'read_file', 'Read', 'grep', 'Grep', 'glob', 'Glob',
  'bash', 'Bash', 'web_fetch', 'WebFetch', 'web_search', 'WebSearch',
  'edit_file', 'Edit', 'write_file', 'Write', 'apply_patch', 'edit_lines'
])

const CLEARED_TOOL = '[Old tool result content cleared]'

let consecutiveFailures = 0

function estimateTokens (messages) {
  let chars = 0
  for (const m of messages || []) {
    if (!m) continue
    if (typeof m.content === 'string') chars += m.content.length
    else if (m.content != null) chars += JSON.stringify(m.content).length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
    if (m.tool_call_id) chars += String(m.tool_call_id).length + 8
  }
  // 粗估：中英混合约 2.5 char/token，偏保守
  return Math.ceil(chars / 2.5)
}

function estimateChars (messages) {
  return (messages || []).reduce((n, m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    const tools = m.tool_calls ? JSON.stringify(m.tool_calls) : ''
    return n + c.length + tools.length
  }, 0)
}

function getAutoCompactThreshold () {
  const effective = Math.max(16000, CONTEXT_WINDOW - MAX_OUTPUT_RESERVE)
  return Math.max(12000, effective - AUTOCOMPACT_BUFFER)
}

function getBlockingLimit () {
  const effective = Math.max(16000, CONTEXT_WINDOW - MAX_OUTPUT_RESERVE)
  return Math.max(14000, effective - 3000)
}

/** 从 assistant.tool_calls 反查工具名 */
function toolNameByCallId (messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      if (tc && tc.id === toolCallId) {
        return (tc.function && tc.function.name) || ''
      }
    }
  }
  return ''
}

/**
 * Microcompact：保留最近 N 个可清理 tool 结果的正文，更早的换成占位（配对保留）
 * 对标 panda-code microCompact.ts
 */
function microcompactMessages (messages, options = {}) {
  const keepRecent = options.keepRecent != null ? options.keepRecent : MICRO_KEEP_RECENT
  if (!Array.isArray(messages) || messages.length < 8) return { messages, cleared: 0 }

  const clearableIdx = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== 'tool' || !m.tool_call_id) continue
    if (m.content === CLEARED_TOOL) continue
    const name = toolNameByCallId(messages, m.tool_call_id)
    // 未知名也当作可清理（多为 read/grep 类大结果）
    if (!name || MICRO_CLEARABLE.has(name)) clearableIdx.push(i)
  }
  if (clearableIdx.length <= keepRecent) return { messages, cleared: 0 }

  const toClear = new Set(clearableIdx.slice(0, clearableIdx.length - keepRecent))
  let cleared = 0
  const out = messages.map((m, i) => {
    if (!toClear.has(i)) return m
    const len = String(m.content || '').length
    if (len < 400) return m
    cleared++
    return { role: 'tool', tool_call_id: m.tool_call_id, content: CLEARED_TOOL }
  })
  return { messages: out, cleared }
}

function buildCompactPrompt () {
  return [
    '你是对话压缩器（对标 Panda Code compact + SessionMemory）。把历史压成结构化中文摘要，供后续 Agent 与 session-memory 续写。',
    '必须按下列小节输出（用 Markdown ## 标题）：',
    '## Session Title',
    '（5–10 词密度标题）',
    '## Current State',
    '正在做的事、未完成任务、立刻下一步',
    '## Task specification',
    '用户意图、约束、关键设计决策；突出【最近一次明确用户请求】',
    '## Files and Functions',
    '已读/已改路径与要点',
    '## Errors & Corrections',
    '重要错误与修复；勿再尝试的失败路径',
    '## Key results',
    '用户要的明确输出（若有）',
    '## Worklog',
    '极简步骤列表',
    '若历史里出现多个主题，标明主题切换，并写清当前应以哪条最新请求为准。',
    '不要废话，不要客套。直接给摘要正文。'
  ].join('\n')
}

function formatDigest (oldPart) {
  const lines = []
  for (const m of oldPart) {
    if (!m || !m.role) continue
    if (m.role === 'tool') {
      const c = String(m.content || '')
      if (c === CLEARED_TOOL) continue
      lines.push('tool[' + (m.tool_call_id || '') + ']: ' + c.slice(0, 400))
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const names = m.tool_calls.map(tc => (tc.function && tc.function.name) || '?').join(',')
      const text = typeof m.content === 'string' ? m.content.slice(0, 300) : ''
      lines.push('assistant(tools=' + names + '): ' + text)
      continue
    }
    const content = typeof m.content === 'string' ? m.content.slice(0, 600) : '[complex]'
    lines.push(m.role + ': ' + content)
  }
  return lines.join('\n').slice(0, 20000)
}

/**
 * 压缩后恢复最近读过的文件片段（对标 post-compact file restore）
 */
function restoreReadFilesAttachment (runtime, maxFiles = 5, maxCharsEach = 12000) {
  if (!runtime || !runtime.readFileState || typeof runtime.readFileState.entries !== 'function') return ''
  const entries = [...runtime.readFileState.entries()]
    .filter(([, v]) => v && !v.isPartialView && v.content)
    .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0))
    .slice(0, maxFiles)
  if (!entries.length) return ''
  const blocks = ['【压缩后恢复的近期文件快照（可能略旧，改前请重新 read_file）】']
  let total = 0
  for (const [abs, st] of entries) {
    const rel = (() => {
      try {
        return path.relative(runtime.projectRoot || '', abs).split(path.sep).join('/')
      } catch (e) {
        return abs
      }
    })()
    let body = String(st.content || '')
    if (body.length > maxCharsEach) body = body.slice(0, maxCharsEach) + '\n…[截断]'
    total += body.length
    if (total > 50000) break
    blocks.push('### ' + rel + '\n```\n' + body + '\n```')
  }
  return blocks.join('\n\n')
}

async function persistToolOverflow (projectRoot, sessionId, toolCallId, content) {
  if (!projectRoot || !sessionId || !toolCallId) return null
  try {
    const editMatch = require('./editMatch')
    const dir = path.resolve(projectRoot, '.panda', 'tool-results', sessionId)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, toolCallId.replace(/[^\w.-]/g, '_') + '.txt')
    // 落盘前剥掉 read_file 行号前缀，避免再 Read 时叠成 1|1|1|…
    const clean = editMatch.stripLineNumberPrefix(String(content || ''))
    await fsp.writeFile(file, clean, 'utf8')
    const rel = path.relative(projectRoot, file).split(path.sep).join('/')
    return rel
  } catch (e) {
    return null
  }
}

/**
 * 大 tool 结果落盘，消息里只留预览（对标 toolResultStorage）
 */
async function budgetToolResults (messages, runtime, options = {}) {
  const maxInline = options.maxInlineChars || 12000
  const aggregateMax = options.aggregateMax || 180000
  if (!Array.isArray(messages)) return messages
  const editMatch = require('./editMatch')

  let aggregate = 0
  const out = []
  for (const m of messages) {
    if (!m || m.role !== 'tool') {
      out.push(m)
      continue
    }
    let content = String(m.content || '')
    aggregate += content.length
    if (content.length > maxInline || aggregate > aggregateMax) {
      const rel = await persistToolOverflow(
        runtime && runtime.projectRoot,
        runtime && runtime.sessionId,
        m.tool_call_id,
        content
      )
      const preview = editMatch.stripLineNumberPrefix(content).slice(0, 2000)
      content = rel
        ? ('<persisted-output path="' + rel + '">\n' + preview +
          '\n…[已落盘为纯文本。仅当预览不够时再 read_file；勿反复 Read 同一落盘文件]\n</persisted-output>')
        : (preview + '\n…[工具结果过长已截断]')
      if (aggregate > aggregateMax) aggregate = Math.floor(aggregate * 0.5)
    }
    out.push({ role: 'tool', tool_call_id: m.tool_call_id, content })
  }
  return out
}

/**
 * @param {Array} messages
 * @param {object} options
 * @param {object} [runtime]
 */
async function maybeCompactMessages (messages, options = {}, runtime = null) {
  if (!Array.isArray(messages) || !messages.length) return messages || []
  if (process.env.DISABLE_COMPACT === '1' || process.env.DISABLE_AUTO_COMPACT === '1') {
    return sanitizeMessagesForApi(messages)
  }

  let working = sanitizeMessagesForApi(messages)

  // 1) 大 tool 结果预算
  working = await budgetToolResults(working, runtime, options)

  // 2) microcompact
  const micro = microcompactMessages(working, { keepRecent: options.microKeepRecent || MICRO_KEEP_RECENT })
  working = micro.messages

  const force = !!options.force
  const tokens = estimateTokens(working)
  const threshold = options.tokenThreshold || getAutoCompactThreshold()
  const keepLast = options.keepLast || 16

  if (!force && tokens < threshold) {
    return sanitizeMessagesForApi(working)
  }

  if (consecutiveFailures >= CIRCUIT_BREAKER_MAX && !force) {
    // 熔断：只做 microcompact，避免反复打爆摘要 API
    return sanitizeMessagesForApi(working)
  }

  const system = working[0] && working[0].role === 'system' ? working[0] : null
  // 硬保证：system（含 MEMORY / SessionMemory / Panda.md）绝不进入 oldPart 丢弃区
  const body = system ? working.slice(1) : working.slice()
  if (body.length <= keepLast + 2 && !force) {
    return sanitizeMessagesForApi(working)
  }

  let keepStart = Math.max(0, body.length - keepLast)
  keepStart = expandKeepStart(body, keepStart)
  // 跳过 compact_boundary 之后的内容已在 body 内；不要把边界后的再压进去

  // 若存在 boundary，只压 boundary 之后、keep 之前的部分
  let boundaryIdx = -1
  for (let i = 0; i < body.length; i++) {
    if (body[i] && body[i]._compactBoundary) boundaryIdx = i
  }
  const oldFrom = boundaryIdx >= 0 ? boundaryIdx + 1 : 0
  if (keepStart <= oldFrom && !force) {
    return sanitizeMessagesForApi(working)
  }

  const oldPart = body.slice(oldFrom, keepStart)
  const recent = body.slice(keepStart)
  if (!oldPart.length) return sanitizeMessagesForApi(working)

  const digestSource = formatDigest(oldPart)
  let summary = ''

  try {
    const hooks = require('./hooks')
    const pre = await hooks.runPreCompactHooks(runtime && runtime.projectRoot, {
      trigger: force ? 'manual' : 'auto',
      tokens
    }, runtime)
    if (pre && pre.deny) {
      if (runtime && runtime.sendEvent) {
        runtime.sendEvent('panda_block', {
          type: 'system',
          content: 'Hook(PreCompact) blocked: ' + (pre.denyMessage || '')
        })
      }
      return sanitizeMessagesForApi(working)
    }
    if (pre && pre.notes && pre.notes.length && runtime && runtime.sendEvent) {
      runtime.sendEvent('panda_block', {
        type: 'system',
        content: 'Hook(PreCompact): ' + pre.notes.join(' | ')
      })
    }
  } catch (e) { /* ignore */ }

  try {
    summary = await callDeepseekText(buildCompactPrompt(), digestSource, { max_tokens: 1600 })
    consecutiveFailures = 0
  } catch (e) {
    consecutiveFailures++
    summary = '（压缩失败）已丢弃较早轮次细节。请根据最近消息与已打开文件继续；不确定处请重新 read_file。'
  }

  const restored = restoreReadFilesAttachment(runtime)
  const summaryBody = [
    '【系统：对话已自动压缩 compact_boundary · tokens≈' + tokens + '→摘要】',
    '以下摘要供你延续，不要向用户复述本段，直接继续任务：',
    summary,
    restored || ''
  ].filter(Boolean).join('\n\n')

  // SessionMemory：摘要晋升到会话长期区（下一轮 system 注入）
  try {
    if (runtime && runtime.projectRoot && runtime.sessionId && summary && !/压缩失败/.test(summary)) {
      await require('./sessionMemory').writeSessionMemory(runtime.projectRoot, runtime.sessionId, summary)
    }
  } catch (e) { /* ignore */ }

  try {
    const hooks = require('./hooks')
    const post = await hooks.runPostCompactHooks(runtime && runtime.projectRoot, {
      trigger: force ? 'manual' : 'auto',
      tokens,
      summaryChars: String(summary || '').length
    }, runtime)
    if (post && post.notes && post.notes.length && runtime && runtime.sendEvent) {
      runtime.sendEvent('panda_block', {
        type: 'system',
        content: 'Hook(PostCompact): ' + post.notes.join(' | ')
      })
    }
  } catch (e) { /* ignore */ }

  const compacted = []
  if (system) compacted.push(system)
  compacted.push({
    role: 'user',
    content: summaryBody,
    _compactBoundary: true,
    _compactMeta: { trigger: force ? 'manual' : 'auto', preTokens: tokens, at: Date.now() }
  })
  compacted.push({
    role: 'assistant',
    content: '继续。'
  })

  if (runtime && runtime.sendEvent) {
    runtime.sendEvent('panda_status', {
      message: '上下文已压缩 · ~' + tokens + ' tok' + (micro.cleared ? ' · 清理 ' + micro.cleared + ' 条旧工具结果' : ''),
      phase: 'compact',
      tokens,
      cleared: micro.cleared || 0
    })
    runtime.sendEvent('panda_block', {
      type: 'system',
      content: '✻ Context compacted (~' + tokens + ' tokens)' + (micro.cleared ? ', cleared ' + micro.cleared + ' tool results' : '')
    })
  }

  return sanitizeMessagesForApi(compacted.concat(recent))
}

function getMessagesAfterCompactBoundary (messages) {
  if (!Array.isArray(messages)) return []
  let last = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i]._compactBoundary) last = i
  }
  if (last < 0) return messages
  const system = messages[0] && messages[0].role === 'system' ? [messages[0]] : []
  // boundary 是 user 摘要消息，从它开始保留
  const rest = messages.slice(last)
  if (system.length && rest[0] !== messages[0]) return system.concat(rest)
  return rest
}

/**
 * 是否为上下文溢出 / prompt too long（对标 prompt_too_long）
 */
function isPromptTooLongError (err) {
  if (!err) return false
  if (err.code === 'PROMPT_TOO_LONG') return true
  const status = err.status || err.statusCode
  if (status === 413) return true
  const msg = String(err.message || err || '')
  return (
    /prompt\s*(is\s*)?too\s*long/i.test(msg) ||
    /context[_ ]length|maximum context|max.+context|context window/i.test(msg) ||
    /too many tokens|token.?limit|request too large|payload too large/i.test(msg) ||
    /\b413\b/.test(msg)
  )
}

/**
 * Reactive compact：API 因上下文过长失败后强制压缩，供再试一轮
 * 对标 panda-code services/compact/reactiveCompact + query.ts withhold→compact→continue
 *
 * @returns {Promise<{ messages: Array, ok: boolean, tokensBefore: number, tokensAfter: number }>}
 */
async function reactiveCompactOnOverflow (messages, runtime = null, options = {}) {
  const before = estimateTokens(messages)
  if (process.env.DISABLE_COMPACT === '1' || process.env.DISABLE_REACTIVE_COMPACT === '1') {
    return { messages: messages || [], ok: false, tokensBefore: before, tokensAfter: before }
  }

  if (runtime && runtime.sendEvent) {
    runtime.sendEvent('panda_status', {
      message: 'Prompt too long · reactive compact…',
      phase: 'reactive_compact',
      tokens: before
    })
    runtime.sendEvent('panda_block', {
      type: 'system',
      content: '⚠ Prompt too long（~' + before + ' tok）· 强制压缩后自动再试一轮'
    })
  }

  // 1) 激进 microcompact + 强制 LLM 摘要（保留最近较少轮）
  let next = await maybeCompactMessages(messages, {
    force: true,
    keepLast: options.keepLast != null ? options.keepLast : 8,
    microKeepRecent: options.microKeepRecent != null ? options.microKeepRecent : 2
  }, runtime)

  // 2) 再清一轮旧 tool 正文
  const micro = microcompactMessages(next, { keepRecent: 1 })
  next = micro.messages

  // 3) 仍偏大则再压一轮，只留更短尾巴
  if (estimateTokens(next) > getAutoCompactThreshold() * 0.9) {
    next = await maybeCompactMessages(next, {
      force: true,
      keepLast: 4,
      microKeepRecent: 1
    }, runtime)
  }

  const after = estimateTokens(next)
  if (runtime && runtime.sendEvent) {
    runtime.sendEvent('panda_status', {
      message: 'Reactive compact 完成 · ~' + before + '→' + after + ' tok · 重试模型',
      phase: 'reactive_compact_done',
      tokens: after,
      tokensBefore: before
    })
  }

  return {
    messages: sanitizeMessagesForApi(next),
    ok: after < before || after < getBlockingLimit(),
    tokensBefore: before,
    tokensAfter: after
  }
}

module.exports = {
  estimateChars,
  estimateTokens,
  getAutoCompactThreshold,
  getBlockingLimit,
  microcompactMessages,
  maybeCompactMessages,
  reactiveCompactOnOverflow,
  isPromptTooLongError,
  budgetToolResults,
  getMessagesAfterCompactBoundary,
  sanitizeMessagesForApi,
  CLEARED_TOOL,
  CONTEXT_WINDOW
}
