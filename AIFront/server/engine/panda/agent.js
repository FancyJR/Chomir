/**
 * Panda Agent 主循环（对标 panda-code/query.ts）
 * 含：斜杠命令、Skills、子代理、并行只读工具、权限闸门、强制写码
 */

const path = require('path')
const fs = require('fs')
const { callDeepseekChat } = require('../shared-llm')
const { getToolDefinitions, executeTool, isReadonlyTool } = require('./tools')
const { createMemory } = require('./memory')
const { isVerifyAgentCall } = require('./subagents')
const { maybeCompactMessages, estimateTokens, getBlockingLimit, getMessagesAfterCompactBoundary, isPromptTooLongError, reactiveCompactOnOverflow } = require('./compact')
const { sanitizeMessagesForApi } = require('./messageSanitize')
const { appendTranscript, touchSessionMeta, loadSessionContext, saveSessionContext, serializeReadFileState, restoreReadFileState, extractPersistableMessages } = require('./session')
const { loadSkills, skillsPromptBlock } = require('./skills')
const { tryHandleSlash } = require('./slash')
const { createPermissionGate } = require('./permissionGate')
const { runExploreAgent } = require('./subagents')
const abortRegistry = require('./abortRegistry')
const cost = require('./cost')
const hooks = require('./hooks')
const { buildSystemPrompt } = require('./prompts')
const { collectTurnAttachments, collectSoftCandidatePaths, getChangedFileAttachments, formatAttachmentMessages, getGitStatusSnippet } = require('./attachments')
const { withApiRetry } = require('./apiRetry')
const failureFuse = require('./failureFuse')
const {
  isKeepGoingMessage,
  decideContinueWithoutTools,
  keepGoingUserNudge,
  incompleteTodos
} = require('./continueGate')

const DEFAULT_MAX_ROUNDS = parseInt(process.env.PANDA_AGENT_MAX_ROUNDS || process.env.CLAW_AGENT_MAX_ROUNDS, 10) || 40
const MAX_AUTO_CONTINUES = parseInt(process.env.PANDA_MAX_AUTO_CONTINUES || process.env.CLAW_MAX_AUTO_CONTINUES, 10) || 8

function resolveMaxTokens (model) {
  const fromEnv = parseInt(process.env.DEEPSEEK_MAX_TOKENS, 10)
  if (fromEnv > 0) return fromEnv
  const name = String(model || process.env.DEEPSEEK_MODEL || '')
  if (/v4|reason|flash/i.test(name)) return 32768
  return 8192
}

function normalizeHistory (history) {
  if (!Array.isArray(history)) return []
  const out = []
  for (const m of history) {
    if (!m || !m.role) continue
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
      out.push({ role: m.role, content: String(m.content).slice(0, 6000) })
    }
  }
  return out.slice(-24)
}

function toolFacingName (name) {
  const map = {
    read_file: 'Read', write_file: 'Write', edit_file: 'Edit', apply_patch: 'Patch', edit_lines: 'EditLines',
    glob: 'Glob', grep: 'Grep',
    bash: 'Bash', web_fetch: 'WebFetch', web_search: 'WebSearch', todo_write: 'Todo',
    ask_user: 'AskUser', enter_plan_mode: 'EnterPlan', exit_plan_mode: 'ExitPlan',
    memory_read: 'MemoryRead', memory_append: 'MemoryAppend',
    Agent: 'Agent', agent: 'Agent',
    agent_explore: 'Explore', agent_plan: 'Plan', agent_verify: 'Verify',
    task_list: 'TaskList', task_create: 'TaskCreate',
    task_update: 'TaskUpdate', task_get: 'TaskGet', skill: 'Skill', tool_search: 'ToolSearch', undo_file: 'Undo',
    notebook_edit: 'NotebookEdit',
    diagnostics: 'Diagnostics', browser_console: 'BrowserConsole', capture_page: 'CapturePage', sleep: 'Sleep',
    mcp_connect: 'MCPConnect', mcp_list: 'MCPList', mcp_call: 'MCPCall',
    mcp_resources: 'MCPResources', mcp_read_resource: 'MCPRead',
    enter_worktree: 'EnterWorktree', exit_worktree: 'ExitWorktree',
    config_get: 'ConfigGet', config_set: 'ConfigSet', brief: 'Brief',
    coordinator: 'Coordinator', bash_bg: 'BashBG', task_output: 'TaskOutput',
    task_stop: 'TaskStop', task_bg_list: 'TaskBGList',
    team_create: 'TeamCreate', team_delete: 'TeamDelete', team_list: 'TeamList',
    send_message: 'SendMessage', team_run_member: 'TeamRun',
    cron_create: 'CronCreate', cron_list: 'CronList', cron_delete: 'CronDelete',
    cron_tick: 'CronTick', repl: 'REPL',
    lsp_diagnostics: 'LSP', swarm_run: 'Swarm', swarm_list: 'SwarmList', swarm_get: 'SwarmGet',
    agent_fork: 'AgentFork', agent_resume: 'AgentResume', agent_list: 'AgentList'
  }
  return map[name] || (String(name).startsWith('mcp__') ? name.replace(/^mcp__/, 'MCP/') : name)
}

function toolDetail (name, args) {
  if (!args) return ''
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'apply_patch' || name === 'edit_lines' || name === 'undo_file' || name === 'lsp_diagnostics' || name === 'notebook_edit') {
    return args.path || args.notebook_path || ''
  }
  if (name === 'task_get') return args.id || args.taskId || ''
  if (name === 'grep' || name === 'glob' || name === 'web_search' || name === 'tool_search') return args.pattern || args.query || ''
  if (name === 'browser_console') return args.query || args.level || ''
  if (name === 'capture_page') return args.route || args.url || ''
  if (name === 'bash') return String(args.command || '').slice(0, 80)
  if (name === 'skill') return args.id || ''
  if (name === 'ask_user') return String(args.question || '').slice(0, 80)
  if (name === 'Agent' || name === 'agent') {
    const t = args.subagent_type || args.type || ''
    return (t ? t + ' · ' : '') + String(args.prompt || args.goal || '').slice(0, 60)
  }
  if (name === 'agent_explore' || name === 'agent_plan' || name === 'agent_verify') {
    return String(args.goal || args.prompt || '').slice(0, 80)
  }
  if (name === 'mcp_call') return (args.server || '') + '/' + (args.tool || '')
  if (String(name || '').startsWith('mcp__')) return String(name).replace(/^mcp__/, '').slice(0, 80)
  if (name === 'swarm_run') return String(args.goal || '').slice(0, 80)
  if (name === 'swarm_get') return args.id || ''
  return JSON.stringify(args).slice(0, 80)
}

async function runPandaAgent (params) {
  const message = (params.message || '').trim()
  const projectInfo = params.projectInfo || {}
  const context = params.context || {}
  const sendEventRaw = typeof params.sendEvent === 'function' ? params.sendEvent : () => {}
  const projectRoot = projectInfo.root || path.resolve(__dirname, '..', '..', '..')
  const modelRaw = (context.model && String(context.model)) || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  // 对齐 panda-code ultrathink / effort：提高审议深度（DeepSeek 用 reasoner）
  const wantsUltrathink = /\bultrathink\b|反复思考|深度思考|仔细想/i.test(message || '')
  const effort = String(context.effort || '').toLowerCase()
  const model = (wantsUltrathink || effort === 'high' || effort === 'max')
    ? (process.env.DEEPSEEK_REASONER_MODEL || 'deepseek-reasoner')
    : modelRaw
  if (model !== modelRaw) {
    // sendEvent not ready yet — noted after bridge init below via runtime
  }
  const sessionId = context.sessionId || context.pandaSessionId || ('sess_' + Date.now().toString(16))
  // Prefer explicit params / request context / .panda/config.json over hardcoded 48
  let configuredMax = 0
  try {
    const cfgMax = await require('./config').get(projectRoot, 'maxRounds')
    configuredMax = parseInt(cfgMax, 10) || 0
  } catch (e) { /* ignore */ }
  const maxRounds = Math.min(80, Math.max(1,
    parseInt(params.maxRounds, 10) ||
    parseInt(context.maxRounds, 10) ||
    configuredMax ||
    DEFAULT_MAX_ROUNDS
  ))
  const bridge = require('./bridge')
  const sendEvent = (event, data) => {
    sendEventRaw(event, data)
    try { bridge.bridgeSendEvent(sessionId, event, Object.assign({}, data || {})) } catch (e) { /* ignore */ }
  }

  if (model !== modelRaw) {
    sendEvent('panda_block', {
      type: 'system',
      content: 'effort/ultrathink → model `' + model + '`'
    })
  }

  // 每轮吞入前端带来的控制台快照，供 browser_console 工具读取
  try {
    const browserConsole = require('./browserConsole')
    if (Array.isArray(context.browserConsole) && context.browserConsole.length) {
      browserConsole.ingest(context.browserConsole, sessionId)
    }
  } catch (e) { /* ignore */ }

  // 尽早注册 abort，避免停止按钮在模型调用前无效
  const abortCtrl = abortRegistry.beginRun(sessionId)
  const signal = abortCtrl.signal

  const memory = createMemory(projectRoot)
  const memoryText = await memory.loadForPrompt({ excludeSessionId: sessionId, currentSessionId: sessionId })
  const skills = await loadSkills(projectRoot)
  const skillsBlock = skillsPromptBlock(skills)
  const focusFile = context.activeFile || context.preferredFile || ''
  const gitStatus = getGitStatusSnippet(projectRoot)

  const scratchpad = require('./scratchpad')
  await scratchpad.ensureScratchpad(projectRoot, sessionId)
  const scratchpadSection = scratchpad.getScratchpadSection(projectRoot, sessionId)

  const sessionMemory = require('./sessionMemory')
  const sessionMemoryText = await sessionMemory.readSessionMemory(projectRoot, sessionId)
  const sessionMemorySection = sessionMemory.getSessionMemorySection(sessionMemoryText)

  let projectSnapshot = ''
  try {
    projectSnapshot = await require('./projectSnapshot').buildProjectSnapshot(projectRoot)
  } catch (e) { /* ignore */ }

  const cfgAll = await require('./config').getAll(projectRoot)
  const outputStyles = require('./outputStyles')
  const styleName = (context && context.outputStyle) || cfgAll.outputStyle || 'default'
  const language = (context && context.language) || cfgAll.language || '简体中文'
  const outputStyleConfig = await outputStyles.resolveOutputStyle(projectRoot, styleName)

  const sessCtx = await loadSessionContext(projectRoot, sessionId)
  const restoredTodos = Array.isArray(sessCtx.todos) ? sessCtx.todos : []
  const runtime = {
    projectRoot,
    mode: context.planMode ? 'plan' : 'default',
    todos: restoredTodos.slice(),
    memory,
    lastPlan: '',
    changedFiles: Array.isArray(sessCtx.changedFiles) ? sessCtx.changedFiles.slice() : [],
    didVerify: false,
    requestCompact: false,
    sendEvent,
    sessionId,
    context,
    signal,
    readFileState: restoreReadFileState(sessCtx.readFileState),
    requirePermission: null,
    exploreFn: (goal) => runExploreAgent(goal, projectRoot),
    sidechainMessages: normalizeHistory(context.history || context.chatHistory),
    currentToolCallId: null,
    permissionMode: 'acceptEdits',
    lastUserGoal: sessCtx.lastUserGoal || message,
    pendingVisionAttachments: [],
    pendingDiagErrors: false,
    pendingDiagSummary: '',
    pendingCommandFail: false,
    pendingCommandSummary: '',
    healCount: 0,
    lastEditFailed: false,
    verifyFailed: false,
    verifyPartial: false,
    verifyAttempts: 0,
    lastContinueReason: null,
    didMemoryAppend: false,
    language,
    outputStyle: styleName
  }

  // 权限模式（对齐 panda-code PermissionMode）：
  // default | acceptEdits | plan | bypassPermissions | auto | dontAsk
  // 显式 context.permissionMode 优先于 PANDA_YOLO 环境变量
  const rawMode = String(
    context.permissionMode ||
    process.env.PANDA_PERMISSION_MODE ||
    process.env.CLAW_PERMISSION_MODE ||
    ''
  ).trim()
  let permissionMode = 'acceptEdits'
  if (rawMode === 'auto') {
    permissionMode = 'auto'
  } else if (rawMode === 'dontAsk') {
    permissionMode = 'dontAsk'
  } else if (rawMode === 'bypassPermissions' || rawMode === 'yolo' ||
      context.autoApprove === 'all' ||
      (!rawMode && (process.env.PANDA_YOLO === '1' || process.env.CLAW_YOLO === '1'))) {
    permissionMode = 'bypassPermissions'
  } else if (rawMode === 'default' || context.autoApprove === false || context.autoApprove === 'false' ||
      context.requirePermission === true || process.env.CLAW_REQUIRE_PERMISSION === '1') {
    permissionMode = 'default'
  } else if (rawMode === 'plan') {
    permissionMode = 'plan'
    runtime.mode = 'plan'
  } else if (rawMode === 'acceptEdits' || context.autoApprove === true) {
    permissionMode = 'acceptEdits'
  } else if (process.env.PANDA_YOLO === '1' || process.env.CLAW_YOLO === '1') {
    permissionMode = 'bypassPermissions'
  } else {
    permissionMode = 'acceptEdits'
  }
  // YOLO 不再等于「绝对跳过」；bypass=过规则放行，auto=分类器
  runtime.permissionMode = permissionMode
  // skip 仅表示默认倾向放行（已废弃，闸门走 evaluatePermission）
  runtime.skipPermissions = false
  runtime.sessionAllowRules = Array.isArray(context.sessionAllowRules) ? context.sessionAllowRules.slice() : []
  runtime.sessionDenyRules = Array.isArray(context.sessionDenyRules) ? context.sessionDenyRules.slice() : []
  try { require('./sessionRuntime').register(sessionId, runtime) } catch (e) { /* ignore */ }

  // SessionStart hooks：每个 sessionId 只跑一次（new/resume），避免每轮用户消息重复触发
  try {
    const hooks = require('./hooks')
    const sessionRuntime = require('./sessionRuntime')
    const live = sessionRuntime.get(sessionId) || runtime
    if (!(live && live._sessionStartHooksDone)) {
      const isNew = !(sessCtx && (sessCtx.recentMessages || []).length)
      const ss = await hooks.runSessionStartHooks(projectRoot, runtime, isNew ? 'new' : 'resume')
      runtime._sessionStartHooksDone = true
      try { sessionRuntime.applyPatch(sessionId, { _sessionStartHooksDone: true }) } catch (e2) { /* ignore */ }
      if (ss.notes && ss.notes.length) {
        sendEvent('panda_block', { type: 'system', content: 'Hook(SessionStart): ' + ss.notes.join(' | ') })
      }
      if (ss.deny) {
        abortRegistry.endRun(sessionId)
        const msg = 'SessionStart hook 拒绝启动：' + (ss.denyMessage || '')
        sendEvent('panda_block', { type: 'assistant_text', content: msg })
        sendEvent('answer_done', {})
        return { text: msg, changed: [], sessionId, mode: runtime.mode }
      }
    }
  } catch (e) { /* ignore */ }

  const permissionRules = require('./permissionRules')
  const baseGate = createPermissionGate(sendEvent, {
    autoApprove: false,
    signal,
    timeoutMs: Number(process.env.PANDA_PERM_TIMEOUT_MS || 0) || 0,
    sessionId
  })
  // 必须读 runtime.permissionMode（exit_plan / Shift+Tab 会热更新），勿闭包回合开始时的常量
  runtime.requirePermission = async (req) => {
    const risk = (req && req.risk) || 'write'
    const liveMode = runtime.permissionMode || permissionMode
    const decision = await permissionRules.evaluatePermission({
      projectRoot,
      tool: req.tool,
      args: req.args,
      detail: req.detail,
      risk,
      permissionMode: liveMode,
      sessionAllow: runtime.sessionAllowRules,
      sessionDeny: runtime.sessionDenyRules,
      sessionId,
      messages: runtime.sidechainMessages || []
    })

    if (decision.behavior === 'deny') {
      sendEvent('panda_block', {
        type: 'system',
        content: '权限拒绝：' + (decision.reason || req.tool)
      })
      sendEvent('panda_status', {
        message: '已拒绝：' + (decision.reason || '').slice(0, 120),
        phase: 'permission_denied'
      })
      return false
    }

    if (decision.behavior === 'allow') {
      return true
    }

    // PermissionRequest hooks：可直接 allow/deny，跳过 UI
    try {
      const hooks = require('./hooks')
      const ph = await hooks.runPermissionRequestHooks(projectRoot, req, runtime)
      if (ph.notes && ph.notes.length) {
        sendEvent('panda_block', { type: 'system', content: 'Hook(PermissionRequest): ' + ph.notes.join(' | ') })
      }
      if (ph.deny) {
        sendEvent('panda_block', {
          type: 'system',
          content: 'PermissionRequest hook 拒绝：' + (ph.denyMessage || req.tool)
        })
        return false
      }
      if (ph.allowOverride) {
        sendEvent('panda_block', {
          type: 'system',
          content: 'PermissionRequest hook 放行：' + (req.tool || '')
        })
        return true
      }
    } catch (e) { /* ignore */ }

    // ask（含 bypass/auto 下 forceAsk / safetyCheck）
    sendEvent('panda_status', {
      message: '等待权限确认：' + (req.tool || '') + (req.detail ? ' · ' + req.detail : ''),
      phase: 'permission',
      tool: req.tool,
      detail: req.detail,
      reason: decision.reason,
      forceAsk: !!decision.forceAsk
    })
    if (runtime.currentToolCallId) {
      sendEvent('panda_block', {
        type: 'tool_status',
        id: runtime.currentToolCallId,
        status: 'awaiting_permission'
      })
    }
    const allowed = await baseGate({
      ...req,
      forceAsk: !!(decision.forceAsk || req.forceAsk),
      reason: decision.reason || req.reason || '',
      suggestions: decision.suggestions || []
    })
    if (runtime.currentToolCallId) {
      sendEvent('panda_block', {
        type: 'tool_status',
        id: runtime.currentToolCallId,
        status: allowed ? 'running' : 'error'
      })
    }
    return allowed
  }

  // 焦点文件仅进 system snippet，不伪造 readFileState（必须真 read_file）

  const persistContext = async (msgs, wipe = false) => {
    try {
      if (wipe) {
        await saveSessionContext(projectRoot, sessionId, {
          permissionMode: runtime.permissionMode,
          readFileState: [],
          recentMessages: [],
          todos: [],
          lastUserGoal: '',
          changedFiles: []
        })
        runtime.todos = []
        runtime.changedFiles = []
        runtime.lastUserGoal = ''
        runtime.didVerify = false
        runtime.readFileState = new Map()
        return
      }
      await saveSessionContext(projectRoot, sessionId, {
        permissionMode: runtime.permissionMode,
        readFileState: serializeReadFileState(runtime.readFileState),
        recentMessages: extractPersistableMessages(msgs || runtime.sidechainMessages || []),
        todos: runtime.todos || [],
        lastUserGoal: runtime.lastUserGoal || message,
        changedFiles: runtime.changedFiles || []
      })
    } catch (e) { /* ignore */ }
  }

  // 斜杠命令短路
  const slash = await tryHandleSlash(message, runtime)
  if (slash && slash.handled) {
    abortRegistry.endRun(sessionId)
    try { require('./sessionRuntime').unregister(sessionId) } catch (e2) { /* ignore */ }
    sendEvent('panda_block', { type: 'user', content: message, sessionId })
    if (!(slash.sideEffects && slash.sideEffects.clearUi)) {
      sendEvent('panda_block', { type: 'assistant_text', content: slash.reply })
    }
    if (slash.sideEffects && slash.sideEffects.clearUi) {
      sendEvent('panda_clear', {})
      await persistContext([], true)
      const clearReply = '已清空会话上下文（对齐 panda-code /clear）：历史工具回合、todos、目标与改动列表已重置。请直接说新任务。'
      sendEvent('panda_block', { type: 'assistant_text', content: clearReply })
      sendEvent('answer_done', {})
      await appendTranscript(projectRoot, sessionId, { type: 'user', content: message })
      await appendTranscript(projectRoot, sessionId, { type: 'assistant', content: clearReply })
      await touchSessionMeta(projectRoot, sessionId, { title: '新任务', lastMessage: clearReply.slice(0, 80) })
      return { text: clearReply, changed: [], sessionId, mode: runtime.mode }
    }
    if (slash.sideEffects && slash.sideEffects.changed) {
      sendEvent('done', { kind: 'panda_agent', changed: slash.sideEffects.changed, sessionId })
    }
    sendEvent('answer_done', {})
    await appendTranscript(projectRoot, sessionId, { type: 'user', content: message })
    await appendTranscript(projectRoot, sessionId, { type: 'assistant', content: slash.reply })
    await touchSessionMeta(projectRoot, sessionId, { title: message.slice(0, 40), lastMessage: slash.reply.slice(0, 80) })
    await persistContext([])
    return { text: slash.reply, changed: (slash.sideEffects && slash.sideEffects.changed) || [], sessionId, mode: runtime.mode }
  }

  // UserPromptSubmit hooks
  try {
    const hooks = require('./hooks')
    const up = await hooks.runUserPromptSubmitHooks(projectRoot, message, runtime)
    if (up.notes && up.notes.length) {
      sendEvent('panda_block', { type: 'system', content: 'Hook(UserPromptSubmit): ' + up.notes.join(' | ') })
    }
    if (up.deny) {
      abortRegistry.endRun(sessionId)
      const msg = 'UserPromptSubmit hook 拒绝本轮：' + (up.denyMessage || '')
      sendEvent('panda_block', { type: 'assistant_text', content: msg })
      sendEvent('answer_done', {})
      return { text: msg, changed: [], sessionId, mode: runtime.mode }
    }
  } catch (e) { /* ignore */ }

  // MCP：自动连接并挂载 mcp__server__tool（对标 panda-code）
  let mcpTools = []
  try {
    const mcpMod = require('./mcp')
    const ens = await mcpMod.ensureConnected(projectRoot)
    mcpTools = mcpMod.getOpenAiToolDefinitions(projectRoot)
    if (mcpTools.length) {
      sendEvent('panda_block', {
        type: 'system',
        content: 'MCP 已挂载 ' + mcpTools.length + ' 个工具：' +
          mcpTools.map(t => t.function.name).slice(0, 12).join(', ') +
          (mcpTools.length > 12 ? '…' : '')
      })
    } else if (ens && ens.results && ens.results.some(r => !r.ok)) {
      const fails = ens.results.filter(r => !r.ok).map(r => r.name + ':' + r.error).slice(0, 3)
      sendEvent('panda_block', {
        type: 'system',
        content: 'MCP 部分连接失败：' + fails.join('；')
      })
    }
    const pending = mcpMod.getPendingOAuth()
    const pendNames = Object.keys(pending || {})
    if (pendNames.length) {
      sendEvent('panda_mcp_oauth', { pending })
      sendEvent('panda_block', {
        type: 'system',
        content: 'MCP OAuth 待授权：' + pendNames.map(n => n + ' → ' + pending[n].url).join('\n')
      })
    }
  } catch (e) {
    sendEvent('panda_block', {
      type: 'system',
      content: 'MCP 自动连接跳过：' + (e.message || e)
    })
  }

  const tools = getToolDefinitions({ mcpTools })
  let messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        projectInfo,
        context,
        memoryText,
        mode: runtime.mode,
        skillsBlock,
        gitStatus,
        language: runtime.language,
        outputStyleConfig,
        scratchpadSection,
        sessionMemorySection,
        projectSnapshot
      })
    }
  ]
  // 跨轮：优先用会话持久化的 API messages（含 tool_calls），再拼前端短历史
  const persisted = Array.isArray(sessCtx.recentMessages) ? sessCtx.recentMessages : []
  if (persisted.length) {
    messages = messages.concat(sanitizeMessagesForApi(persisted))
  } else {
    messages = messages.concat(normalizeHistory(context.history || context.chatHistory))
  }

  // 对齐 processUserInput：附件（@文件 / IDE 打开路径 / 选区 / 软候选路径）→ 再用户正文。无 IntentRouter。
  const turnAttachments = collectTurnAttachments(message, context, projectRoot)
    .concat(collectSoftCandidatePaths(context, projectRoot))
  const attachmentMsgs = formatAttachmentMessages(turnAttachments)
  if (attachmentMsgs.length) {
    messages = messages.concat(attachmentMsgs)
    const kinds = turnAttachments.map(a => a.type).join(', ')
    sendEvent('panda_block', {
      type: 'system',
      content: 'attachments: ' + kinds
    })
  }

  // 跨用户消息：对齐 panda-code — 不强制旧 todos；「继续」才续旧目标
  const keepGoing = isKeepGoingMessage(message)
  let userContent = message
  if (keepGoing) {
    userContent = keepGoingUserNudge(sessCtx.lastUserGoal || message)
    if (restoredTodos.length && incompleteTodos(restoredTodos).length) {
      messages.push({
        role: 'user',
        content: '【Keep going · 恢复未完成 todos】\n' +
          incompleteTodos(restoredTodos).map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n'),
        _attachment: true
      })
    }
    sendEvent('panda_block', { type: 'system', content: 'keep going · resume prior goal' })
  } else {
    // 新请求 = 新目标：清空粘性 todos/changedFiles，避免旧任务污染理解（对标 panda 不清主题检测，但不硬锚旧清单）
    const stale = incompleteTodos(restoredTodos)
    runtime.todos = []
    runtime.changedFiles = []
    runtime.didVerify = false
    runtime.lastUserGoal = message
    if (stale.length) {
      messages.push({
        role: 'user',
        content: [
          '【软提示】会话中曾有未完成 todos，可能与当前请求无关（may or may not be related）。',
          '务必以最新用户消息为准；无关请忽略。若要接着旧任务，请用户说「继续」。',
          '旧 todos（仅供参考，勿自动续做）：',
          ...stale.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
        ].join('\n'),
        _attachment: true
      })
      sendEvent('panda_block', {
        type: 'system',
        content: 'stale todos demoted · prefer latest ask'
      })
    }
  }
  const hasUserImages = Array.isArray(context.images) && context.images.length > 0
  let multimodalUserMessage = null
  if (hasUserImages) {
    try {
      const imageUpload = require('./imageUpload')
      const built = await imageUpload.buildMultimodalUserMessage(
        projectRoot,
        userContent || message,
        context.images
      )
      if (built.hasImages && built.multimodal) {
        multimodalUserMessage = built.message
        userContent = built.textFallback
        sendEvent('panda_block', {
          type: 'system',
          content: '已附带 ' + built.saved.length + ' 张图片 · 多模态 `' + built.model + '`'
        })
      } else if (built.hasImages) {
        userContent = built.textFallback
        sendEvent('panda_block', {
          type: 'system',
          content: '已保存 ' + built.saved.length + ' 张图片（当前模型不支持多模态，仅注入路径文本）'
        })
      }
    } catch (e) {
      userContent += '\n\n（图片处理失败：' + e.message + '）'
    }
  }

  if (multimodalUserMessage) {
    if (Array.isArray(multimodalUserMessage.content)) {
      const textIdx = multimodalUserMessage.content.findIndex(c => c && c.type === 'text')
      if (textIdx >= 0) multimodalUserMessage.content[textIdx].text = userContent
    }
    messages.push(multimodalUserMessage)
  } else {
    messages.push({ role: 'user', content: userContent })
  }

  // 仅当多模态真正可用时才切视觉模型
  let effectiveModel = model
  if (multimodalUserMessage) {
    try {
      const imageUpload = require('./imageUpload')
      const vision = imageUpload.defaultVisionModel()
      if (vision && imageUpload.modelSupportsMultimodal(vision)) {
        effectiveModel = vision
        if (runtime.context) runtime.context.model = vision
      }
    } catch (e) { /* keep chat model */ }
  }
  runtime.sidechainMessages = messages
  runtime.parentSystemPrompt = messages[0] && messages[0].content

  sendEvent('panda_block', { type: 'user', content: message, sessionId })
  await appendTranscript(projectRoot, sessionId, { type: 'user', content: message })
  await touchSessionMeta(projectRoot, sessionId, { title: message.slice(0, 40), lastMessage: message.slice(0, 80) })

  const changed = []
  const noteChangedFile = (file) => {
    const f = String(file || '').trim()
    if (!f) return
    if (changed.some(c => c.file === f)) return
    changed.push({ file: f })
    // 与会话持久化的 changedFiles 合并去重
    const prev = Array.isArray(runtime.changedFiles) ? runtime.changedFiles : []
    const merged = []
    const seen = new Set()
    for (const item of prev.concat(changed)) {
      const key = String((item && item.file) || item || '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push({ file: key })
    }
    runtime.changedFiles = merged
  }
  let finalText = ''
  let askUser = null
  let wroteSomething = false
  let streamTextId = null
  let streamThinkId = null
  let autoContinueCount = 0
  let hasAttemptedReactiveCompact = false
  const imageUpload = require('./imageUpload')

  const checkAbort = () => {
    if (signal.aborted || abortRegistry.isAborted(sessionId)) {
      const err = new Error('已取消')
      err.code = 'ABORTED'
      throw err
    }
  }

  const throwIfAborted = (e) => {
    if (abortRegistry.isAbortError(e) || signal.aborted || abortRegistry.isAborted(sessionId)) {
      const err = new Error('已取消')
      err.code = 'ABORTED'
      throw err
    }
  }

  /** prompt-too-long → compact → 再试一轮（整次 run 最多一次） */
  const tryReactiveCompactRetry = async (err, callOpts) => {
    if (!isPromptTooLongError(err) || hasAttemptedReactiveCompact) return null
    if (process.env.DISABLE_REACTIVE_COMPACT === '1') return null
    hasAttemptedReactiveCompact = true
    const rc = await reactiveCompactOnOverflow(messages, runtime, { keepLast: 8 })
    messages = rc.messages
    runtime.sidechainMessages = messages
    await persistContext(messages)
    checkAbort()
    const m = callOpts.model || effectiveModel
    return withApiRetry(() => callDeepseekChat({
      model: m,
      messages: sanitizeMessagesForApi(messages, {
        allowMultimodal: imageUpload.modelSupportsMultimodal(m)
      }),
      tools,
      tool_choice: 'auto',
      max_tokens: resolveMaxTokens(m),
      temperature: 0.2,
      signal,
      stream: false
    }), {
      signal,
      maxRetries: 3,
      onRetry: ({ attempt, delay, error }) => {
        sendEvent('panda_status', {
          message: 'API 重试 ' + attempt + ' · ' + Math.round(delay) + 'ms · ' + String((error && error.message) || '').slice(0, 80),
          phase: 'api_retry'
        })
      }
    })
  }

  const llmCall = (opts) => withApiRetry(() => callDeepseekChat(opts), {
    signal: opts.signal || signal,
    maxRetries: opts.stream ? 2 : 5,
    onRetry: ({ attempt, delay, error }) => {
      sendEvent('panda_status', {
        message: 'API 退避重试 ' + attempt + ' · ' + Math.round(delay) + 'ms',
        phase: 'api_retry',
        detail: String((error && error.message) || '').slice(0, 100)
      })
    }
  })

  try {
  for (let round = 0; round < maxRounds; round++) {
    checkAbort()
    // 运行中插话：本轮开头注入，避免整轮重开
    try {
      const steers = require('./sessionRuntime').drainSteer(sessionId)
      for (const s of steers) {
        const body = '【用户插话 / mid-turn steer】请优先按此纠正当前方向，不要重开任务：\n' + s.text
        messages.push({ role: 'user', content: body })
        sendEvent('panda_block', { type: 'user', content: s.text })
        sendEvent('panda_block', {
          type: 'system',
          content: '⇄ Steer injected · round ' + (round + 1)
        })
      }
      if (steers.length) {
        runtime.sidechainMessages = messages
        await persistContext(messages)
      }
    } catch (e) { /* ignore */ }
    // 只把 compact_boundary 之后的消息送给模型（对标 getMessagesAfterCompactBoundary）
    messages = getMessagesAfterCompactBoundary(messages)
    // 对标 getChangedFiles：磁盘相对 readFileState 已变 → 软注入 diff，强迫先 re-read
    try {
      const changedAtt = getChangedFileAttachments(runtime, runtime.projectRoot || projectRoot)
      if (changedAtt.length) {
        const chMsgs = formatAttachmentMessages(changedAtt)
        messages = messages.concat(chMsgs)
        sendEvent('panda_block', {
          type: 'system',
          content: 'changed_files: ' + changedAtt.map(a => a.path).join(', ')
        })
      }
    } catch (e) { /* ignore */ }
    if (runtime.requestCompact) {
      messages = await maybeCompactMessages(messages, { force: true, keepLast: 10 }, runtime)
      runtime.requestCompact = false
    } else {
      messages = await maybeCompactMessages(messages, { keepLast: 16 }, runtime)
    }
    runtime.sidechainMessages = messages
    await persistContext(messages)

    const tok = estimateTokens(messages)
    const blockLimit = getBlockingLimit()
    const contextPct = Math.min(100, Math.round((tok / Math.max(1, blockLimit)) * 100))
    sendEvent('panda_context', {
      tokens: tok,
      limit: blockLimit,
      pct: contextPct,
      permissionMode: runtime.permissionMode,
      mode: runtime.mode
    })
    if (tok >= blockLimit) {
      sendEvent('panda_block', {
        type: 'system',
        content: '⚠ 上下文接近上限 (~' + tok + ' tokens)。已尽量压缩；请开新会话或 /compact，并避免一次贴入超大文件。'
      })
      sendEvent('panda_status', {
        message: '上下文接近上限 ~' + tok + ' tok (' + contextPct + '%)',
        phase: 'context_warn',
        tokens: tok,
        pct: contextPct
      })
    }

    sendEvent('panda_round', { round: round + 1, mode: runtime.mode, maxRounds })
    // Cursor-style: never show "Round N" in the UI — just working status
    sendEvent('panda_status', {
      message: '调用模型…' + (tok > 8000 ? ' (~' + tok + ' tok · ' + contextPct + '%)' : ''),
      phase: 'llm',
      round: round + 1,
      maxRounds,
      tokens: tok,
      pct: contextPct
    })

    streamTextId = 'ast_' + Date.now().toString(16) + '_' + round
    streamThinkId = 'thk_' + Date.now().toString(16) + '_' + round
    let startedText = false
    let startedThink = false

    let result
    let activeModel = effectiveModel
    const messagesForApi = () => sanitizeMessagesForApi(messages, {
      allowMultimodal: imageUpload.modelSupportsMultimodal(activeModel)
    })
    let hbSec = 0
    const heartbeat = setInterval(() => {
      hbSec += 2
      sendEvent('panda_status', {
        message: '等待模型响应… ' + hbSec + 's（tools 场景下首包常较慢）',
        phase: 'llm_wait',
        elapsed: hbSec,
        round: round + 1
      })
    }, 2000)
    try {
      result = await llmCall({
        model: activeModel,
        messages: messagesForApi(),
        tools,
        tool_choice: 'auto',
        max_tokens: resolveMaxTokens(activeModel),
        temperature: 0.2,
        signal,
        stream: true,
        onDelta: (chunk) => {
          if (!startedText) {
            startedText = true
            sendEvent('panda_status', { message: '模型输出中…', phase: 'llm_stream', round: round + 1 })
            sendEvent('panda_block', { type: 'assistant_text', id: streamTextId, content: '', streaming: true })
          }
          sendEvent('panda_stream', { id: streamTextId, kind: 'text', chunk })
        },
        onThinking: (chunk) => {
          if (!startedThink) {
            startedThink = true
            sendEvent('panda_status', { message: '思考中…', phase: 'llm_thinking', round: round + 1 })
            sendEvent('panda_block', { type: 'thinking', id: streamThinkId, content: '', streaming: true })
          }
          sendEvent('panda_stream', { id: streamThinkId, kind: 'thinking', chunk })
        }
      })
    } catch (e) {
      throwIfAborted(e)

      // 1) prompt-too-long → reactive compact → 再试一轮（对标 query.ts）
      try {
        const recovered = await tryReactiveCompactRetry(e, { model: activeModel })
        if (recovered) {
          result = recovered
        } else {
          throw e
        }
      } catch (ePtl) {
        throwIfAborted(ePtl)
        if (isPromptTooLongError(ePtl)) {
          sendEvent('error', {
            message: '上下文仍然过长（reactive compact 后仍失败）。请 /clear 开新会话，或删减历史后再试。'
          })
          throw ePtl
        }

        // 2) 模型不接受 image_url / 视觉+tools：省略多模态后重试
        if (/image_url|unknown variant|deserialize|vision|unsupported|invalid|supported API model names|model names are/i.test(String(ePtl.message || e.message || ''))) {
          try {
            activeModel = model
            effectiveModel = model
            const stripped = sanitizeMessagesForApi(messages, { allowMultimodal: false })
            messages = stripped
            sendEvent('panda_block', {
              type: 'system',
              content: '模型不可用/不接受多模态 · 已省略 image_url · 降级 `' + activeModel + '`'
            })
            result = await llmCall({
              model: activeModel,
              messages: stripped,
              tools,
              tool_choice: 'auto',
              max_tokens: resolveMaxTokens(activeModel),
              temperature: 0.2,
              signal,
              stream: false
            })
          } catch (e2) {
            throwIfAborted(e2)
            const recovered2 = await tryReactiveCompactRetry(e2, { model: activeModel })
            if (recovered2) {
              result = recovered2
            } else {
              sendEvent('error', { message: e2.message || e.message || 'Panda Agent 模型调用失败' })
              throw e2
            }
          }
        } else {
          // 3) 流式失败 → 非流式；若仍 PTL 则 reactive compact
          if (signal.aborted || abortRegistry.isAborted(sessionId)) {
            const err = new Error('已取消')
            err.code = 'ABORTED'
            throw err
          }
          sendEvent('panda_status', { message: '流式失败，改非流式重试…', phase: 'llm_fallback', round: round + 1 })
          try {
            result = await llmCall({
              model: activeModel,
              messages: messagesForApi(),
              tools,
              tool_choice: 'auto',
              max_tokens: resolveMaxTokens(activeModel),
              temperature: 0.2,
              signal,
              stream: false
            })
          } catch (e2) {
            throwIfAborted(e2)
            const recovered2 = await tryReactiveCompactRetry(e2, { model: activeModel })
            if (recovered2) {
              result = recovered2
            } else {
              sendEvent('error', { message: e2.message || e.message || 'Panda Agent 模型调用失败' })
              throw e2
            }
          }
        }
      }
    } finally {
      clearInterval(heartbeat)
    }
    checkAbort()
    if (!result) {
      const err = new Error('已取消')
      err.code = 'ABORTED'
      throw err
    }
    runtime.sidechainMessages = messages
    if (result.usage) {
      const u = cost.addUsage(sessionId, result.usage, activeModel)
      sendEvent('panda_usage', u)
    }

    const msg = result.message || {}
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const assistantText = (msg.content && String(msg.content).trim()) || ''
    const reasoning = (result.reasoning || msg.reasoning_content || '').trim()

    if (startedThink) {
      sendEvent('panda_stream_end', { id: streamThinkId, kind: 'thinking', content: reasoning })
      await appendTranscript(projectRoot, sessionId, { type: 'thinking', content: reasoning.slice(0, 8000) })
    } else if (reasoning) {
      sendEvent('panda_block', { type: 'thinking', content: reasoning })
      await appendTranscript(projectRoot, sessionId, { type: 'thinking', content: reasoning.slice(0, 8000) })
    }

    if (startedText) {
      sendEvent('panda_stream_end', { id: streamTextId, kind: 'text', content: assistantText })
    } else if (assistantText) {
      sendEvent('panda_block', { type: 'assistant_text', content: assistantText })
    }
    // 多轮：有工具时也落盘本轮叙述，避免 reload 丢中间 assistant 文本
    if (assistantText && toolCalls.length) {
      await appendTranscript(projectRoot, sessionId, { type: 'assistant', content: assistantText.slice(0, 8000) })
    }

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined
    })

    if (!toolCalls.length) {
      // 对齐 panda-code：无工具 → Stop hooks → 未完成则 blocking continue
      try {
        const stop = await hooks.runStopHooks(projectRoot, runtime, assistantText)
        if (stop.notes && stop.notes.length) {
          sendEvent('panda_block', { type: 'system', content: 'Stop: ' + stop.notes.join(' | ') })
        }
        if (stop.preventContinuation) {
          finalText = assistantText || '（已停止）'
          break
        }
        if (stop.blockingErrors && stop.blockingErrors.length && autoContinueCount < MAX_AUTO_CONTINUES) {
          // 空转分析时 Stop 再催也没用：直接结束，避免反复刷同一段文字
          if (require('./continueGate').looksLikeRumination(assistantText) && autoContinueCount >= 1) {
            finalText = assistantText || '（已停止空转）'
            break
          }
          autoContinueCount++
          runtime.lastContinueReason = 'stop_hook'
          const blockMsg = stop.blockingErrors.join('\n\n')
          messages.push({
            role: 'user',
            content: blockMsg + '\n\nKeep working — call tools now (edit_file / Agent(Verify)). Do not re-analyze.'
          })
          sendEvent('panda_block', {
            type: 'system',
            content: 'Stop hook blocked end · continue #' + autoContinueCount
          })
          runtime.sidechainMessages = messages
          continue
        }
      } catch (e) { /* ignore stop hook errors */ }

      const gate = decideContinueWithoutTools({
        assistantText,
        reasoning,
        finishReason: result.finish_reason || '',
        runtime,
        continueCount: autoContinueCount,
        maxContinues: MAX_AUTO_CONTINUES
      })
      if (gate && gate.continue) {
        autoContinueCount++
        runtime.lastContinueReason = gate.reason
        messages.push({ role: 'user', content: gate.message })
        sendEvent('panda_block', {
          type: 'system',
          content: 'auto-continue · ' + gate.reason + ' #' + autoContinueCount
        })
        runtime.sidechainMessages = messages
        continue
      }
      runtime.lastContinueReason = null

      finalText = assistantText || '（无输出）'
      break
    }

    runtime.lastContinueReason = null

    const parsedCalls = toolCalls.map((tc, i) => {
      const id = tc.id || ('call_' + Date.now() + '_' + i)
      const fn = tc.function || {}
      const name = fn.name || ''
      let args = {}
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {})
      } catch (e) {
        args = {}
      }
      return { id, name, args, facing: toolFacingName(name), detail: toolDetail(name, args) }
    })

    const runOne = async (call) => {
      checkAbort()
      sendEvent('panda_block', {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        facing: call.facing,
        detail: call.detail,
        args: call.args,
        status: 'running'
      })
      sendEvent('panda_status', {
        message: '执行 ' + (call.facing || call.name) + (call.detail ? ' · ' + call.detail : ''),
        phase: 'tool',
        tool: call.name
      })
      runtime.currentToolCallId = call.id
      let out
      try {
        const isWrite = call.name === 'edit_file' || call.name === 'write_file' ||
          call.name === 'apply_patch' || call.name === 'edit_lines' || call.name === 'notebook_edit'
        const TOOL_TIMEOUT_MS = isWrite
          ? (parseInt(process.env.PANDA_WRITE_TIMEOUT_MS || process.env.CLAW_WRITE_TIMEOUT_MS, 10) || 20000)
          : (parseInt(process.env.PANDA_TOOL_TIMEOUT_MS || process.env.CLAW_TOOL_TIMEOUT_MS, 10) || 90000)
        console.log('[panda] tool start', call.name, call.detail || '')
        out = await Promise.race([
          executeTool(call.name, call.args, runtime),
          new Promise(function (resolve) {
            setTimeout(function () {
              resolve({
                ok: false,
                content: '工具执行超时（' + Math.round(TOOL_TIMEOUT_MS / 1000) + 's）：' + call.name +
                  '。若卡在 Edit：请勾选「自动批准写文件」，或检查 old_string 是否匹配。'
              })
            }, TOOL_TIMEOUT_MS)
          })
        ])
        console.log('[panda] tool end', call.name, out && out.ok ? 'ok' : 'fail')
      } finally {
        runtime.currentToolCallId = null
      }
      let postNotes = []
      try {
        postNotes = await hooks.runPostToolHooks(projectRoot, call.name, out, runtime) || []
        if (postNotes.length) {
          sendEvent('panda_block', { type: 'system', content: 'Hook(post): ' + postNotes.join(' | ') })
        }
        if (out && out.ok === false) {
          const failNotes = await hooks.runPostToolUseFailureHooks(projectRoot, call.name, out, runtime)
          if (failNotes.notes && failNotes.notes.length) {
            sendEvent('panda_block', { type: 'system', content: 'Hook(PostToolUseFailure): ' + failNotes.notes.join(' | ') })
            postNotes = postNotes.concat(failNotes.notes)
          }
        }
      } catch (e) { /* ignore */ }
      let content = out.content || ''
      if (postNotes.length) {
        content += '\n\n# Hook feedback (PostToolUse)\n' + postNotes.join('\n')
      }
      const ok = !!out.ok

      if (isVerifyAgentCall(call.name, call.args)) {
        runtime.didVerify = true
        const verdict = String(content || '')
        if (/\bVERDICT:\s*PASS\b/i.test(verdict) && !/系统覆写：原 PASS 被拒绝/i.test(verdict) && !/系统覆写：原 PASS 改为 PARTIAL/i.test(verdict)) {
          runtime.verifyFailed = false
          runtime.pendingDiagErrors = false
          runtime.pendingDiagSummary = ''
        } else if (/\bVERDICT:\s*PARTIAL\b/i.test(verdict) || /系统覆写：原 PASS 改为 PARTIAL/i.test(verdict)) {
          // PARTIAL = 环境受限 / 子代理证据不足：允许收工（主会话可补 bash）
          runtime.verifyFailed = false
          runtime.verifyPartial = true
          content += '\n\n（系统：Verify PARTIAL — 可收工。若需更强证据，在本会话直接 bash，不必无限重跑 Verify。）'
        } else if (/\bVERDICT:\s*FAIL\b/i.test(verdict)) {
          runtime.verifyFailed = true
          runtime.verifyAttempts = (runtime.verifyAttempts || 0) + 1
          content += '\n\n（系统：Verify FAIL — 请按报告复现并修复后再次 Agent(Verify)，不要收工。）'
        } else {
          // 无合法 VERDICT：不算通过
          runtime.verifyFailed = true
          runtime.verifyAttempts = (runtime.verifyAttempts || 0) + 1
          content += '\n\n（系统：Verify 未给出合法 VERDICT — 视为未通过，请再次 Agent(Verify)。）'
        }
      }
      if (ok && out.meta && out.meta.visionAttach && out.meta.imageDataUrl) {
        if (!Array.isArray(runtime.pendingVisionAttachments)) runtime.pendingVisionAttachments = []
        runtime.pendingVisionAttachments.push({
          dataUrl: out.meta.imageDataUrl,
          mime: out.meta.mime || 'image/png',
          name: (out.meta.screenshot || 'capture').replace(/\//g, '_'),
          url: out.meta.url || ''
        })
      }
      if (call.name === 'todo_write' && Array.isArray(runtime.todos)) {
        const closed = runtime.todos.filter(t => t && (t.status === 'completed' || t.status === 'cancelled')).length
        if (closed >= 3 && !runtime.didVerify && !(runtime.todos || []).some(t => /verif/i.test(String((t && t.content) || '') + String((t && t.id) || '')))) {
          content += '\n\n（提示：已关闭多项 todo 但未见验证步骤。完成目标前请调用 Agent(Verify)，FAIL 则继续修。）'
        }
      }

      // 编辑失败时提示重新 Read（注入给模型）
      const isWriteTool = call.name === 'edit_file' || call.name === 'write_file' || call.name === 'apply_patch' || call.name === 'edit_lines' || call.name === 'notebook_edit'
      if (!ok && isWriteTool) {
        runtime.lastEditFailed = true
        content += '\n\n（提示：请先 read_file 该路径，再从结果中不含行号前缀地复制 old_string 重试；或改用 apply_patch / edit_lines。）'
      }
      if (ok && isWriteTool) {
        runtime.lastEditFailed = false
      }

      // 失败熔断：纠错注入 + 同指纹计数（对标「禁令」进 tool_result，不改 system）
      if (!ok) {
        if (out.meta && (out.meta.reason === 'repeat_success' || out.meta.reason === 'repeat_path_read')) {
          // 成功空转熔断：保持 pathReads / streak，避免清零后再连读
          runtime.readLoopBlocked = true
          content += '\n\n（空转熔断生效中：禁止再 read 同一文件；请 edit_file 或向用户确认具体改什么。）'
        } else {
          const note = failureFuse.noteFailure(runtime, call.name, call.args || {}, content)
          content += failureFuse.correctionSuffix(runtime, call.name, call.args || {}, note)
        }
      } else {
        failureFuse.noteSuccess(runtime, call.name, call.args || {})
        if ((call.name === 'grep' || call.name === 'glob') && /^\(无匹配\)\s*$/.test(String(content || '').trim())) {
          failureFuse.noteEmptySearch(runtime, call.name, call.args || {})
          content += failureFuse.emptySearchSuffix(runtime)
        } else if (call.name === 'grep' || call.name === 'glob') {
          failureFuse.clearEmptySearch(runtime)
        }
      }

      // 波及提示（无 CodeGraph；用会话 changedFiles 计数）
      if (ok && isWriteTool && Array.isArray(runtime.changedFiles) && runtime.changedFiles.length > 3) {
        content += '\n\n（波及提示：本会话已改 ' + runtime.changedFiles.length +
          ' 个文件。无 AST 图谱预判；确认是否都必要。大范围改动应先 enter_plan_mode。）'
      }

      try {
        require('./toolTrace').appendToolTrace(projectRoot, sessionId, {
          name: call.name,
          ok,
          ms: Date.now() - (call._startedAt || Date.now()),
          argsBytes: JSON.stringify(call.args || {}).length,
          resultBytes: String(content || '').length,
          emptySearch: !!(runtime.failureFuse && runtime.failureFuse.emptySearch)
        })
      } catch (e) { /* ignore */ }

      // 先推送 tool_result，避免诊断拖住「执行 Edit」UI
      sendEvent('panda_block', {
        type: 'tool_result',
        id: call.id,
        name: call.name,
        facing: call.facing,
        ok,
        content: String(content).slice(0, 8000),
        preview: String(content).slice(0, 800),
        meta: out.meta || null
      })
      sendEvent('panda_block', { type: 'tool_status', id: call.id, status: ok ? 'done' : 'error' })

      // 改后诊断：只报相对写前的新增项（对标 diagnosticTracking delta）→ 有 error 则强制下一轮续修
      if (ok && out.meta && out.meta.changed && out.meta.file && isWriteTool) {
        try {
          const lsp = require('./lsp')
          if (!runtime.diagBaseline) runtime.diagBaseline = new Map()
          const fileKey = String(out.meta.file)
          const beforeText = runtime.diagBaseline.get(fileKey) || ''
          const diagWait = lsp.postEditDiagTimeoutMs(projectRoot)
          const diag = await Promise.race([
            lsp.getDiagnostics(projectRoot, out.meta.file),
            new Promise(function (resolve) { setTimeout(function () { resolve(null) }, diagWait) })
          ])
          const dtext = String((diag && diag.content) || '')
          runtime.diagBaseline.set(fileKey, dtext)
          const beforeSet = new Set(beforeText.split('\n').map(l => l.trim()).filter(Boolean))
          const deltaLines = dtext.split('\n').filter(l => {
            const t = l.trim()
            return t && !beforeSet.has(t) && (/\[error\]/.test(t) || /\[warning\]/.test(t))
          })
          const report = beforeText
            ? deltaLines
            : dtext.split('\n').filter(l => /\[error\]/.test(l) || /\[warning\]/.test(l))
          const errorLines = report.filter(l => /\[error\]/i.test(l))
          if (report.length) {
            const body = report.join('\n').slice(0, 2500)
            const block = '\n\n<new-diagnostics file="' + out.meta.file + '">\n' +
              body + '\n</new-diagnostics>\n' +
              (errorLines.length
                ? '有 error：必须继续 edit_file 修复后再收工（系统会自动续跑）。'
                : '仅有 warning：可酌情处理。')
            content += block
            if (errorLines.length) {
              runtime.pendingDiagErrors = true
              runtime.pendingDiagSummary = errorLines.join('\n').slice(0, 1500)
              runtime.didVerify = false
            } else {
              // 本文件新增无 error；若无其它挂起摘要则清 flag
              if (!runtime.pendingDiagSummary || !/\[error\]/i.test(runtime.pendingDiagSummary)) {
                runtime.pendingDiagErrors = false
                runtime.pendingDiagSummary = ''
              }
            }
            sendEvent('panda_block', {
              type: 'tool_result',
              id: call.id + '_diag',
              name: call.name,
              facing: 'Diagnostics',
              ok: true,
              content: block.slice(0, 4000),
              preview: block.slice(0, 400)
            })
          } else {
            // 干净：清除该文件相关 error 挂起
            runtime.pendingDiagErrors = false
            runtime.pendingDiagSummary = ''
          }
        } catch (e) { /* ignore */ }
      }

      if (call.name === 'bash' || call.name === 'diagnostics') {
        const meta = out.meta || {}
        const cmdFail = meta.commandFail || meta.buildFail || (!ok && call.name === 'bash')
        const buildNote = call.name === 'diagnostics' && /build exit=[1-9]/i.test(String(content || ''))
        if (cmdFail || buildNote) {
          runtime.pendingCommandFail = true
          runtime.pendingCommandSummary = String(content || '').slice(0, 1500)
          runtime.didVerify = false
          runtime.healCount = (runtime.healCount || 0) + 1
          content += '\n\n（系统：命令失败 — 请根据输出修复后重跑；自愈轮次 ' +
            runtime.healCount + '/' + (parseInt(process.env.PANDA_MAX_HEALING, 10) || 3) + '。）'
        } else if (call.name === 'bash' && ok) {
          runtime.pendingCommandFail = false
          runtime.pendingCommandSummary = ''
          runtime.healCount = 0
        }
      }

      if (out.meta && out.meta.changed && out.meta.file) {
        noteChangedFile(out.meta.file)
        wroteSomething = true
      }
      if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'apply_patch' || call.name === 'edit_lines') {
        if (ok) wroteSomething = true
      }
      if (out.meta && out.meta.askUser) {
        askUser = { question: out.meta.question, options: out.meta.options || [] }
      }
      await appendTranscript(projectRoot, sessionId, {
        type: 'tool',
        id: call.id,
        name: call.name,
        facing: call.facing,
        detail: call.detail,
        ok,
        preview: String(content).slice(0, 800),
        content: String(content).slice(0, 8000),
        meta: out.meta || null
      })
      return { call, out, content: content }
    }

    const readonly = parsedCalls.filter(c => isReadonlyTool(c.name))
    const writable = parsedCalls.filter(c => !isReadonlyTool(c.name))
    const results = []
    if (readonly.length) {
      const parallel = await Promise.all(readonly.map(runOne))
      results.push(...parallel)
    }
    for (const c of writable) {
      checkAbort()
      results.push(await runOne(c))
      if (askUser) break
    }

    // 每个 tool_call 都必须有对应 tool 结果，否则下一轮 API 会报：
    // Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
    const doneIds = new Set(results.map(r => r.call && r.call.id))
    for (const r of results) {
      messages.push({
        role: 'tool',
        tool_call_id: r.call.id,
        content: String(r.content).slice(0, 24000)
      })
    }
    for (const c of parsedCalls) {
      if (doneIds.has(c.id)) continue
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: askUser
          ? '（跳过：等待用户确认 ask_user）'
          : '（跳过：工具未执行）'
      })
    }

    // capture_page：支持多模态才注入 image_url；否则只注入截图路径文本（不切换 vl 模型）
    if (!askUser && Array.isArray(runtime.pendingVisionAttachments) && runtime.pendingVisionAttachments.length) {
      try {
        const imageUpload = require('./imageUpload')
        const batch = runtime.pendingVisionAttachments.splice(0, runtime.pendingVisionAttachments.length)
        const built = await imageUpload.buildMultimodalUserMessage(
          projectRoot,
          '【页面截图 · capture_page】以下是当前 UI。请根据实际观感指出问题并改代码；不要臆造未出现的布局。\n' +
            batch.map(b => (b.url ? 'url: ' + b.url : '')).filter(Boolean).join('\n'),
          batch
        )
        if (built.multimodal) {
          messages.push(built.message)
          effectiveModel = built.model
          if (runtime.context) runtime.context.model = built.model
          sendEvent('panda_block', {
            type: 'system',
            content: '已注入 ' + batch.length + ' 张页面截图 → `' + built.model + '`'
          })
        } else if (built.hasImages || built.saved.length) {
          messages.push({ role: 'user', content: built.textFallback })
          sendEvent('panda_block', {
            type: 'system',
            content: '已注入截图路径（当前模型不支持多模态，未发送 image_url、未切换视觉模型）'
          })
        }
      } catch (e) {
        sendEvent('panda_block', {
          type: 'system',
          content: '截图注入失败：' + (e.message || e)
        })
      }
    }

    runtime.sidechainMessages = messages
    // 每轮工具后落盘，刷新/崩溃可从 context 续（P0 mid-run checkpoint）
    await persistContext(messages)

    if (askUser) {
      finalText = '需要先和您确认：\n\n' + askUser.question
      sendEvent('clarification', { question: askUser.question, options: askUser.options || [] })
      sendEvent('panda_block', { type: 'assistant_text', content: finalText })
      sendEvent('answer_done', {})
      await touchSessionMeta(projectRoot, sessionId, { lastMessage: finalText.slice(0, 80) })
      await persistContext(messages)
      abortRegistry.endRun(sessionId)
      return { text: finalText, changed, askUser, mode: runtime.mode, todos: runtime.todos, sessionId }
    }
  }

  if (!finalText) {
    const uniqueFiles = changed.map(c => c.file).filter(Boolean)
    finalText = wroteSomething
      ? ('已完成修改。涉及文件：' + (uniqueFiles.join(', ') || '见工具结果'))
      : '已达最大工具轮次或未产生文件改动。可继续补充需求，或 /undo 回退。'
    sendEvent('panda_block', { type: 'assistant_text', content: finalText })
  }

  await appendTranscript(projectRoot, sessionId, { type: 'assistant', content: finalText.slice(0, 8000) })
  await touchSessionMeta(projectRoot, sessionId, { lastMessage: finalText.slice(0, 80), changedCount: changed.length })
  await persistContext(messages)

  // 回合结束记忆抽取（对标 extractMemories）
  try {
    const ex = await require('./extractMemories').extractMemories(projectRoot, runtime, messages)
    if (ex && ex.extracted > 0) {
      sendEvent('panda_block', {
        type: 'system',
        content: 'Auto memory +' + ex.extracted + '：' + (ex.notes || []).join(' · ')
      })
    }
  } catch (e) { /* ignore */ }

  // 刷新工作区 rollup 缓存（供新 Chat / 客户端预览）
  try {
    await require('./workspaceMemory').buildWorkspaceMemorySection(projectRoot, { excludeSessionId: sessionId })
  } catch (e) { /* ignore */ }

  sendEvent('answer_done', {})
  sendEvent('done', { kind: 'panda_agent', changed, sessionId, usage: cost.getUsage(sessionId), todos: runtime.todos || [] })

  try {
    const se = await hooks.runSessionEndHooks(projectRoot, runtime, 'turn_end')
    if (se && se.notes && se.notes.length) {
      sendEvent('panda_block', { type: 'system', content: 'Hook(SessionEnd): ' + se.notes.join(' | ') })
    }
  } catch (e) { /* ignore */ }

  return {
    text: finalText,
    changed,
    askUser: null,
    mode: runtime.mode,
    todos: runtime.todos,
    plan: runtime.lastPlan || '',
    sessionId,
    usage: cost.getUsage(sessionId)
  }
  } catch (e) {
    if (abortRegistry.isAbortError(e) || signal.aborted) {
      sendEvent('panda_block', { type: 'system', content: '⏹ 已中断' })
      sendEvent('answer_done', {})
      sendEvent('done', { kind: 'panda_agent', changed, sessionId, aborted: true, todos: runtime.todos || [] })
      try { await persistContext(typeof messages !== 'undefined' ? messages : []) } catch (e2) { /* */ }
      return { text: '已中断', changed, sessionId, mode: runtime.mode, aborted: true }
    }
    try { await persistContext(typeof messages !== 'undefined' ? messages : []) } catch (e2) { /* */ }
    throw e
  } finally {
    try { require('./sessionRuntime').unregister(sessionId) } catch (e2) { /* ignore */ }
    abortRegistry.endRun(sessionId)
  }
}

module.exports = {

  runPandaAgent,
  normalizeHistory
}
