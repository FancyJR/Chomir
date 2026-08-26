/**
 * 斜杠命令注册表（对标 panda-code/commands 覆盖面）
 */
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawnSync } = require('child_process')

function tip (title, lines) {
  return ['**' + title + '**', ''].concat(lines || []).join('\n')
}
function notPorted (name, alt) {
  return tip('/' + name, [
    '该命令在 panda-code 存在；Web 版未完整移植（桌面/计费/远程等产品能力）。',
    alt ? ('可用替代：' + alt) : '见 /help · 已实现命令不带「未移植」标记。'
  ])
}

function buildRegistry () {
  const R = {}
  const add = (name, desc, run, meta) => {
    R[name] = { desc, run, stub: !!(meta && meta.stub) }
  }

  add('help', '显示帮助', async (arg, ctx) => {
    const names = Object.keys(R).sort()
    if (arg === 'all' || arg === '--all') {
      return ['全部斜杠命令（' + names.length + '）：', ''].concat(
        names.map(n => '`/' + n + '` — ' + R[n].desc + (R[n].stub ? ' · 未移植' : ''))
      ).join('\n')
    }
    if (arg && R[arg]) {
      return tip('/' + arg, [R[arg].desc + (R[arg].stub ? '（未移植）' : '')])
    }
    const real = names.filter(n => !R[n].stub)
    const stubs = names.filter(n => R[n].stub)
    return [
      '已实现（' + real.length + '）：',
      '',
      ...real.map(n => '`/' + n + '` — ' + R[n].desc),
      '',
      '未移植 / 产品向（' + stubs.length + '，`/help all` 展开）：',
      stubs.map(n => '`/' + n + '`').join(' · '),
      '',
      '提示：`/help <命令>` 看单条说明。'
    ].join('\n')
  })
  add('?', '同 help', async (arg, ctx) => R.help.run(arg, ctx))

  add('vim', '切换 Vim 模式', async (arg, ctx) => {
    const cur = !!(ctx.runtime.context && ctx.runtime.context.vimMode)
    const next = arg === 'on' ? true : arg === 'off' ? false : !cur
    ctx.runtime.context = ctx.runtime.context || {}
    ctx.runtime.context.vimMode = next
    if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_set_vim', { enabled: next })
    return next ? '已开启 Vim：Esc=NORMAL，i/a/o=INSERT。' : '已关闭 Vim。'
  })

  add('version', '版本', async () => {
    let v = 'dev'
    try { v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')).version || v } catch (e) {}
    return tip('版本', ['AIFront Panda ' + v, 'Node ' + process.version])
  })

  add('doctor', '环境自检', async (arg, ctx) => {
    const panda = path.join(ctx.projectRoot, '.panda')
    const lines = [
      'API Key: ' + (process.env.DEEPSEEK_API_KEY ? '✓' : '✗'),
      '模型: ' + (process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
      '根目录: ' + ctx.projectRoot,
      '.panda: ' + (fs.existsSync(panda) ? '✓' : '✗')
    ]
    ;['MEMORY.md','mcp.json','hooks.json','lsp.json'].forEach(f => {
      lines.push('  ' + f + ': ' + (fs.existsSync(path.join(panda, f)) ? '✓' : '—'))
    })
    try {
      const st = await require('./lsp').getLspStatus(ctx.projectRoot)
      lines.push('LSP: ' + (st.configured ? (st.configured + ' server(s)') : '未配置（启发式）'))
      ;(st.servers || []).forEach(s => {
        lines.push('  - ' + s.name + ' [' + s.state + '] ' + (s.extensions || []).join(','))
      })
      if (st.note) lines.push('  ' + st.note)
    } catch (e) {
      lines.push('LSP: 状态读取失败')
    }
    return tip('Doctor', lines)
  })

  add('init', '初始化 .panda', async (arg, ctx) => {
    const root = path.join(ctx.projectRoot, '.panda')
    await fsp.mkdir(path.join(root, 'sessions'), { recursive: true })
    await fsp.mkdir(path.join(root, 'uploads'), { recursive: true })
    await fsp.mkdir(path.join(root, 'skills'), { recursive: true })
    await fsp.mkdir(path.join(root, 'forks'), { recursive: true })
    const ensure = async (rel, body) => {
      const p = path.join(root, rel)
      if (!fs.existsSync(p)) await fsp.writeFile(p, body, 'utf8')
    }
    await ensure('MEMORY.md', '# Panda Memory\n')
    await ensure('mcp.json', '{ "servers": {} }\n')
    await ensure('hooks.json', JSON.stringify({
      PreToolUse: [],
      PostToolUse: [],
      Stop: [],
      UserPromptSubmit: [],
      SessionStart: [],
      SessionEnd: [],
      PermissionRequest: [],
      PermissionDenied: [],
      PostToolUseFailure: [],
      PreCompact: [],
      PostCompact: [],
      SubagentStart: [],
      SubagentStop: []
    }, null, 2) + '\n')
    await ensure('lsp.json', '{ "servers": {} }\n')
    return '已初始化 .panda/'
  })

  add('config', '配置', async (arg, ctx) => {
    const cfg = require('./config')
    if (!arg) return '```json\n' + JSON.stringify(await cfg.getAll(ctx.projectRoot), null, 2) + '\n```'
    const m = arg.match(/^(?:set\s+)?(\S+)\s+(.+)$/i)
    if (m) { await cfg.set(ctx.projectRoot, m[1], m[2]); return '已设置 ' + m[1] + ' = ' + m[2] }
    return arg + ' = ' + JSON.stringify(await cfg.get(ctx.projectRoot, arg))
  })

  add('files', '关注文件', async (arg, ctx) => {
    const { listHistory } = require('./fileHistory')
    const list = await listHistory(ctx.projectRoot, '', 15)
    const active = (ctx.runtime.context && (ctx.runtime.context.activeFile || ctx.runtime.context.preferredFile)) || '(无)'
    return tip('Files', ['焦点: ' + active, ''].concat(list.map(i => '- ' + i.at + ' `' + i.file + '`')))
  })

  add('export', '导出会话', async (arg, ctx) => {
    const session = require('./session')
    const id = arg || ctx.runtime.sessionId
    if (!id) return '无 sessionId'
    const entries = await session.loadRecentTranscript(ctx.projectRoot, id, 500)
    const outDir = path.join(ctx.projectRoot, '.panda', 'exports')
    await fsp.mkdir(outDir, { recursive: true })
    const out = path.join(outDir, id + '.md')
    const md = entries.map(e => {
      if (e.type === 'user') return '## User\n\n' + e.content
      if (e.type === 'assistant') return '## Assistant\n\n' + e.content
      if (e.type === 'tool') return '- tool `' + (e.facing || e.name) + '`'
      return '- ' + (e.type || '') + ': ' + (e.content || '')
    }).join('\n\n')
    await fsp.writeFile(out, md, 'utf8')
    return '已导出: `' + path.relative(ctx.projectRoot, out) + '`'
  })

  add('rename', '重命名会话', async (arg, ctx) => {
    if (!arg) return '用法: /rename 标题'
    await require('./session').touchSessionMeta(ctx.projectRoot, ctx.runtime.sessionId, { title: arg.slice(0, 80) })
    if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_rename', { title: arg.slice(0, 80) })
    return '已重命名: ' + arg.slice(0, 80)
  })

  add('resume', '列/恢复会话', async (arg, ctx) => {
    const session = require('./session')
    if (!arg) {
      const list = await session.listSessions(ctx.projectRoot)
      return tip('Sessions', list.slice(0, 20).map(s => '- `' + s.id + '` ' + (s.title || '')))
    }
    if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_resume', { sessionId: arg })
    return '请切换会话: `' + arg + '`'
  })

  add('rewind', '回退文件', async (arg, ctx) => (await require('./fileHistory').undoLast(ctx.projectRoot, arg || '')).message)
  add('undo', '同 rewind', async (arg, ctx) => R.rewind.run(arg, ctx))
  add('history', '文件历史', async (arg, ctx) => {
    const list = await require('./fileHistory').listHistory(ctx.projectRoot, arg || '', 15)
    return list.length ? list.map(i => '- ' + i.at + ' ' + i.file).join('\n') : '(无)'
  })
  add('diff', '文件 diff（快照或 git）', async (arg, ctx) => {
    const file = String(arg || '').trim() ||
      (ctx.runtime.context && (ctx.runtime.context.activeFile || ctx.runtime.context.preferredFile)) || ''
    const r = await require('./fileHistory').showDiff(ctx.projectRoot, file)
    if (!r.ok) return r.message
    return tip('Diff · ' + (r.source || '') + (r.file ? ' · ' + r.file : ''), [
      r.at ? ('快照: ' + r.at) : '',
      '```diff',
      r.content,
      '```'
    ].filter(Boolean))
  })

  add('copy', '复制提示', async () => '请在消息上选择复制，或 /export')
  add('context', '上下文粗估', async (arg, ctx) => {
    const cost = require('./cost')
    const hist = (ctx.runtime.context && ctx.runtime.context.history) || []
    const chars = hist.reduce((a, m) => a + String(m.content || '').length, 0)
    return tip('Context', ['history: ' + hist.length + ' 条 / ' + chars + ' 字符', 'readFileState: ' + (ctx.runtime.readFileState ? ctx.runtime.readFileState.size : 0), '', cost.formatUsage(cost.getUsage(ctx.runtime.sessionId))])
  })
  add('ctx_viz', '上下文可视化', async (arg, ctx) => R.context.run(arg, ctx))
  add('effort', '推理力度', async (arg, ctx) => {
    ctx.runtime.context = ctx.runtime.context || {}
    ctx.runtime.context.effort = (arg || 'normal').toLowerCase()
    return 'effort=' + ctx.runtime.context.effort
  })
  add('fast', '快速模式', async (arg, ctx) => {
    ctx.runtime.context = ctx.runtime.context || {}
    ctx.runtime.context.fastMode = !ctx.runtime.context.fastMode
    if (ctx.runtime.context.fastMode) {
      ctx.runtime.context.model = 'deepseek-chat'
      if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_set_model', { model: 'deepseek-chat' })
    }
    return ctx.runtime.context.fastMode ? 'fast on' : 'fast off'
  })
  add('theme', '主题', async () => '工作台深色主题固定')
  add('color', '颜色', async () => '见 PandaWorkbench CSS 变量')
  add('keybindings', '快捷键', async () => tip('Keys', ['Enter 发送', 'Shift+Enter 换行', 'Vim: Esc NORMAL · i/a/A/I/o/O INSERT', '操符: d/c/y + iw/aw/i"/a(/a{/a[/diw/daw/dd/cc/yy', '运动: hjkl w b 0 $ gg G · p/P · x · ~', '粘贴图片: Ctrl/Cmd+V（需配置 DEEPSEEK_VISION_MODEL 才走多模态）', '停止按钮中断']))
  add('sandbox-toggle', '切换危险命令沙箱', async (arg, ctx) => {
    const cfg = require('./config')
    const cur = await cfg.get(ctx.projectRoot, 'sandbox')
    const on = cur !== false
    let next
    if (arg === 'on') next = true
    else if (arg === 'off') next = false
    else next = !on
    await cfg.set(ctx.projectRoot, 'sandbox', next)
    return next
      ? '沙箱已开启：危险 bash（rm -rf / sudo / force-push 等）拦截。'
      : '沙箱已关闭：危险 bash 拦截关闭（仍受 Plan/Verify 模式约束）。路径越界规则仍生效。'
  })
  add('permissions', '权限规则', async (arg, ctx) => {
    const pr = require('./permissionRules')
    const a = String(arg || '').trim()
    if (a === 'clear-cache') {
      pr.clearRulesCache(ctx.projectRoot)
      return '已清除 permissions 规则缓存'
    }
    const rm = a.match(/^remove\s+(deny|allow|ask)\s+(.+)$/i)
    if (rm) {
      const out = await pr.removePersistentRule(ctx.projectRoot, rm[1].toLowerCase(), rm[2].trim())
      return out.ok
        ? ('已删除 ' + out.removed + ' 条 ' + out.list + ' 规则')
        : ('删除失败：' + (out.reason || 'unknown'))
    }
    const addM = a.match(/^add\s+(deny|allow|ask)\s+(.+)$/i)
    if (addM) {
      const list = addM[1].toLowerCase()
      const rest = addM[2].trim()
      const open = rest.indexOf('(')
      let tool = rest
      let detail = ''
      if (open > 0 && rest.endsWith(')')) {
        tool = rest.slice(0, open)
        detail = rest.slice(open + 1, -1)
      }
      const out = await pr.appendPersistentRule(ctx.projectRoot, list, tool, detail)
      return out.ok ? ('已添加 ' + out.list + '：' + out.entry) : '添加失败'
    }
    const summary = await pr.formatRulesSummary(ctx.projectRoot)
    return summary + '\n\n用法：`/permissions` · `/permissions add deny Bash(rm:*)` · `/permissions remove deny Bash(rm` · `/permissions clear-cache`'
  })
  add('login', '登录', async () => '使用 .env.local 的 DEEPSEEK_API_KEY')
  add('logout', '登出', async () => '删除 DEEPSEEK_API_KEY 即可')
  add('exit', '退出', async () => '关闭 /panda 页面；服务端 Ctrl+C')
  add('agents', 'Fork 列表', async (arg, ctx) => '```json\n' + JSON.stringify(require('./agentFork').listForks(ctx.projectRoot), null, 2) + '\n```')
  add('fork', '启动 Fork（继承 sidechain/权限）', async (arg, ctx) => {
    if (!arg) return '用法: /fork [explore|plan|verify|fork|implementer] 目标'
    let type = 'fork', goal = arg
    const m = arg.match(/^(explore|plan|verify|fork|general|implementer)\s+([\s\S]+)/i)
    if (m) { type = m[1].toLowerCase(); goal = m[2] }
    const report = await require('./agentFork').runFork(ctx.projectRoot, {
      type, goal,
      parentSessionId: ctx.runtime.sessionId,
      forkContextMessages: ctx.runtime.sidechainMessages || [],
      readFileState: ctx.runtime.readFileState,
      parentRequirePermission: ctx.runtime.requirePermission,
      parentMode: ctx.runtime.mode,
      parentContext: ctx.runtime.context,
      model: 'inherit',
      permissionMode: (type === 'explore' || type === 'plan' || type === 'verify') ? 'plan' : 'bubble',
      writable: type === 'implementer',
      onProgress: (k, msg) => { if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('step', { message: msg }) },
      sendEvent: ctx.runtime.sendEvent
    })
    return '【Fork ' + report.id + ' · ' + type + ' · ' + report.permissionMode + '】\n\n' + report.result
  })
  add('review', '代码审查', async (arg, ctx) => require('./subagents').runVerifyAgent(arg || '审查最近改动', ctx.projectRoot, ctx.runtime.changedFiles || []))
  add('security-review', '安全审查', async (arg, ctx) => require('./subagents').runExploreAgent('安全审查 ' + (arg || ''), ctx.projectRoot))
  add('commit', 'commit 建议', async (arg, ctx) => {
    const st = spawnSync('git', ['status', '-sb'], { cwd: ctx.projectRoot, encoding: 'utf8' })
    const diff = spawnSync('git', ['diff', '--stat'], { cwd: ctx.projectRoot, encoding: 'utf8' })
    return tip('Commit', ['```', (st.stdout || '').trim(), (diff.stdout || '').trim(), '```', arg || ''])
  })
  add('commit-push-pr', 'PR 指引', async () => tip('PR', ['git add/commit/push', 'gh pr create', 'Agent 默认不自动 push']))
  add('branch', '当前分支', async (arg, ctx) => {
    const r = spawnSync('git', ['branch', '--show-current'], { cwd: ctx.projectRoot, encoding: 'utf8' })
    return '分支: `' + (r.stdout || '').trim() + '`'
  })
  add('tasks', '后台任务', async (arg, ctx) => '```json\n' + JSON.stringify(require('./backgroundTasks').listTasks(ctx.projectRoot), null, 2) + '\n```')
  add('stats', '用量', async (arg, ctx) => require('./cost').formatUsage(require('./cost').getUsage(ctx.runtime.sessionId)))
  add('usage', '用量', async (arg, ctx) => R.stats.run(arg, ctx))
  add('cost', '费用', async (arg, ctx) => R.stats.run(arg, ctx))
  add('status', '状态', async (arg, ctx) => {
    const abortRegistry = require('./abortRegistry')
    return ['session: ' + (ctx.runtime.sessionId || '-'), 'mode: ' + (ctx.runtime.mode || 'default'), 'vim: ' + !!(ctx.runtime.context && ctx.runtime.context.vimMode), 'model: ' + ((ctx.runtime.context && ctx.runtime.context.model) || process.env.DEEPSEEK_MODEL || 'deepseek-chat'), 'running: ' + !!abortRegistry.getSignal(ctx.runtime.sessionId), '', require('./cost').formatUsage(require('./cost').getUsage(ctx.runtime.sessionId))].join('\n')
  })
  add('statusline', '状态栏', async () => '顶栏显示 Bridge / tokens')
  add('brief', '简报', async (arg, ctx) => (await require('./tools').executeTool('brief', { note: arg || '' }, ctx.runtime)).content)
  add('btw', '旁路短问', async (arg, ctx) => {
    if (!arg) return '用法: /btw 问题'
    return require('../shared-llm').callDeepseekText('简短回答，不改代码。', arg, { max_tokens: 600 })
  })
  add('insights', '洞察', async (arg, ctx) => {
    const entries = await require('./session').loadRecentTranscript(ctx.projectRoot, ctx.runtime.sessionId, 200)
    const tools = entries.filter(e => e.type === 'tool')
    return tip('Insights', ['条目 ' + entries.length, '工具 ' + tools.length, '失败 ' + tools.filter(t => t.ok === false).length])
  })
  add('heapdump', '内存', async () => JSON.stringify(process.memoryUsage()))
  add('env', '环境', async () => tip('Env', ['DEEPSEEK_MODEL=' + (process.env.DEEPSEEK_MODEL || 'deepseek-chat'), 'CLAW_AGENT_MAX_ROUNDS=' + (process.env.CLAW_AGENT_MAX_ROUNDS || '24')]))
  add('release-notes', '更新说明', async () => tip('Notes', ['写码管线 FileEdit 级', '流式/停止/thinking/Diff', '斜杠扩表 + fork + vim + 图片粘贴']))
  add('bug', '反馈', async () => '请附 /export transcript 提 Issue')
  add('feedback', '反馈', async () => R.bug.run('', {}))
  add('issue', '反馈', async () => R.bug.run('', {}))
  add('desktop', '桌面端', async () => notPorted('desktop', '/panda 网页工作台'), { stub: true })
  add('mobile', '移动', async () => '用手机浏览器打开 /panda')
  add('ide', 'IDE / Bridge 状态', async (arg, ctx) => {
    const bridge = require('./bridge')
    const stats = bridge.bridgeStats()
    const sid = ctx.runtime.sessionId || 'default'
    return tip('IDE / Bridge', [
      'session: `' + sid + '`',
      'WebSocket: `/panda-bridge?session=' + sid + '`',
      'stats: ' + JSON.stringify(stats),
      '',
      '远程可发 `{ "type":"inject_user", "content":"..." }` 注入消息。',
      '踢线测试: `/bridge-kick`'
    ])
  })
  add('chrome', '截取/打开页面', async (arg, ctx) => {
    const url = String(arg || '').trim()
    if (!url) {
      return tip('Chrome', [
        '用法: `/chrome http://localhost:8080/panda`',
        '对标 panda-code /chrome；本环境用 Puppeteer 截图（capture_page）。',
        '也可让 Agent 调 `capture_page` / `web_fetch`。'
      ])
    }
    try {
      const r = await require('./pageCapture').capturePage(ctx.projectRoot, { url })
      if (!r || r.ok === false) return '截图失败：' + ((r && r.content) || (r && r.message) || 'unknown')
      return tip('Chrome', [
        'url: ' + url,
        r.content || '已截取',
        r.meta && r.meta.screenshot ? ('文件: ' + r.meta.screenshot) : ''
      ].filter(Boolean))
    } catch (e) {
      return '截图失败：' + (e.message || e)
    }
  })
  add('plugin', '插件 / Skills', async (arg, ctx) => {
    const skills = await require('./skills').loadSkills(ctx.projectRoot)
    return tip('Plugin → Skills', [
      'Marketplace 插件未移植；本地 Skills 等价：',
      ...skills.map(s => '- `' + s.id + '` — ' + s.title + ' (' + s.path + ')'),
      '',
      '目录: `.panda/skills/*.md` · 重载: `/reload-plugins` · 调用: skill 工具'
    ])
  })
  add('reload-plugins', '重载 Skills', async (arg, ctx) => {
    const skillsMod = require('./skills')
    skillsMod.clearSkillsCache()
    const skills = await skillsMod.loadSkills(ctx.projectRoot, { force: true })
    return '已重载 Skills（' + skills.length + '）：' + skills.map(s => s.id).join(', ')
  })
  add('install', '安装', async () => 'npm install && npm run server')
  add('install-github-app', 'GH App', async () => notPorted('install-github-app', '本机 gh auth / 手动配置'), { stub: true })
  add('install-slack-app', 'Slack', async () => notPorted('install-slack-app'), { stub: true })
  add('voice', '语音', async () => notPorted('voice', '浏览器语音输入或粘贴文字'), { stub: true })
  add('stickers', '贴纸', async () => notPorted('stickers'), { stub: true })
  add('advisor', '顾问', async () => '用 /btw 或 /plan')
  add('ultraplan', '加强计划', async (arg, ctx) => require('./subagents').runPlanAgent(arg || '深入规划', ctx.projectRoot, ''))
  add('output-style', '输出风格', async (arg, ctx) => {
    const cfg = require('./config')
    const styles = require('./outputStyles')
    const list = await styles.listStyles(ctx.projectRoot)
    if (!arg) {
      const cur = (ctx.runtime.context && ctx.runtime.context.outputStyle) ||
        (await cfg.get(ctx.projectRoot, 'outputStyle')) || 'default'
      return tip('Output style', [
        '当前: `' + cur + '`',
        '内置: ' + list.builtin.join(', '),
        list.custom.length ? ('自定义: ' + list.custom.join(', ')) : '自定义: 在 `.panda/output-styles/*.md` 添加',
        '',
        '用法: `/output-style default|Explanatory|Learning|<custom>`'
      ])
    }
    const name = arg.trim()
    ctx.runtime.context = ctx.runtime.context || {}
    ctx.runtime.context.outputStyle = name
    await cfg.set(ctx.projectRoot, 'outputStyle', name)
    return 'output-style → ' + name + '（下一轮 system prompt 生效；建议 /clear 后重开任务）'
  })
  add('language', '回复语言', async (arg, ctx) => {
    const cfg = require('./config')
    if (!arg) {
      const cur = (ctx.runtime.context && ctx.runtime.context.language) ||
        (await cfg.get(ctx.projectRoot, 'language')) || '简体中文'
      return '当前语言: `' + cur + '` · 用法: `/language English` 或 `/language 简体中文`'
    }
    const lang = arg.trim()
    ctx.runtime.context = ctx.runtime.context || {}
    ctx.runtime.context.language = lang
    await cfg.set(ctx.projectRoot, 'language', lang)
    return 'language → ' + lang + '（下一轮生效）'
  })
  add('tag', '标签', async (arg, ctx) => {
    if (!arg) return '用法: /tag 名'
    await require('./session').touchSessionMeta(ctx.projectRoot, ctx.runtime.sessionId, { tag: arg })
    return '已标记 ' + arg
  })
  add('session', '会话', async (arg, ctx) => 'id=' + (ctx.runtime.sessionId || '-') + ' · /resume /rename /export')
  add('clear', '清空会话上下文（对齐 panda-code /clear）', async (arg, ctx) => {
    ctx.runtime.todos = []
    ctx.runtime.changedFiles = []
    ctx.runtime.lastUserGoal = ''
    ctx.runtime.didVerify = false
    ctx.runtime.sidechainMessages = []
    ctx.runtime.clearSessionContext = true
    if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_clear', {})
    return '__CLEAR_UI__'
  })
  add('compact', '压缩', async (arg, ctx) => { ctx.runtime.requestCompact = true; return '已标记压缩' })
  add('plan', 'Plan', async (arg, ctx) => { ctx.runtime.mode = 'plan'; return 'Plan Mode（只读）' })
  add('agent', 'Agent', async (arg, ctx) => { ctx.runtime.mode = 'default'; return 'Agent Mode（可写）' })
  add('model', '模型', async (arg, ctx) => {
    ctx.runtime.context = ctx.runtime.context || {}
    if (arg) {
      ctx.runtime.context.model = arg
      if (ctx.runtime.sendEvent) ctx.runtime.sendEvent('panda_set_model', { model: arg })
      return '模型 → ' + arg
    }
    return '当前: ' + (ctx.runtime.context.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat')
  })
  add('stop', '中断', async (arg, ctx) => require('./abortRegistry').abortRun(ctx.runtime.sessionId) ? '已中断' : '无运行中任务')
  add('hooks', 'Hooks', async (arg, ctx) => '```json\n' + JSON.stringify(await require('./hooks').loadHooks(ctx.projectRoot), null, 2) + '\n```')
  add('mcp', 'MCP', async (arg, ctx) => {
    const mcp = require('./mcp')
    const a = String(arg || '').trim()
    if (!a || a === 'list') {
      await mcp.ensureConnected(ctx.projectRoot)
      const cfg = await mcp.loadMcpConfig(ctx.projectRoot)
      const connected = await mcp.listConnected(ctx.projectRoot)
      const tools = mcp.getOpenAiToolDefinitions(ctx.projectRoot).map(t => t.function.name)
      return JSON.stringify({
        autoConnect: cfg.autoConnect !== false,
        configured: Object.keys(cfg.servers || {}),
        connected,
        mountedTools: tools,
        pendingOAuth: mcp.getPendingOAuth()
      }, null, 2)
    }
    if (a === 'auto' || a.startsWith('auto')) {
      const r = await mcp.ensureConnected(ctx.projectRoot, { force: true, reconnect: true })
      return JSON.stringify(r, null, 2)
    }
    if (a.startsWith('connect ')) {
      const name = a.slice(8).trim()
      const info = await mcp.connectServer(ctx.projectRoot, name)
      return '已连接 ' + name + '\n' + JSON.stringify(info, null, 2)
    }
    if (a.startsWith('token ')) {
      // /mcp token serverName eyJ...
      const parts = a.slice(6).trim().split(/\s+/)
      const server = parts[0]
      const token = parts.slice(1).join(' ')
      if (!server || !token) return '用法: /mcp token <server> <access_token>'
      await mcp.saveOAuthTokens(ctx.projectRoot, server, { access_token: token, token_type: 'Bearer' })
      try {
        const info = await mcp.connectServer(ctx.projectRoot, server)
        return '已保存 token 并重连 ' + server + '\n' + JSON.stringify(info, null, 2)
      } catch (e) {
        return 'token 已保存，连接失败：' + e.message
      }
    }
    return '用法: /mcp | /mcp auto | /mcp connect name | /mcp token server access_token'
  })
  add('worktree', 'Worktree', async (arg, ctx) => {
    const wt = require('./worktree')
    if (!arg || arg === 'status') return JSON.stringify(await wt.currentWorktree(ctx.projectRoot), null, 2) || '无'
    if (arg === 'exit' || arg.startsWith('exit')) return (await wt.exitWorktree(ctx.projectRoot, { remove: true })).message
    const r = await wt.enterWorktree(ctx.projectRoot, arg.replace(/^enter\s*/, ''))
    if (r.ok && r.worktreePath) ctx.runtime.projectRoot = r.worktreePath
    return r.message
  })
  add('cron', 'Cron', async (arg, ctx) => {
    const cron = require('./cron')
    if (arg && arg.startsWith('tick')) return JSON.stringify(await cron.tickCron(ctx.projectRoot), null, 2)
    return JSON.stringify(await cron.listCron(ctx.projectRoot), null, 2)
  })
  add('team', 'Team', async (arg, ctx) => JSON.stringify(require('./team').listTeams(ctx.projectRoot), null, 2))
  add('lsp', 'LSP', async (arg, ctx) => {
    const lsp = require('./lsp')
    const raw = String(arg || '').trim()
    if (!raw || raw === 'status') {
      const st = await lsp.getLspStatus(ctx.projectRoot)
      return tip('LSP', [
        st.note || '',
        'configured: ' + st.configured,
        ...(st.servers || []).map(s =>
          '- ' + s.name + ' [' + s.state + '] cmd=' + s.command + ' exts=' + (s.extensions || []).join(',')
        )
      ].filter(Boolean))
    }
    const file = raw || (ctx.runtime.context && (ctx.runtime.context.activeFile || ctx.runtime.context.preferredFile)) || ''
    if (!file) return '用法: /lsp path | /lsp status'
    return (await lsp.getDiagnostics(ctx.projectRoot, file)).content
  })
  add('swarm', 'Swarm', async (arg, ctx) => {
    if (!arg) return '用法: /swarm 目标'
    const report = await require('./swarm').runSwarm(ctx.projectRoot, arg, { onProgress: (k, m) => ctx.runtime.sendEvent && ctx.runtime.sendEvent('step', { message: m }) })
    return '【Swarm ' + report.id + '】\n\n' + (report.synthesis || '')
  })
  add('bridge', 'Bridge', async (arg, ctx) => 'session=' + (ctx.runtime.sessionId || '') + '\n' + JSON.stringify(require('./bridge').bridgeStats(), null, 2))
  add('bridge-kick', 'Bridge 踢线/探活', async (arg, ctx) => {
    const bridge = require('./bridge')
    const sid = ctx.runtime.sessionId || 'default'
    const n = bridge.broadcast(sid, {
      event: 'bridge_kick',
      message: 'slash /bridge-kick',
      at: new Date().toISOString()
    })
    return tip('Bridge kick', [
      'session: `' + sid + '`',
      'clients notified: ' + (typeof n === 'number' ? n : JSON.stringify(bridge.bridgeStats())),
      'stats: ' + JSON.stringify(bridge.bridgeStats())
    ])
  })
  add('add-dir', '附加可读根目录', async (arg, ctx) => {
    const cfg = require('./config')
    const raw = String(arg || '').trim()
    const all = await cfg.getAll(ctx.projectRoot)
    const roots = Array.isArray(all.extraRoots) ? all.extraRoots.slice() : []
    if (!raw || raw === 'list') {
      return tip('extraRoots', roots.length ? roots.map(r => '- ' + r) : ['(空) — 用法: `/add-dir /abs/path`'])
    }
    if (raw === 'clear') {
      await cfg.saveConfig(ctx.projectRoot, { extraRoots: [] })
      return '已清空 extraRoots'
    }
    const abs = path.resolve(raw.replace(/^add\s+/i, ''))
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return '目录不存在: ' + abs
    }
    if (!roots.includes(abs)) roots.push(abs)
    await cfg.saveConfig(ctx.projectRoot, { extraRoots: roots })
    return tip('已添加 extraRoot', ['`' + abs + '`', '', '当前:', ...roots.map(r => '- ' + r)])
  })
  add('oauth-refresh', '刷新 MCP OAuth / 重连', async (arg, ctx) => {
    const mcp = require('./mcp')
    const name = String(arg || '').trim()
    const store = await mcp.loadOAuthStore(ctx.projectRoot)
    const servers = name ? [name] : Object.keys(store || {})
    if (!servers.length) {
      return tip('OAuth', [
        '无已存 token（.panda/mcp-oauth.json）。',
        '用法: `/mcp token <server> <access_token>` 后 `/oauth-refresh [server]`',
        '或 `/mcp auto` 强制重连。'
      ])
    }
    const r = await mcp.ensureConnected(ctx.projectRoot, { force: true, reconnect: true })
    return tip('OAuth refresh', [
      'targets: ' + servers.join(', '),
      JSON.stringify(r, null, 2)
    ])
  })
  add('pr_comments', 'PR 评论（gh）', async (arg, ctx) => {
    const a = String(arg || '').trim()
    const args = ['pr', 'view']
    if (a) args.push(a)
    args.push('--comments')
    const r = spawnSync('gh', args, {
      cwd: ctx.projectRoot,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    })
    if (r.status !== 0) {
      return tip('PR', [
        '需要已安装并登录 `gh`。',
        (r.stderr || r.stdout || '').trim().slice(0, 800) || 'gh pr view 失败',
        '',
        '用法: `/pr_comments` 或 `/pr_comments 123`'
      ])
    }
    return tip('PR comments', ['```', (r.stdout || '').trim().slice(0, 8000), '```'])
  })
  add('pr-comments', '同 pr_comments', async (arg, ctx) => R.pr_comments.run(arg, ctx))
  add('bughunter', '探索式排错', async (arg, ctx) => {
    const goal = String(arg || '').trim() || '查找最近改动中的可疑 bug 与回归风险'
    return require('./subagents').runExploreAgent(goal, ctx.projectRoot)
  })
  add('backfill-sessions', '会话索引回填', async (arg, ctx) => {
    const session = require('./session')
    const list = await session.listSessions(ctx.projectRoot)
    let n = 0
    for (const s of list.slice(0, 50)) {
      await session.touchSessionMeta(ctx.projectRoot, s.id, { title: s.title || s.id })
      n++
    }
    return '已回触 ' + n + ' 个会话 meta（最多 50）'
  })
  add('debug-tool-call', '工具调用调试提示', async (arg, ctx) => {
    const entries = await require('./session').loadRecentTranscript(ctx.projectRoot, ctx.runtime.sessionId, 80)
    const tools = entries.filter(e => e.type === 'tool').slice(-10)
    return tip('Recent tools', tools.length
      ? tools.map(t => '- ' + (t.ok === false ? '✗' : '✓') + ' `' + (t.facing || t.name) + '`')
      : ['(无) — 也可用 /export 导出 transcript'])
  })
  add('memory', '记忆索引/读写', async (arg, ctx) => {
    const mem = require('./memory').createMemory(ctx.projectRoot)
    const a = String(arg || '').trim()
    if (!a) return (await mem.read()) || '(空索引)'
    if (a === 'dream' || a.startsWith('dream')) {
      const r = await require('./memoryIndex').runAutoDream(ctx.projectRoot)
      return tip('autoDream', r.notes || [])
    }
    if (a.startsWith('read ')) {
      return await mem.read(a.slice(5).trim())
    }
    const m = a.match(/^(?:append\s+)?(?:#(\S+)\s+)?([\s\S]+)$/)
    const topic = m && m[1] ? m[1] : 'general'
    const note = m ? m[2] : a
    const id = await mem.append(note, topic)
    return '已写入 topic=`' + id + '`: ' + note.slice(0, 120)
  })
  add('dream', '空闲记忆整合', async (arg, ctx) => {
    const r = await require('./memoryIndex').runAutoDream(ctx.projectRoot)
    return tip('autoDream', r.notes || ['done'])
  })
  add('skills', 'Skills', async (arg, ctx) => {
    const skills = await require('./skills').loadSkills(ctx.projectRoot)
    return skills.map(s => '- ' + s.id + ': ' + s.title).join('\n') || '(无)'
  })
  add('uploads', '上传图片', async (arg, ctx) => {
    try {
      const files = await fsp.readdir(path.join(ctx.projectRoot, '.panda', 'uploads'))
      return files.length ? files.map(f => '- .panda/uploads/' + f).join('\n') : '(无)'
    } catch (e) { return '(无 uploads)' }
  })
  // 未移植：Anthropic 桌面/计费/远程/内部工具（保留名字对齐 panda-code /help）
  const deferred = [
    ['autofix-pr', '自动修 PR', '用 /review 或 Agent 手动修'],
    ['break-cache', '破缓存', '/clear 或 /compact'],
    ['extra-usage', '额外用量', '/usage · DeepSeek 侧无此计费'],
    ['good-claude', '好评内部', null],
    ['onboarding', '引导', '/doctor · /init'],
    ['passes', 'Passes', '/usage'],
    ['perf-issue', '性能 issue', '/insights'],
    ['privacy-settings', '隐私设置', null],
    ['rate-limit-options', '限流选项', null],
    ['remote-env', '远程环境', '/worktree'],
    ['remote-setup', '远程安装', '/bridge · /ide'],
    ['reset-limits', '重置限额', null],
    ['thinkback', 'Think back', '/btw'],
    ['upgrade', '升级订阅', null],
    ['mock-limits', '模拟限额', null],
    ['ant-trace', '内部 trace', '/heapdump']
  ]
  deferred.forEach(([n, desc, alt]) => {
    add(n, desc + '（未移植）', async () => notPorted(n, alt), { stub: true })
  })

  return R
}

let _registry = null
function getRegistry () {
  if (!_registry) _registry = buildRegistry()
  return _registry
}

async function runSlashCommand (cmd, arg, runtime) {
  const entry = getRegistry()[cmd] || getRegistry()[String(cmd || '').toLowerCase()]
  if (!entry) return null
  const reply = await entry.run(arg, { projectRoot: runtime.projectRoot, runtime })
  const sideEffects = {}
  if (reply === '__CLEAR_UI__') sideEffects.clearUi = true
  return { handled: true, reply: String(reply == null ? '' : reply), sideEffects }
}

function listCommandNames () {
  return Object.keys(getRegistry()).sort()
}

function listCommands () {
  const R = getRegistry()
  return Object.keys(R).sort().map(name => ({
    name,
    desc: R[name].desc || '',
    stub: !!R[name].stub
  }))
}

module.exports = { getRegistry, runSlashCommand, listCommandNames, listCommands }
