/**
 * Agent Fork / Resume —— 完整 sidechain + 权限/模型/readFileState 继承
 * 对标 panda-code AgentTool fork（bubble permissions、inherit model、clone readFileState）
 */

const fsp = require('fs').promises
const path = require('path')
const { callDeepseekChat } = require('../shared-llm')
const { sanitizeMessagesForApi } = require('./messageSanitize')
const { runExploreAgent, runPlanAgent, runVerifyAgent } = require('./subagents')

const FORK_TAG = '<panda-fork-sidechain>'

/** @type {Map<string, object>} */
const forks = new Map()

function getToolsApi () {
  return require('./tools')
}

function key (projectRoot, id) {
  return projectRoot + '::' + id
}

function forkDir (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'forks')
}

async function persist (projectRoot, fork) {
  const dir = forkDir(projectRoot)
  await fsp.mkdir(dir, { recursive: true })
  const slim = Object.assign({}, fork, {
    // Map 不可 JSON，转 entries
    readFileStateEntries: fork.readFileStateEntries || []
  })
  delete slim.parentRequirePermission
  await fsp.writeFile(path.join(dir, fork.id + '.json'), JSON.stringify(slim, null, 2), 'utf8')
}

async function loadPersisted (projectRoot, id) {
  try {
    const raw = await fsp.readFile(path.join(forkDir(projectRoot), id + '.json'), 'utf8')
    const fork = JSON.parse(raw)
    forks.set(key(projectRoot, id), fork)
    return fork
  } catch (e) {
    return null
  }
}

function cloneReadFileState (src) {
  const map = new Map()
  if (!src) return map
  if (src instanceof Map) {
    for (const [k, v] of src) {
      map.set(k, v && typeof v === 'object' ? Object.assign({}, v) : v)
    }
    return map
  }
  if (Array.isArray(src)) {
    for (const [k, v] of src) map.set(k, v)
  }
  return map
}

function serializeReadFileState (map) {
  if (!(map instanceof Map)) return []
  return [...map.entries()]
}

function isInForkChild (messages) {
  return (messages || []).some(m =>
    m && m.role === 'user' && typeof m.content === 'string' && m.content.includes(FORK_TAG)
  )
}

function filterIncompleteToolCalls (messages) {
  // 去掉末尾未完成的 assistant.tool_calls（无对应 tool 结果）
  const out = (messages || []).slice()
  while (out.length) {
    const last = out[out.length - 1]
    if (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length) {
      out.pop()
      continue
    }
    break
  }
  return out.filter(m => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool'))
}

function createBubblePermission (parentGate, sendEvent, forkId) {
  if (typeof parentGate !== 'function') return null
  return async function bubblePermission (req) {
    if (sendEvent) {
      sendEvent('panda_block', {
        type: 'system',
        content: 'Fork ' + forkId + ' 请求权限：' + (req.tool || '') + ' ' + (req.detail || '')
      })
    }
    // bubble：交给父级同一闸门（含 YOLO / Diff UI）
    return parentGate(Object.assign({}, req, {
      detail: '[fork:' + forkId + '] ' + (req.detail || ''),
      forkId
    }))
  }
}

/**
 * 通用 sidechain 循环
 */
async function runSidechainLoop (projectRoot, opts = {}) {
  const { getToolDefinitions, executeTool, isReadonlyTool } = getToolsApi()
  const permissionMode = opts.permissionMode || 'bubble' // bubble | plan | acceptEdits
  const writable = permissionMode === 'acceptEdits' || (permissionMode === 'bubble' && opts.writable !== false && opts.parentMode !== 'plan')
  const tools = getToolDefinitions().filter(t => {
    const n = t.function && t.function.name
    if (n === 'agent_fork' || n === 'agent_resume') return false // 防递归 fork
    if (!writable) return isReadonlyTool(n)
    return true
  })

  const readFileState = cloneReadFileState(opts.readFileState)
  const requirePermission = permissionMode === 'bubble' && opts.parentRequirePermission
    ? createBubblePermission(opts.parentRequirePermission, opts.sendEvent, opts.forkId || 'fork')
    : (permissionMode === 'acceptEdits' || opts.autoApprove
      ? async () => true
      : opts.parentRequirePermission || null)

  const runtime = {
    projectRoot,
    mode: writable ? 'default' : 'plan',
    todos: [],
    readFileState,
    sessionId: opts.forkId,
    sendEvent: opts.sendEvent || (() => {}),
    requirePermission: requirePermission || undefined,
    context: Object.assign({}, opts.parentContext || {}, { model: opts.model })
  }

  let messages = []
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt })
  } else {
    messages.push({
      role: 'system',
      content: [
        '你是 Fork 子 Agent（sidechain）。',
        writable ? '可写：继承父级权限闸门（bubble）。' : '只读 Plan。',
        '禁止再次 agent_fork。完成后给出结论。',
        FORK_TAG
      ].join('\n')
    })
  }

  // 继承父对话（去掉 system，避免重复）
  const parentMsgs = filterIncompleteToolCalls(opts.forkContextMessages || [])
    .filter(m => m.role !== 'system')
    .map(m => {
      // 截断过大 content
      if (typeof m.content === 'string' && m.content.length > 12000) {
        return Object.assign({}, m, { content: m.content.slice(0, 12000) + '\n…[fork截断]' })
      }
      return m
    })
    .slice(-30)
  messages = messages.concat(parentMsgs)

  // 本 fork 指令
  messages.push({
    role: 'user',
    content: FORK_TAG + '\n【Fork 指令】' + (opts.goal || '') + '\n请在继承的上下文上执行，不要重复询问已知背景。'
  })

  if (isInForkChild(opts.forkContextMessages || []) && opts.forbidNested !== false) {
    return {
      text: '拒绝：已在 Fork 子 Agent 内，禁止递归 fork。',
      messages,
      readFileStateEntries: serializeReadFileState(readFileState)
    }
  }

  let finalText = ''
  const maxRounds = opts.maxRounds || 12
  const model = opts.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat'

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal && opts.signal.aborted) {
      finalText = 'Fork 已取消'
      break
    }
    const result = await callDeepseekChat({
      model,
      messages: sanitizeMessagesForApi(messages),
      tools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.2,
      stream: false,
      signal: opts.signal
    })
    const msg = result.message || {}
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const text = (msg.content && String(msg.content).trim()) || ''
    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined
    })
    if (!toolCalls.length) {
      finalText = text || finalText || '（无输出）'
      break
    }
    for (const tc of toolCalls) {
      const fn = tc.function || {}
      let args = {}
      try { args = JSON.parse(fn.arguments || '{}') } catch (e) { args = {} }
      if (!writable && !isReadonlyTool(fn.name)) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '当前 Fork 为只读，禁止 ' + fn.name })
        continue
      }
      if (fn.name === 'agent_fork' || fn.name === 'agent_resume') {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '禁止递归 fork' })
        continue
      }
      const out = await executeTool(fn.name, args, runtime)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out.content || '').slice(0, 16000) })
    }
    finalText = text
  }

  return {
    text: finalText,
    messages,
    readFileStateEntries: serializeReadFileState(runtime.readFileState)
  }
}

/**
 * @param {string} projectRoot
 * @param {object} opts
 * @param {string} opts.goal
 * @param {string} [opts.type] explore|plan|verify|general|implementer|fork
 * @param {Array} [opts.forkContextMessages] 父 sidechain
 * @param {Map|Array} [opts.readFileState]
 * @param {Function} [opts.parentRequirePermission]
 * @param {string} [opts.parentMode]
 * @param {object} [opts.parentContext]
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.model] inherit → 用 parent
 * @param {string} [opts.permissionMode] bubble|plan|acceptEdits
 * @param {boolean} [opts.writable]
 * @param {string} [opts.parentSessionId]
 * @param {Function} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
async function runFork (projectRoot, opts = {}) {
  const type = String(opts.type || 'fork').toLowerCase()
  const goal = String(opts.goal || '').trim()
  if (!goal) throw new Error('fork goal 为空')

  const id = 'fork_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 5)
  const model = (!opts.model || opts.model === 'inherit')
    ? ((opts.parentContext && opts.parentContext.model) || process.env.DEEPSEEK_MODEL || 'deepseek-chat')
    : opts.model

  let permissionMode = opts.permissionMode || 'bubble'
  if (type === 'explore' || type === 'plan' || type === 'verify') permissionMode = 'plan'
  if (type === 'implementer') permissionMode = opts.permissionMode || 'bubble'

  // 自定义 Agent：.panda/agents/<type>.md
  let customPrompt = opts.systemPrompt || ''
  try {
    const custom = await require('./customAgents').getCustomAgent(projectRoot, type)
    if (custom) {
      customPrompt = (custom.prompt || '') + (customPrompt ? '\n\n' + customPrompt : '')
      if (custom.permissionMode) permissionMode = custom.permissionMode
      if (custom.model && custom.model !== 'inherit' && !opts.model) {
        opts.model = custom.model
      }
    }
  } catch (e) { /* ignore */ }

  const fork = {
    id,
    type,
    goal,
    parentSessionId: opts.parentSessionId || null,
    status: 'running',
    createdAt: new Date().toISOString(),
    result: null,
    messages: [],
    model,
    permissionMode,
    readFileStateEntries: serializeReadFileState(opts.readFileState)
  }
  forks.set(key(projectRoot, id), fork)
  if (opts.onProgress) opts.onProgress('fork', 'sidechain ' + type + '…')

  try {
    const hooks = require('./hooks')
    const hs = await hooks.runSubagentStartHooks(projectRoot, {
      agentId: id,
      agentType: type,
      goal
    }, { sessionId: opts.parentSessionId || id, permissionMode })
    if (hs && hs.deny) {
      fork.status = 'error'
      fork.result = 'SubagentStart hook 拒绝：' + (hs.denyMessage || '')
      fork.finishedAt = new Date().toISOString()
      await persist(projectRoot, fork)
      return { id, type, result: fork.result, status: fork.status, permissionMode, model }
    }
  } catch (e) { /* ignore */ }

  let result = ''
  try {
    // 专用类型仍可用轻量子代理，但带上 goal；有父上下文时走完整 sidechain
    const useSidechain = type === 'fork' || type === 'general' || type === 'implementer' ||
      (opts.forkContextMessages && opts.forkContextMessages.length) ||
      !!customPrompt

    if (!useSidechain && type === 'explore') {
      result = await runExploreAgent(goal, projectRoot)
      fork.messages = [{ role: 'assistant', content: result }]
    } else if (!useSidechain && type === 'plan') {
      result = await runPlanAgent(goal, projectRoot, '')
      fork.messages = [{ role: 'assistant', content: result }]
    } else if (!useSidechain && type === 'verify') {
      result = await runVerifyAgent(goal, projectRoot, [])
      fork.messages = [{ role: 'assistant', content: result }]
    } else {
      const r = await runSidechainLoop(projectRoot, {
        goal,
        forkId: id,
        forkContextMessages: opts.forkContextMessages || [],
        readFileState: opts.readFileState,
        parentRequirePermission: opts.parentRequirePermission,
        parentMode: opts.parentMode,
        parentContext: opts.parentContext,
        systemPrompt: customPrompt || opts.systemPrompt,
        model,
        permissionMode,
        writable: type === 'implementer' || permissionMode === 'acceptEdits' || permissionMode === 'bubble',
        maxRounds: opts.maxRounds || 12,
        signal: opts.signal,
        sendEvent: opts.sendEvent || ((ev, data) => {
          if (opts.onProgress && (ev === 'step' || ev === 'panda_block')) {
            opts.onProgress('fork', (data && (data.message || data.content)) || '')
          }
        })
      })
      result = r.text
      fork.messages = r.messages
      fork.readFileStateEntries = r.readFileStateEntries
    }
    fork.status = 'done'
    fork.result = result
  } catch (e) {
    fork.status = 'error'
    fork.result = 'Fork 失败：' + e.message
    result = fork.result
  }
  fork.finishedAt = new Date().toISOString()
  await persist(projectRoot, fork)
  try {
    const hooks = require('./hooks')
    await hooks.runSubagentStopHooks(projectRoot, {
      agentId: id,
      agentType: type,
      status: fork.status,
      result: fork.result
    }, { sessionId: opts.parentSessionId || id, permissionMode })
  } catch (e) { /* ignore */ }
  return { id, type, result: fork.result, status: fork.status, permissionMode, model }
}

async function resumeFork (projectRoot, id, followUp, opts = {}) {
  let fork = forks.get(key(projectRoot, id)) || await loadPersisted(projectRoot, id)
  if (!fork) return { ok: false, message: 'Fork 不存在：' + id }

  const goal = String(followUp || '').trim() || ('继续：' + fork.goal)
  fork.status = 'running'

  const r = await runSidechainLoop(projectRoot, {
    goal,
    forkId: id,
    forkContextMessages: fork.messages || [],
    readFileState: fork.readFileStateEntries,
    parentRequirePermission: opts.parentRequirePermission,
    parentMode: opts.parentMode,
    parentContext: opts.parentContext || { model: fork.model },
    model: fork.model,
    permissionMode: fork.permissionMode || 'bubble',
    writable: fork.type === 'implementer' || fork.permissionMode !== 'plan',
    maxRounds: opts.maxRounds || 8,
    signal: opts.signal,
    sendEvent: opts.sendEvent
  })

  fork.messages = r.messages
  fork.readFileStateEntries = r.readFileStateEntries
  fork.result = [
    '【先前结果】',
    String(fork.result || '').slice(0, 4000),
    '',
    '【继续】',
    r.text
  ].join('\n')
  fork.status = 'done'
  fork.finishedAt = new Date().toISOString()
  await persist(projectRoot, fork)
  return { ok: true, id, result: fork.result, status: fork.status }
}

function getFork (projectRoot, id) {
  return forks.get(key(projectRoot, id)) || null
}

function listForks (projectRoot) {
  const out = []
  for (const [k, f] of forks) {
    if (!k.startsWith(projectRoot + '::')) continue
    out.push({
      id: f.id,
      type: f.type,
      goal: f.goal,
      status: f.status,
      permissionMode: f.permissionMode,
      model: f.model,
      createdAt: f.createdAt,
      finishedAt: f.finishedAt
    })
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

module.exports = {
  runFork,
  resumeFork,
  getFork,
  listForks,
  loadPersisted,
  FORK_TAG,
  isInForkChild,
  cloneReadFileState
}
