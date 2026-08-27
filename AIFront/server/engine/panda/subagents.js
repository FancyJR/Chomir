/**
 * 子代理（对齐 panda-code AgentTool built-ins：Explore / Plan / Verify）
 * 统一入口：runAgent(subagent_type, prompt, …)
 * 精髓：真工具循环「搜→读→（Plan/Verify 更深）→汇报」，不是意图正则。
 */

const { callDeepseekChat, callDeepseekText } = require('../shared-llm')

const READONLY_BASH = {
  type: 'function',
  function: {
    name: 'bash',
    description:
      'READ-ONLY shell only: ls, pwd, git status/diff/log/show, head/tail/wc, find (list). ' +
      'Never mkdir/rm/write/npm install/git write.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' }
      },
      required: ['command']
    }
  }
}

const EXPLORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern under the project (e.g. src/views/**/*.vue, **/router/**).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional subdirectory' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with regex. Use for menu labels, route paths, component names, Chinese UI strings.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file (or slice) once you know the path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['path']
      }
    }
  },
  READONLY_BASH
]

const PLAN_TOOLS = EXPLORE_TOOLS
const READONLY_ALLOWED = new Set(['glob', 'grep', 'read_file', 'bash'])

function thoroughnessRounds (level) {
  const t = String(level || 'medium').toLowerCase().replace(/\s+/g, '_')
  if (t === 'quick' || t === 'low') return 5
  if (t === 'very_thorough' || t === 'very-thorough' || t === 'high' || t === 'max') return 14
  return 10
}

function exploreSystemPrompt () {
  return [
    'You are a file-search specialist (Explore subagent). READ-ONLY — no edits, no writes, no destructive bash.',
    '',
    '=== CRITICAL: READ-ONLY ===',
    'Forbidden: create/modify/delete files, npm install, git write, redirects that write files.',
    'Allowed: glob, grep, read_file, and bash ONLY for read-only ops (ls, git status/diff/log, find, head/tail).',
    '',
    'Mission: map the USER natural-language request to the correct source files in this Vue 2 + Express repo.',
    '',
    'How to search:',
    '1. Extract searchable tokens: menu names, routes, page titles, symptoms (空白/白屏/报错), feature words.',
    '2. Use MULTIPLE greps/globs in parallel — Chinese UI often lives in App.vue, router/index.js, src/views/*.',
    '3. Patterns (not hard rules): 「编排」→ Orchestration*; 「指令市场」→ CommandMarket; 「右边空白」→ find view then template vs script.',
    '4. Prefer parallel tool calls. Do not stop after one weak grep. Adapt depth to thoroughness.',
    '5. Be fast but thorough enough — spawn parallel greps/reads when possible.',
    '',
    'FINAL REPORT in Chinese (no more tools):',
    '- 用户意图理解（一句话）',
    '- 关键文件列表（路径 + 为何相关）',
    '- 建议主 Agent 下一步：先 read 哪些、再检查什么、可能根因',
    '- 不要改代码'
  ].join('\n')
}

function planSystemPrompt () {
  return [
    'You are a software architect and planning specialist (Plan subagent).',
    '',
    '=== CRITICAL: READ-ONLY MODE — NO FILE MODIFICATIONS ===',
    'STRICTLY PROHIBITED: Write/Edit/create/delete/move files, npm install, git write, redirects that write.',
    'Allowed: glob, grep, read_file, bash for read-only ops only (ls, git status/diff/log, find, head/tail).',
    'You do NOT have edit tools — attempting edits will fail.',
    '',
    '## Your Process',
    '1. Understand requirements — focus on the goal and constraints.',
    '2. Explore thoroughly:',
    '   - Find existing patterns and conventions',
    '   - Understand current architecture',
    '   - Identify similar features as reference',
    '   - Trace relevant code paths with multiple greps/reads (parallel when independent)',
    '   - Do NOT claim files you have not searched for or read',
    '3. Design solution — approach, trade-offs, follow existing patterns where appropriate.',
    '4. Detail the plan — step-by-step, dependencies, sequencing, risks.',
    '',
    '## Required Output (Chinese)',
    '1) 理解的目标',
    '2) 关键文件与现有模式（附路径）',
    '3) 分步实施（每步对应具体 read/edit/grep/bash；写清改哪些文件）',
    '4) 验收标准',
    '5) 风险与回退',
    '',
    'End with exactly:',
    '### Critical Files for Implementation',
    'List 3–5 most critical files:',
    '- path/to/file1',
    '- path/to/file2',
    '',
    'REMEMBER: ONLY explore and plan. NEVER write or edit files.'
  ].join('\n')
}

async function runToolAgentLoop (opts) {
  const {
    goal,
    projectRoot,
    systemPrompt,
    tools,
    allowedTools,
    maxRounds = 8,
    model,
    mode = 'plan',
    nudgeIfMissing = null
  } = opts

  const { executeTool } = require('./tools')
  const runtime = {
    projectRoot,
    mode,
    permissionMode: mode === 'verify' ? 'verify' : 'plan',
    todos: [],
    memory: { read: async () => '', append: async () => {} },
    readFileState: new Map()
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(goal || '').trim() || 'Explore the codebase structure.' }
  ]

  let lastText = ''
  for (let round = 0; round < maxRounds; round++) {
    let result
    try {
      result = await callDeepseekChat({
        model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: mode === 'verify' ? 2500 : 2200,
        temperature: mode === 'verify' ? 0.15 : 0.2,
        stream: false
      })
    } catch (e) {
      lastText = lastText || ('子代理调用失败：' + (e.message || e))
      break
    }

    const msg = result.message || {}
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const text = (msg.content && String(msg.content).trim()) || ''
    if (text) lastText = text

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined
    })

    if (!toolCalls.length) break

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const id = tc.id || ('ag_' + round + '_' + i)
      const fn = tc.function || {}
      const name = fn.name || ''
      let args = {}
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {})
      } catch (e) {
        args = {}
      }
      if (!allowedTools.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: 'Tool not allowed in this subagent: ' + name
        })
        continue
      }
      let out
      try {
        out = await executeTool(name, args, runtime)
      } catch (e) {
        out = { ok: false, content: e.message || String(e) }
      }
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: String((out && out.content) || '').slice(0, 12000)
      })
    }
  }

  if (nudgeIfMissing && lastText && !nudgeIfMissing.test(lastText)) {
    messages.push({
      role: 'user',
      content: 'Your report is missing required sections. Output the COMPLETE final report now (no more tools), including all required headings.'
    })
    try {
      const result = await callDeepseekChat({
        model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        max_tokens: 2200,
        temperature: 0.1,
        stream: false
      })
      const t = (result.message && result.message.content && String(result.message.content).trim()) || ''
      if (t) lastText = t
    } catch (e) { /* keep */ }
  }

  if (!lastText.trim()) {
    lastText = '（子代理未产出报告。请主 Agent 自行 glob/grep 用户关键词并 read 命中文件。）'
  }
  return lastText
}

async function runReadonlyAgentLoop (opts) {
  return runToolAgentLoop(Object.assign({}, opts, {
    tools: opts.tools || EXPLORE_TOOLS,
    allowedTools: opts.allowedTools || READONLY_ALLOWED,
    mode: opts.mode || 'plan'
  }))
}

/**
 * @param {string} goal
 * @param {string} projectRoot
 * @param {{ thoroughness?: string }} [options]
 */
async function runExploreAgent (goal, projectRoot, options = {}) {
  const rounds = thoroughnessRounds(options.thoroughness || options.level || 'medium')
  try {
    return await runToolAgentLoop({
      goal: [
        'User request / exploration goal:',
        goal,
        '',
        'Thoroughness: ' + (options.thoroughness || options.level || 'medium'),
        'Search until you can name the concrete Vue/router/server files that implement this. Then FINAL REPORT.'
      ].join('\n'),
      projectRoot,
      systemPrompt: exploreSystemPrompt(),
      tools: EXPLORE_TOOLS,
      allowedTools: READONLY_ALLOWED,
      maxRounds: rounds,
      mode: 'plan'
    })
  } catch (e) {
    return 'Explore 失败：' + (e.message || e)
  }
}

/**
 * Plan：单次深度只读工具循环（对齐 planAgent — 边探索边规划，非「浅 explore + 一次文本」）
 */
async function runPlanAgent (goal, projectRoot, fileSnippet) {
  const maxRounds = Number(process.env.PANDA_PLAN_ROUNDS || process.env.CLAW_PLAN_ROUNDS || 14)
  try {
    return await runToolAgentLoop({
      goal: [
        'Design an implementation plan for the following goal. Explore the codebase thoroughly first.',
        '',
        'Goal:',
        String(goal || '').trim(),
        fileSnippet ? ('\nAdditional context:\n' + fileSnippet) : '',
        '',
        'Use tools until you have enough evidence, then output the full plan with Critical Files.'
      ].join('\n'),
      projectRoot,
      systemPrompt: planSystemPrompt(),
      tools: PLAN_TOOLS,
      allowedTools: READONLY_ALLOWED,
      maxRounds,
      mode: 'plan',
      nudgeIfMissing: /Critical Files for Implementation/i
    })
  } catch (e) {
    try {
      return await callDeepseekText('输出结构化实施计划（含 Critical Files）。不要改代码。', '目标：' + goal, { max_tokens: 1600 })
    } catch (e2) {
      return '计划生成失败：' + (e.message || e)
    }
  }
}

/** Verify 可用工具：读 + bash（verify 权限），禁止 edit/write/agent */
const VERIFY_TOOLS = [
  ...EXPLORE_TOOLS,
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command for verification: build, node scripts, curl against local servers, ' +
        'grep checks, ephemeral probes under /tmp. Do NOT edit project files or install deps.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number' }
        },
        required: ['command']
      }
    }
  }
]

const VERIFY_ALLOWED = new Set(['glob', 'grep', 'read_file', 'bash'])

function verifySystemPrompt () {
  return [
    'You are a verification specialist. Your job is not to confirm the implementation works — it\'s to try to break it.',
    '',
    'Two failure patterns to avoid:',
    '1) Verification avoidance: read code, narrate what you would test, write PASS, move on.',
    '2) Seduced by the first 80%: polish / happy path looks fine; miss dead buttons, lost state, bad input crashes.',
    'Your value is finding the last 20%. PASS without real command output will be REJECTED by the system.',
    '',
    '=== CRITICAL: DO NOT MODIFY THE PROJECT ===',
    'Forbidden: create/modify/delete files in the project, npm install, git write ops.',
    'Allowed: read_file / glob / grep / bash. Ephemeral scripts only under /tmp (then clean up).',
    '',
    '=== THIS REPO ===',
    'Vue 2.7 + ElementUI frontend (npm run serve → :8080) + Express API (npm run server → :8787).',
    'Build: npm run build. Prefer package.json scripts / Panda.md / README for how to verify.',
    'Frontend: curl pages/static assets or node -e require checks; Backend: curl localhost APIs and assert body shape, not only status.',
    '',
    '=== REQUIRED BASELINE ===',
    '1. Read Panda.md / package.json if useful for scripts and success criteria.',
    '2. Run build when applicable — broken build = FAIL.',
    '3. Run relevant tests/linters if present.',
    '4. Exercise the change directly (run/call/curl/node), then try to break it.',
    'Reading code is context, not evidence. Implementer tests may be mocked — verify independently.',
    '',
    '=== ADVERSARIAL PROBES (pick what fits) ===',
    'Boundary: 0, -1, empty, long unicode. Idempotency. Missing IDs. Bad JSON. Concurrent double-submit if API.',
    'At least one adversarial probe with Command run + Output observed is required before PASS.',
    '',
    '=== OUTPUT FORMAT (REQUIRED) ===',
    'Every check MUST look like:',
    '### Check: [what]',
    '**Command run:**',
    '  [exact command]',
    '**Output observed:**',
    '  [actual output excerpt — not paraphrased]',
    '**Result: PASS|FAIL** (Expected vs Actual if FAIL)',
    '',
    'Bad (rejected): "Code looks correct after reading routes.js" with no Command run.',
    '',
    'End with exactly one of:',
    'VERDICT: PASS',
    'VERDICT: FAIL',
    'VERDICT: PARTIAL',
    '',
    'PARTIAL = environmental limits only (server down, no tool). If you could run the check, decide PASS or FAIL.',
    'FAIL: include reproduction. Do not pretend completion.'
  ].join('\n')
}

/**
 * 是否把一次 bash 结果算作「实测证据」。
 * 对齐现实：grep/rg 无匹配 exit=1，仍是有效负证据（不是 cwd 空目录）。
 */
function bashCountsAsEvidence (args, out) {
  if (!out) return false
  if (out.ok) return true
  const cmd = String((args && args.command) || '')
  const code = out.code != null ? out.code : (out.meta && out.meta.code)
  if (code === 1 && /\b(grep|egrep|fgrep|rg)\b/.test(cmd)) return true
  return false
}

/**
 * PASS 需要报告格式 + 至少一次工具实测；缺证据降为 PARTIAL（勿 FAIL 锁死）。
 * 注意：panda-code 本身不覆写 VERDICT，只靠 prompt 约束；我们保留软降级防空口 PASS。
 * @param {string} report
 * @param {{ bashOkCount: number, bashAttempts: number, probeOkCount?: number }} stats
 */
function enforceVerifyEvidence (report, stats) {
  let text = String(report || '').trim()
  const m = text.match(/\bVERDICT:\s*(PASS|FAIL|PARTIAL)\b/i)
  const verdict = m ? m[1].toUpperCase() : null
  const hasCommandBlock = /\*\*Command run:\*\*|Command run:/i.test(text)
  const hasOutputBlock = /\*\*Output observed:\*\*|Output observed:/i.test(text)
  const ranProbe = ((stats && stats.bashOkCount) || 0) + ((stats && stats.probeOkCount) || 0) > 0

  if (!verdict) {
    text += '\n\nVERDICT: FAIL\n（系统覆写：未输出合法 VERDICT: PASS|FAIL|PARTIAL 行。）'
    return text
  }

  if (verdict === 'PASS') {
    if (!ranProbe || !hasCommandBlock || !hasOutputBlock) {
      text = text.replace(/\bVERDICT:\s*PASS\b/i, 'VERDICT: PARTIAL')
      text += [
        '',
        '（系统覆写：原 PASS 改为 PARTIAL — 缺工具实测或报告缺 Command/Output。',
        '对齐 panda-code：PARTIAL 可收工；勿把 PARTIAL 当 FAIL 无限重跑 Verify。）',
        !ranProbe ? '原因：无成功的 bash/grep/read 探测（注意：grep 无匹配 exit=1 算成功负证据）。' : '',
        !hasCommandBlock ? '原因：报告缺 Command run。' : '',
        !hasOutputBlock ? '原因：报告缺 Output observed。' : ''
      ].filter(Boolean).join('\n')
    }
  }
  return text
}

async function runVerifyAgentLoop (opts) {
  const {
    goal,
    projectRoot,
    changedFiles = [],
    maxRounds = 14,
    model
  } = opts

  const { executeTool } = require('./tools')
  const runtime = {
    projectRoot,
    mode: 'verify',
    todos: [],
    memory: { read: async () => '', append: async () => {} },
    readFileState: new Map()
  }

  const changedList = (changedFiles || [])
    .map(f => (typeof f === 'string' ? f : (f.file || f.path || '')))
    .filter(Boolean)
    .slice(0, 40)

  const rootAbs = require('path').resolve(projectRoot || process.cwd())
  const userGoal = [
    'CRITICAL: VERIFICATION-ONLY. Do not edit project files. End with VERDICT: PASS|FAIL|PARTIAL.',
    '',
    'Working directory (absolute, ALWAYS): ' + rootAbs,
    'All bash/grep/read_file paths are relative to that root unless you pass an absolute path.',
    'If a tool returns empty, that is the tool output — do NOT invent "empty sandbox" or old file snapshots.',
    'Never fabricate Command run / Output observed; copy from tool results only.',
    '',
    'Original task / goal to verify:',
    String(goal || '').trim() || '(no goal provided)',
    '',
    'Files changed (from parent agent):',
    changedList.length ? changedList.map(f => '- ' + f).join('\n') : '(none listed — discover via git status / glob)',
    '',
    'Use tools now: read criteria → run build/tests → exercise the change → adversarial probe → report with evidence.'
  ].join('\n')

  const messages = [
    { role: 'system', content: verifySystemPrompt() },
    { role: 'user', content: userGoal }
  ]

  const stats = { bashOkCount: 0, bashAttempts: 0, probeOkCount: 0 }
  let lastText = ''

  for (let round = 0; round < maxRounds; round++) {
    let result
    try {
      result = await callDeepseekChat({
        model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        tools: VERIFY_TOOLS,
        tool_choice: 'auto',
        max_tokens: 2500,
        temperature: 0.15,
        stream: false
      })
    } catch (e) {
      lastText = lastText || ('Verify 子代理调用失败：' + (e.message || e))
      break
    }

    const msg = result.message || {}
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const text = (msg.content && String(msg.content).trim()) || ''
    if (text) lastText = text

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined
    })

    if (!toolCalls.length) break

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const id = tc.id || ('vf_' + round + '_' + i)
      const fn = tc.function || {}
      const name = fn.name || ''
      let args = {}
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {})
      } catch (e) {
        args = {}
      }

      if (!VERIFY_ALLOWED.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: 'Tool not allowed in Verify: ' + name + '. Use glob/grep/read_file/bash only.'
        })
        continue
      }

      let out
      try {
        if (name === 'bash') {
          stats.bashAttempts++
          // 给 build/curl 更长默认超时
          if (args.timeout_ms == null) {
            const c = String(args.command || '')
            args.timeout_ms = /\bnpm\s+run\s+build\b|\bvue-cli-service\s+build\b/i.test(c) ? 120000 : 60000
          }
        }
        out = await executeTool(name, args, runtime)
        if (name === 'bash' && bashCountsAsEvidence(args, out)) stats.bashOkCount++
        if ((name === 'grep' || name === 'read_file' || name === 'glob') && out && out.ok) {
          stats.probeOkCount++
        }
      } catch (e) {
        out = { ok: false, content: e.message || String(e) }
      }
      let toolBody = String((out && out.content) || '')
      // 固化 cwd，抑制「空目录隔离」幻觉
      toolBody = '[verify_cwd=' + rootAbs + ']\n' + toolBody
      if (name === 'bash' && out && out.code === 1 &&
          /\b(grep|egrep|fgrep|rg)\b/.test(String(args.command || ''))) {
        toolBody += '\n(note: grep/rg exit 1 = no matches — valid negative evidence, not a missing cwd.)'
      }
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: toolBody.slice(0, 14000)
      })
    }
  }

  // 若模型在工具轮后仍无终稿，再催一次纯文本报告
  if (!/\bVERDICT:\s*(PASS|FAIL|PARTIAL)\b/i.test(lastText)) {
    messages.push({
      role: 'user',
      content:
        'Stop calling tools. Output the verification report now with Command run / Output observed for each check, ' +
        'and end with exactly one line: VERDICT: PASS or VERDICT: FAIL or VERDICT: PARTIAL.'
    })
    try {
      const result = await callDeepseekChat({
        model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        max_tokens: 2500,
        temperature: 0.1,
        stream: false
      })
      const t = (result.message && result.message.content && String(result.message.content).trim()) || ''
      if (t) lastText = t
    } catch (e) {
      /* keep lastText */
    }
  }

  if (!lastText.trim()) {
    lastText = '（Verify 未产出报告。）\n\nVERDICT: FAIL'
  }

  return enforceVerifyEvidence(lastText, stats)
}

async function runVerifyAgent (goal, projectRoot, changedFiles) {
  try {
    return await runVerifyAgentLoop({
      goal,
      projectRoot,
      changedFiles: changedFiles || [],
      maxRounds: Number(process.env.PANDA_VERIFY_ROUNDS || process.env.CLAW_VERIFY_ROUNDS || 16)
    })
  } catch (e) {
    return 'Verify 失败：' + (e.message || e) + '\n\nVERDICT: FAIL'
  }
}

function normalizeSubagentType (type) {
  const t = String(type || '').trim().toLowerCase()
  if (!t || t === 'explore' || t === 'exploration') return 'explore'
  if (t === 'plan' || t === 'planning') return 'plan'
  if (t === 'verify' || t === 'verification' || t === 'review') return 'verify'
  if (t === 'general' || t === 'general-purpose' || t === 'general_purpose') return 'general'
  if (t === 'implementer' || t === 'implement') return 'implementer'
  if (t === 'fork') return 'fork'
  if (t === 'shiyundesign' || t === 'design' || t === 'opendesign') return 'shiyundesign'
  return t
}

/**
 * ShiyunDesign：OpenDesign 资产 + ChomirCode 执行，产出 HTML/CSS 等设计交付物。
 * @param {string} goal 用户设计任务（原文）
 * @param {string} projectRoot
 * @param {object} [options]
 */
async function runShiyunDesignAgent (goal, projectRoot, options = {}) {
  const path = require('path')
  const { composeDesignTask } = require('../../../shiyundesign/lib/compose-design-task')
  const { openHtmlPreviewIfPresent } = require('../../../shiyundesign/lib/open-html-preview')
  const { discoverDeliverableFiles } = require('../../../shiyundesign/agent-outcome')
  const { extractTargetDirFromTask, ensureTargetDir } = require('../../../shiyundesign/subagent-task-cwd')
  const { runPandaAgent } = require('./agent')

  const userTask = String(goal || '').trim()
  if (!userTask) return 'ShiyunDesign 失败：prompt 为空'

  const assetsRoot = path.join(__dirname, '../../../shiyundesign/assets')
  let composed
  try {
    composed = composeDesignTask({ assetsRoot, userTask })
  } catch (e) {
    return 'ShiyunDesign 失败：' + (e.message || e)
  }

  let cwd = projectRoot
  const taskCwd = extractTargetDirFromTask(userTask)
  if (taskCwd) {
    try {
      cwd = ensureTargetDir(taskCwd, 'shiyundesign')
    } catch (e) {
      return 'ShiyunDesign 失败：' + (e.message || e)
    }
  }

  try {
    const result = await runPandaAgent({
      message: composed,
      projectInfo: { root: cwd, name: path.basename(cwd) },
      context: {
        sessionId: options.sessionId || ('shiyundesign_' + Date.now().toString(16)),
        permissionMode: options.permissionMode || 'bypassPermissions',
        planMode: false,
        model: options.model || process.env.DEEPSEEK_MODEL || ''
      },
      maxRounds: options.maxRounds ||
        parseInt(process.env.AIFRONT_MAX_ROUNDS || process.env.PANDA_AGENT_MAX_ROUNDS || '1024', 10),
      sendEvent: options.sendEvent
    })

    const changed = (result && result.changed || []).map((c) => c.file).filter(Boolean)
    const fallbackChanged = discoverDeliverableFiles({ cwd, taskText: userTask })
    const opened = openHtmlPreviewIfPresent(cwd, changed.length ? changed : fallbackChanged)
    let text = (result && result.text) ? String(result.text) : ''
    if (result && result.aborted) {
      return text || 'ShiyunDesign 已中断'
    }
    if (opened) {
      text += '\n\n已在浏览器打开预览：`' + path.basename(opened) + '`'
    }
    return text || 'ShiyunDesign 完成'
  } catch (e) {
    return 'ShiyunDesign 失败：' + (e.message || e)
  }
}

/**
 * 统一 Agent 入口（对齐 panda-code AgentTool + subagent_type）
 * @param {string} type explore|plan|verify|fork|general|implementer
 * @param {string} prompt
 * @param {string} projectRoot
 * @param {object} [options]
 */
async function runAgent (type, prompt, projectRoot, options = {}) {
  const t = normalizeSubagentType(type)
  const goal = String(prompt || options.goal || '').trim()
  if (!goal) return 'Agent 失败：prompt/goal 为空'

  if (t === 'explore') {
    return runExploreAgent(goal, projectRoot, {
      thoroughness: options.thoroughness || options.level || 'medium'
    })
  }
  if (t === 'plan') {
    return runPlanAgent(goal, projectRoot, options.fileSnippet || '')
  }
  if (t === 'verify') {
    return runVerifyAgent(goal, projectRoot, options.changedFiles || [])
  }
  if (t === 'shiyundesign' || t === 'design') {
    return runShiyunDesignAgent(goal, projectRoot, options)
  }

  // fork / general / implementer → sidechain fork
  try {
    const agentFork = require('./agentFork')
    const report = await agentFork.runFork(projectRoot, {
      goal,
      type: t === 'general' ? 'general' : t,
      writable: t === 'implementer' || !!options.writable,
      parentSessionId: options.parentSessionId,
      forkContextMessages: options.forkContextMessages || [],
      readFileState: options.readFileState,
      parentRequirePermission: options.parentRequirePermission,
      parentMode: options.parentMode,
      parentContext: options.parentContext,
      model: options.model || 'inherit',
      permissionMode: options.permissionMode ||
        (t === 'implementer' ? 'bubble' : (t === 'fork' || t === 'general' ? 'bubble' : 'plan')),
      onProgress: options.onProgress,
      sendEvent: options.sendEvent
    })
    return '【Agent ' + report.id + ' · ' + t + ' · ' + report.permissionMode + '】\n\n' + (report.result || '')
  } catch (e) {
    return 'Agent(' + t + ') 失败：' + (e.message || e)
  }
}

function isVerifyAgentCall (name, args) {
  const n = String(name || '')
  if (n === 'agent_verify') return true
  if (n === 'Agent' || n === 'agent') {
    const t = normalizeSubagentType((args && (args.subagent_type || args.type)) || '')
    return t === 'verify'
  }
  return false
}

module.exports = {
  runExploreAgent,
  runPlanAgent,
  runVerifyAgent,
  runShiyunDesignAgent,
  runAgent,
  normalizeSubagentType,
  isVerifyAgentCall,
  enforceVerifyEvidence,
  VERIFY_WHEN_TO_USE:
    'Use after non-trivial work (≈3+ file edits, backend/API, infra) to adversarially verify. ' +
    'Skip for trivial style-only (background/color) — parent can bash/grep self-check. ' +
    'Pass ORIGINAL user goal + changed files. PASS needs real tool output in Command run / Output observed.',
  PLAN_WHEN_TO_USE:
    'Software architect for designing implementation plans. Use when the approach is unclear or the change spans multiple files. ' +
    'Explores with tools then returns a step-by-step plan and Critical Files. Does not edit code.',
  EXPLORE_WHEN_TO_USE:
    'Fast read-only codebase explorer. Use when you need to find which files implement a user description ' +
    '(menu names, page symptoms like 空白/报错, feature words) before editing. ' +
    'Prefer direct glob/grep for one obvious keyword; use Agent(Explore) when the mapping is unclear or needs multiple searches. ' +
    'Pass thoroughness: quick | medium | very_thorough.'
}
