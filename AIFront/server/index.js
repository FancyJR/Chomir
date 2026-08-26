/* eslint-disable no-console */
const path = require('path')
// 从项目根 / 桌面端指定路径加载 .env.local（与 server 所在目录无关）
const envPath = (process.env.CHOMIRCODE_ENV_PATH || process.env.AIFRONT_ENV_PATH)
  ? path.resolve(process.env.CHOMIRCODE_ENV_PATH || process.env.AIFRONT_ENV_PATH)
  : path.resolve(__dirname, '..', '.env.local')
const dotenvResult = require('dotenv').config({ path: envPath })
console.log('[server] .env.local 路径:', envPath, '加载变量数:', dotenvResult && dotenvResult.parsed ? Object.keys(dotenvResult.parsed).length : 0)

const express = require('express')
const fs = require('fs')
const fsp = fs.promises
const { spawn } = require('child_process')
let prettier
try {
  // prettier 为开发依赖，若未安装则相关功能自动关闭
  // eslint-disable-next-line global-require
  prettier = require('prettier')
} catch (e) {
  prettier = null
}
// 通用引擎模块
const engineAnalyzer = require('./engine/analyzer')
const enginePlanner = require('./engine/planner')
const engineCodegen = require('./engine/codegen')
const engineApplier = require('./engine/applier')
const engineRouter = require('./engine/router')
const engineThinker = require('./engine/thinker')
const engineQa = require('./engine/qa')
const engineRepair = require('./engine/repair')
const pandaAgent = require('./engine/panda')
const app = express()
app.use(express.json({ limit: '10mb' }))

// 停止按钮 abort 时，fetch/stream cancel 可能产生未捕获 AbortError，避免打崩进程
process.on('unhandledRejection', (reason) => {
  const name = reason && reason.name
  const msg = String((reason && reason.message) || reason || '')
  if (name === 'AbortError' || /aborted|已取消/i.test(msg)) {
    console.warn('[server] ignored abort rejection:', msg.slice(0, 120))
    return
  }
  console.error('[server] unhandledRejection:', reason)
})

/** 构建失败后自动修复的最大重试次数（不含首次写入） */
const MAX_REPAIR_ATTEMPTS = 2

/**
 * 写入并校验构建；若失败且存在回滚内容，则自动调用模型修复并重新写入，直到构建通过或达到最大重试次数。
 * @param {Array} files - 待写入的文件描述
 * @param {object} projectInfo - 工程信息
 * @param {string} [userInstruction] - 用户原始需求，传给修复模型以尽量保留
 * @param {function} [sendEvent] - (event, data) => void，可选，用于流式推送 repair_start / repair_retry 等
 * @returns {Promise<{ changed, buildOk, buildError, rolledBack, rolledBackContent }>}
 */
async function applyWithRepairRetry (files, projectInfo, userInstruction, sendEvent) {
  const noop = () => {}
  const send = typeof sendEvent === 'function' ? sendEvent : noop

  let applyResult = await engineApplier.apply(files, projectInfo)
  if (applyResult.buildOk) return applyResult

  const rolledBack = applyResult.rolledBack || []
  const rolledBackContent = applyResult.rolledBackContent || {}
  if (rolledBack.length === 0 || !rolledBackContent[rolledBack[0]]) {
    return applyResult
  }

  const firstFile = rolledBack[0]
  let contentToFix = rolledBackContent[firstFile]
  let buildError = applyResult.buildError

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS && contentToFix; attempt++) {
    send('repair_start', { file: firstFile, attempt, message: `正在根据构建错误自动修复（${attempt}/${MAX_REPAIR_ATTEMPTS}）…` })
    try {
      const fixedContent = await engineRepair.repairVueBuildError(firstFile, contentToFix, buildError, userInstruction)
      applyResult = await engineApplier.apply(
        [{ type: 'modify', file: firstFile, newContent: fixedContent }],
        projectInfo
      )
      if (applyResult.buildOk) {
        send('repair_done', { file: firstFile, attempt, message: '修复后构建已通过' })
        return applyResult
      }
      buildError = applyResult.buildError
      const nextContent = applyResult.rolledBackContent && applyResult.rolledBackContent[firstFile]
      contentToFix = nextContent || fixedContent
      send('repair_retry', { file: firstFile, attempt, buildErrorSnippet: (buildError || '').slice(0, 300) })
    } catch (e) {
      console.error('[engine] repair 失败', firstFile, e.message)
      send('repair_error', { file: firstFile, message: e.message || '修复请求失败' })
      break
    }
  }

  return applyResult
}

const PORT = process.env.PORT || 8787
// 官方：POST https://api.deepseek.com/chat/completions（无 /v1）
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')

function buildPrompt (payload) {
  const title = (payload && payload.title) || '生成页面'
  const description = (payload && payload.description) || ''
  const images = Array.isArray(payload && payload.images) ? payload.images : []
  const imageNames = images.slice(0, 10).map(i => i && i.name).filter(Boolean)
  const hasImage = imageNames.length > 0
  const imageNote = hasImage
    ? '用户上传了参考图（文件名：' + imageNames.join('、') + '）。当前接口仅支持文本，无法传图，请根据下方「页面名称」和「需求描述」生成页面；若用户在描述中写了布局、配色、模块等，请严格按描述实现。'
    : ''
  return [
    '你是前端页面生成器。必须使用 Element UI（Vue 2）写页面，界面要美观、统一，不要用原生 HTML 堆砌。',
    (imageNote ? imageNote + '\n\n' : ''),
    '========== 用户需求（必须严格遵循）==========',
    '页面名称：' + title,
    '需求描述：' + (description || (hasImage ? '（用户上传了参考图但未传图，请根据页面名称合理设计）' : '（未填写）')),
    '========== 以上为用户需求，请据此生成 ==========',
    '',
    '【技术约束】',
    '- Vue 2 单文件组件，必须使用 Element UI 组件（el-button、el-input、el-form、el-form-item、el-table、el-card、el-tabs、el-row/el-col、el-dialog、el-menu 等），不要用裸 div/span 做表单或列表。',
    '- style 加 scoped，可写少量 CSS 微调间距、颜色以贴近参考图。',
    '- 仅根据用户需求/参考图生成，不要编造无关模块（如指令市场、仪表盘等）。',
    '',
    '【输出格式】只输出一个 JSON，不要其他文字或 markdown 代码块。',
    'JSON 结构：{ "vueCode": "完整 Vue 2.0 单文件组件代码，含 <template><script><style>，export default，Element UI", "html": "body 内 HTML 用于 iframe 预览", "css": "全局样式用于预览" }',
    'html/css 不引用外部资源。'
  ].filter(Boolean).join('\n')
}

// 找到与第一个 { 匹配的 }，忽略字符串内的括号
function findJsonEnd (str, from) {
  let depth = 0
  let inStr = false
  let escape = false
  let quote = ''
  for (let i = from; i < str.length; i++) {
    const c = str[i]
    if (escape) {
      escape = false
      continue
    }
    if (inStr) {
      if (c === '\\') escape = true
      else if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// 去掉 ```json 或 ``` 包裹
function stripMarkdownJson (text) {
  let s = String(text || '').trim()
  if (/^```\s*json\s*/i.test(s)) {
    s = s.replace(/^```\s*json\s*/i, '').trim()
  } else if (/^```\s*/.test(s)) {
    s = s.replace(/^```\s*/, '').trim()
  }
  if (/```\s*$/.test(s)) {
    s = s.replace(/```\s*$/, '').trim()
  }
  return s
}

// 从可能被截断的文本中提取 "key": "value" 的 value（JSON 字符串，处理转义）
function extractJsonStringValue (str, key) {
  const keyLiteral = '"' + key + '"'
  const idx = str.indexOf(keyLiteral)
  if (idx === -1) return ''
  const afterKey = idx + keyLiteral.length
  const colonQuote = str.slice(afterKey).match(/^\s*:\s*"/)
  if (!colonQuote) return ''
  const valueStart = afterKey + colonQuote[0].length
  if (valueStart >= str.length) return ''
  let out = ''
  let i = valueStart
  while (i < str.length) {
    const c = str[i]
    if (c === '\\') {
      i += 1
      if (i < str.length) {
        const next = str[i]
        if (next === '"' || next === '\\' || next === '/' || next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') {
          out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next === 'b' ? '\b' : next === 'f' ? '\f' : next
        } else if (next === 'u' && i + 4 < str.length) {
          const hex = str.slice(i + 1, i + 5)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
          } else {
            out += next
          }
        } else {
          out += next
        }
      }
      i += 1
      continue
    }
    if (c === '"') break
    out += c
    i += 1
  }
  return out
}

// 先尝试完整解析，失败时从截断内容中提取 vueCode / html / css
function parseModelOutput (text) {
  const cleaned = stripMarkdownJson(text)
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && (typeof parsed.vueCode === 'string' || typeof parsed.html === 'string' || typeof parsed.css === 'string')) {
      return parsed
    }
  } catch (e) {
    // ignore
  }
  const start = cleaned.indexOf('{')
  if (start !== -1) {
    const slice = cleaned.slice(start)
    const end = findJsonEnd(slice, 0)
    if (end !== -1) {
      try {
        return JSON.parse(slice.slice(0, end + 1))
      } catch (e2) {
        // fall through to partial extract
      }
    }
  }
  // 截断时按字段提取
  const vueCode = extractJsonStringValue(cleaned, 'vueCode')
  const html = extractJsonStringValue(cleaned, 'html')
  const css = extractJsonStringValue(cleaned, 'css')
  if (vueCode || html || css) {
    return { vueCode: vueCode || '', html: html || '', css: css || '' }
  }
  return null
}

function safeJson (text) {
  return parseModelOutput(text)
}

const DEEPSEEK_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_TIMEOUT_MS, 10) || 120000

async function callDeepseek (payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    const err = new Error('NO_MODEL_CONFIG')
    err.status = 500
    throw err
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS)

  const prompt = buildPrompt(payload)
  // DeepSeek chat/completions 仅支持 content 为 string（text），不支持 image_url 等变体，故只传文本
  const systemMsg = '你是前端页面生成器。必须用 Element UI（Vue 2）写页面，界面美观统一。用户提供参考图时，请依据其需求描述和页面名称生成；若描述中提及布局/配色/模块，请严格按描述实现。'
  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: prompt }
    ],
    stream: false
  }
  const maxTokens = Math.min(8192, Math.max(1, parseInt(process.env.DEEPSEEK_MAX_TOKENS, 10) || 8192))
  if (maxTokens > 0) body.max_tokens = maxTokens

  const url = `${DEEPSEEK_BASE}/chat/completions`
  let res
  try {
    console.log('[nocode] 请求 DeepSeek', url, 'model:', body.model)
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
  } catch (e) {
    clearTimeout(timeoutId)
    if (e.name === 'AbortError') {
      const err = new Error('大模型请求超时，请稍后重试')
      err.status = 504
      throw err
    }
    console.error('[nocode] DeepSeek 请求异常', e.message)
    const err = new Error(e.message || '网络异常，请检查网络或稍后重试')
    err.status = 502
    throw err
  }

  let data
  const text = await res.text()
  try {
    data = text ? JSON.parse(text) : {}
  } catch (e) {
    console.error('[nocode] DeepSeek 响应非 JSON', e.message, 'body length:', text ? text.length : 0)
    if (text && text.slice(0, 100).includes('data:')) {
      console.error('[nocode] 疑似流式响应，请确认请求体已设置 stream: false')
    }
    const err = new Error('大模型返回格式异常')
    err.status = 502
    throw err
  }

  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : `HTTP ${res.status}`
    console.error('[nocode] DeepSeek 错误', res.status, msg)
    const err = new Error(msg)
    err.status = res.status
    throw err
  }

  const choices = data && Array.isArray(data.choices) ? data.choices : []
  const first = choices[0]
  const message = first && first.message ? first.message : null
  const content = message && message.content != null ? message.content : ''

  console.log('[nocode] DeepSeek 成功', 'finish_reason:', first && first.finish_reason, 'content length:', typeof content === 'string' ? content.length : 0)

  return {
    content: typeof content === 'string' ? content : '',
    finish_reason: first && first.finish_reason ? first.finish_reason : null,
    usage: data && data.usage ? data.usage : null,
    model: data && data.model ? data.model : null
  }
}

app.post('/api/nocode/generate', async (req, res) => {
  console.log('[nocode] 收到 /api/nocode/generate 请求')
  try {
    const payload = req.body || {}
    if (!process.env.DEEPSEEK_API_KEY) {
      console.log('[nocode] 未配置 DEEPSEEK_API_KEY，返回 500')
      return res.status(500).json({
        error: 'NO_MODEL_CONFIG',
        message: '请在 .env.local 中设置 DEEPSEEK_API_KEY 并重启 server'
      })
    }
    console.log('[nocode] 调用 DeepSeek...')
    const result = await callDeepseek(payload)
    console.log('[nocode] DeepSeek 返回，解析结果中')
    const modelContent = result && result.content != null ? result.content : ''
    const json = safeJson(modelContent)
    if (!json || (typeof json.html !== 'string' && typeof json.vueCode !== 'string')) {
      const reason = result.finish_reason === 'length' ? '（可能因 max_tokens 不足被截断，可调大 DEEPSEEK_MAX_TOKENS）' : ''
      console.log('[nocode] 模型输出非预期 JSON', reason, 'content 前 200 字:', modelContent ? modelContent.slice(0, 200) : '')
      return res.status(500).json({
        error: 'MODEL_OUTPUT_INVALID',
        message: '模型输出不是期望的 JSON 格式' + reason,
        raw: modelContent ? modelContent.slice(0, 500) : ''
      })
    }
    console.log('[nocode] 返回成功，vueCode/html 长度:', (json.vueCode || '').length, (json.html || '').length)
    return res.json({
      vueCode: typeof json.vueCode === 'string' ? json.vueCode : '',
      html: typeof json.html === 'string' ? json.html : '',
      css: typeof json.css === 'string' ? json.css : '',
      meta: {
        provider: 'deepseek-chat',
        model: result.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        finish_reason: result.finish_reason || null,
        usage: result.usage || null
      }
    })
  } catch (e) {
    const status = e.status || 500
    console.error('[nocode] generate 失败', status, e.message)
    return res.status(status).json({
      error: 'GENERATE_FAILED',
      message: e.message || 'generate failed'
    })
  }
})

// 将生成的 vue 单文件组件写入当前工程并可选自动挂路由
app.post('/api/nocode/apply', async (req, res) => {
  try {
    const body = req.body || {}
    const vueCode = (body.vueCode && String(body.vueCode)) || ''
    const viewName = (body.viewName && String(body.viewName).trim()) || ''
    const routePath = (body.routePath && String(body.routePath).trim()) || ''
    const routeTitle = (body.routeTitle && String(body.routeTitle).trim()) || viewName || '生成页面'

    if (!vueCode || !viewName) {
      return res.status(400).json({
        error: 'INVALID_PAYLOAD',
        message: 'vueCode 与 viewName 为必填'
      })
    }

    const projectRoot = path.resolve(__dirname, '..')
    const viewsDir = path.resolve(projectRoot, 'src', 'views')
    const fileName = `${viewName}.vue`
    const filePath = path.resolve(viewsDir, fileName)

    // 写入/覆盖视图文件
    await fsp.mkdir(viewsDir, { recursive: true })
    await fsp.writeFile(filePath, vueCode, 'utf8')
    console.log('[apply] 写入视图文件:', filePath)

    let routeAdded = false

    if (routePath) {
      const routerPath = path.resolve(projectRoot, 'src', 'router', 'index.js')
      let routerCode = await fsp.readFile(routerPath, 'utf8')

      const importLine = `const ${viewName} = () => import('@/views/${fileName}')`
      if (!routerCode.includes(importLine)) {
        const insertPos = routerCode.indexOf('export default new Router')
        if (insertPos === -1) {
          console.warn('[apply] 未找到 Router 导出，跳过自动路由注入')
        } else {
          routerCode =
            routerCode.slice(0, insertPos) +
            importLine +
            '\n' +
            routerCode.slice(insertPos)
        }
      }

      if (!routerCode.includes(`path: '${routePath}'`)) {
        const routesStart = routerCode.indexOf('routes: [')
        if (routesStart !== -1) {
          const insertPos = routerCode.indexOf(']', routesStart)
          if (insertPos !== -1) {
            const routeBlock = `
    {
      path: '${routePath}',
      component: ${viewName},
      meta: { title: '${routeTitle}' }
    },`
            routerCode =
              routerCode.slice(0, insertPos) +
              routeBlock +
              routerCode.slice(insertPos)
            routeAdded = true
          }
        }
      }

      await fsp.writeFile(routerPath, routerCode, 'utf8')
      console.log('[apply] 路由已更新，path:', routePath)
    }

    return res.json({
      ok: true,
      viewFile: filePath,
      routePath: routeAdded ? routePath : '',
      viewName
    })
  } catch (e) {
    console.error('[apply] 应用生成页面失败', e.message)
    return res.status(500).json({
      error: 'APPLY_FAILED',
      message: e.message || 'apply failed'
    })
  }
})

// 指令市场：列表查询
app.get('/api/commands', (req, res) => {
  try {
    const result = filterCommands(req.query || {})
    return res.json(result)
  } catch (e) {
    console.error('[command] 列表查询失败', e.message)
    return res.status(500).json({ error: 'COMMAND_LIST_FAILED', message: e.message || 'list failed' })
  }
})

// 指令市场：新增指令
app.post('/api/commands', (req, res) => {
  try {
    const body = req.body || {}
    const nameZh = (body.nameZh && String(body.nameZh).trim()) || ''
    const type = (body.type && String(body.type).trim()) || ''
    if (!nameZh) {
      return res.status(400).json({ error: 'NAME_REQUIRED', message: '中文名称必填' })
    }
    if (!type) {
      return res.status(400).json({ error: 'TYPE_REQUIRED', message: '指令类型必填' })
    }
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 5) : []
    const now = new Date()
    const createdAt =
      body.createdAt ||
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`
    const newId = commandStore.length ? Math.max.apply(null, commandStore.map(i => Number(i.id))) + 1 : 1
    const command = {
      id: newId,
      nameZh,
      nameEn: (body.nameEn && String(body.nameEn).trim()) || '',
      type,
      tags,
      description: (body.description && String(body.description).trim()) || '',
      status: body.status || 'enabled',
      createdBy: (body.createdBy && String(body.createdBy).trim()) || 'Admin',
      createdAt,
      subscribeCount: typeof body.subscribeCount === 'number' ? body.subscribeCount : 0,
      subscribed: !!body.subscribed
    }
    commandStore.unshift(command)
    return res.json(command)
  } catch (e) {
    console.error('[command] 新增失败', e.message)
    return res.status(500).json({ error: 'COMMAND_CREATE_FAILED', message: e.message || 'create failed' })
  }
})

// 指令市场：更新指令
app.put('/api/commands/:id', (req, res) => {
  try {
    const id = req.params.id
    const index = commandStore.findIndex(item => String(item.id) === String(id))
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '指令不存在' })
    }
    const body = req.body || {}
    const next = {
      ...commandStore[index],
      ...body
    }
    if (Array.isArray(body.tags)) {
      next.tags = body.tags.slice(0, 5)
    }
    commandStore[index] = next
    return res.json(next)
  } catch (e) {
    console.error('[command] 更新失败', e.message)
    return res.status(500).json({ error: 'COMMAND_UPDATE_FAILED', message: e.message || 'update failed' })
  }
})

// 短期结果缓存：相同请求 45s 内直接回放上次结果，避免重复调模型（超级慢时重试/误点秒出）
const executeCache = new Map()
const EXECUTE_CACHE_TTL_MS = 8000
function getExecuteCacheKey (message, context) {
  const active = (context && context.activeFile) ? String(context.activeFile) : ''
  return (message + '\n' + active).trim()
}
function getCachedExecute (key) {
  const entry = executeCache.get(key)
  if (!entry || Date.now() - entry.at > EXECUTE_CACHE_TTL_MS) {
    if (entry) executeCache.delete(key)
    return null
  }
  return entry
}

// 指令市场：简单内存后端（与前端 CommandMarket 对接）
let commandStore = [
  {
    id: 1,
    nameZh: 'AI代码评审',
    nameEn: 'review',
    type: '代码质量',
    tags: ['后端开发', '代码质量', '前端开发'],
    description: 'AI 代码评审指令，用于自动分析代码质量并给出优化建议。',
    status: 'enabled',
    createdBy: '系统',
    createdAt: '2025-06-10',
    subscribeCount: 2,
    subscribed: true
  },
  {
    id: 2,
    nameZh: 'P2代码生成指令',
    nameEn: 'P2_CODE_GENERATION',
    type: '脚本开发',
    tags: ['脚本开发', '前端开发'],
    description: 'P2 项目代码生成指令，根据模板快速生成业务代码骨架。',
    status: 'enabled',
    createdBy: '刘伟',
    createdAt: '2025-05-05',
    subscribeCount: 3,
    subscribed: true
  },
  {
    id: 3,
    nameZh: '检查sql',
    nameEn: 'check_sql',
    type: '数据库操作',
    tags: ['数据库操作', '异常排除'],
    description: '检查 SQL 语句的规范性与执行风险，预防慢查询与潜在错误。',
    status: 'enabled',
    createdBy: '李雷',
    createdAt: '2025-06-05',
    subscribeCount: 3,
    subscribed: true
  },
  {
    id: 4,
    nameZh: '生成单元测试',
    nameEn: 'generate_unit_test',
    type: '单元测试',
    tags: ['单元测试', '多框架', '脚本开发'],
    description: '根据已有代码自动生成 JUnit、Mockito、Spring Test 等多框架单元测试用例。',
    status: 'enabled',
    createdBy: '系统',
    createdAt: '2024-12-11',
    subscribeCount: 6,
    subscribed: true
  }
]

function filterCommands (params) {
  const pageNum = parseInt(params.pageNum, 10) || 1
  const pageSize = parseInt(params.pageSize, 10) || 10
  const type = params.type ? String(params.type).trim() : ''
  const keyword = params.keyword ? String(params.keyword).trim() : ''
  const statusTab = params.statusTab ? String(params.statusTab).trim() : 'all'
  const currentUser = params.currentUser ? String(params.currentUser).trim() : 'Admin'

  let list = commandStore.slice()

  if (type) {
    list = list.filter(item => item.type === type)
  }

  if (statusTab === 'mine') {
    list = list.filter(item => item.createdBy === currentUser)
  } else if (statusTab === 'subscribed') {
    list = list.filter(item => item.subscribed)
  } else if (statusTab === 'unsubscribed') {
    list = list.filter(item => !item.subscribed)
  }

  if (keyword) {
    const kw = keyword.toLowerCase()
    list = list.filter(item => {
      const zh = item.nameZh ? String(item.nameZh).toLowerCase() : ''
      const en = item.nameEn ? String(item.nameEn).toLowerCase() : ''
      return zh.includes(kw) || en.includes(kw)
    })
  }

  const total = list.length
  const start = (pageNum - 1) * pageSize
  const end = start + pageSize
  const records = list.slice(start, end)

  return { total, records }
}

// 一键执行（分而治之）：单请求完成 分析缓存 + 路由 + 规划 + 执行，首包立即返回，避免前端先等 route 再等 apply
app.post('/api/engine/execute', async (req, res) => {
  const body = req.body || {}
  const message = (body.message && String(body.message).trim()) || ''
  const context = body.context || {}
  console.log('[engine] execute 收到请求:', message ? message.slice(0, 50) + (message.length > 50 ? '...' : '') : '(空)')
  if (!message) {
    return res.status(400).json({ error: 'NO_MESSAGE', message: 'message 不能为空' })
  }
  const eventLog = []
  const sendEvent = (event, data) => {
    eventLog.push({ event, data })
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify({ event, ...data }) + '\n\n')
      if (typeof res.flush === 'function') res.flush()
    }
  }
  const cacheKey = getExecuteCacheKey(message, context)
  const cached = getCachedExecute(cacheKey)
  if (cached && cached.eventLog && cached.eventLog.length && cached.kind === 'qa') {
    console.log('[engine] execute 命中短期缓存（qa），直接回放')
    sendEvent('started', { message: '引擎已连接（结果来自缓存，未调模型）…' })
    cached.eventLog.forEach(({ event, data }) => sendEvent(event, data))
    return res.end()
  }
  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const firstPayload = ': ok\n\ndata: ' + JSON.stringify({ event: 'started', message: '引擎已连接，正在分析项目…' }) + '\n\n'
    res.write(firstPayload, 'utf8')
    if (typeof res.flush === 'function') res.flush()
    sendEvent('step', { message: '读取工程结构（使用缓存加速）…' })
    const projectInfo = await engineAnalyzer.analyze()
    const viewNames = (projectInfo.views || []).map(v => v.name || v.file).filter(Boolean)
    const routePaths = (projectInfo.routes || []).map(r => r.path).filter(Boolean)
    sendEvent('analyze', {
      summary: `已扫描工程：共 ${viewNames.length} 个视图、${routePaths.length} 条路由`,
      detail: '视图与路由已解析（15s 内重复请求走缓存）',
      views: viewNames.slice(0, 20),
      routes: routePaths.slice(0, 15)
    })
    // ---------- Panda Agent 模式（默认 Agent / panda）：多轮工具循环，对标 panda-code ----------
    // Planner 仍走旧流水线；qa_only 走纯问答（但带 history）
    const agentMode = (context && context.agentMode) ? String(context.agentMode) : 'default'
    const usePanda = agentMode === 'default' || agentMode === 'panda' || agentMode === 'claw' || agentMode === 'agent'
    if (usePanda) {
      const runHub = require('./engine/panda/runHub')
      const sessionId = (context && (context.sessionId || context.pandaSessionId)) ||
        ('sess_' + Date.now().toString(16))
      if (context) context.sessionId = sessionId

      // VS Code Chat / 外部工作区：允许指定 projectRoot，避免误用 AIFront 自身工程根
      const overrideRoot = String(
        (context && (context.projectRoot || context.cwd)) ||
        body.projectRoot || body.cwd ||
        process.env.PANDA_PROJECT_ROOT || ''
      ).trim()
      let projectInfoForPanda = projectInfo
      if (overrideRoot) {
        const absRoot = path.resolve(overrideRoot)
        if (fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory()) {
          let pkg = {}
          try {
            pkg = JSON.parse(fs.readFileSync(path.join(absRoot, 'package.json'), 'utf8'))
          } catch (e) { /* optional */ }
          projectInfoForPanda = {
            root: absRoot,
            name: path.basename(absRoot),
            framework: 'generic',
            pkg,
            files: {},
            views: [],
            routes: [],
            semantic: { views: [], components: [], sectionsByView: {}, menuContainers: [] }
          }
        }
      }

      runHub.begin(sessionId, {
        message: message.slice(0, 240),
        model: (context && context.model) || '',
        projectRoot: projectInfoForPanda.root
      })

      const writeSse = (event, data) => {
        if (res.writableEnded || res.destroyed) return false
        try {
          res.write('data: ' + JSON.stringify(Object.assign({ event }, data || {})) + '\n\n')
          if (typeof res.flush === 'function') res.flush()
          return true
        } catch (e) {
          return false
        }
      }
      // 主连接订阅 hub；客户端断开只 detach，不 abort Agent（支持重连）
      const unsub = runHub.attach(sessionId, writeSse, { replay: false })
      const onReqClose = () => {
        try { unsub() } catch (e) { /* ignore */ }
      }
      req.on('close', onReqClose)

      // 覆盖外层 sendEvent：统一走 hub 扇出
      const hubSend = (event, data) => {
        eventLog.push({ event, data })
        runHub.emit(sessionId, event, data)
      }

      hubSend('step', { message: '启动 Panda Agent（工具循环 + 多轮上下文）…' })
      hubSend('kind', { kind: 'panda_agent', engineInstruction: message, sessionId, projectRoot: projectInfoForPanda.root })
      try {
        const pandaResult = await pandaAgent.runPandaAgent({
          message,
          projectInfo: projectInfoForPanda,
          context,
          sendEvent: hubSend
        })
        if (!(pandaResult && pandaResult.aborted)) {
          hubSend('done', {
            kind: 'panda_agent',
            changed: pandaResult.changed || [],
            mode: pandaResult.mode,
            todos: pandaResult.todos || [],
            sessionId: pandaResult.sessionId || sessionId
          })
        }
        if (pandaResult.changed && pandaResult.changed.length) {
          hubSend('changed', { files: pandaResult.changed })
        }
      } catch (pandaErr) {
        console.error('[engine] panda agent 失败', pandaErr.message)
        hubSend('error', { message: pandaErr.message || 'Panda Agent 执行失败' })
        hubSend('answer_done', {})
      } finally {
        try { req.removeListener('close', onReqClose) } catch (e) { /* ignore */ }
        try { unsub() } catch (e) { /* ignore */ }
        runHub.end(sessionId)
      }
      if (!res.writableEnded) res.end()
      return
    }

    sendEvent('step', { message: '理解意图（思维引擎）…' })
    const thought = await engineThinker.thinkStream(message, context, {
      onChunk: (chunk) => sendEvent('think_reasoning_chunk', { chunk })
    })
    // 若有歧义：只反问、不执行，等用户明确后再继续
    if (thought && thought.needsClarification && thought.clarificationQuestion) {
      sendEvent('think', {
        intentSummary: '需要先与您确认再执行',
        doNot: [],
        target: '',
        refinedInstruction: '',
        needsClarification: true,
        clarificationQuestion: thought.clarificationQuestion
      })
      sendEvent('clarification', {
        question: thought.clarificationQuestion,
        reasoning: thought.reasoning || ''
      })
      const replyText = '需要先和您确认：\n\n' + thought.clarificationQuestion
      sendEvent('answer_chunk', { content: replyText })
      sendEvent('answer_done', {})
      return res.end()
    }
    // 仅指定目标页面（如「指令市场页面」「期货预测页面」）无具体操作：直接回复已锁定，不跑规划与改代码
    if (thought && thought.targetSpecificationOnly) {
      const pageName = thought.lockedPageName || '目标'
      const replyText = `已锁定为【${pageName}】页面，请直接说您要做的修改（例如：把卡片里的标签移到底部、改标题文案等）。`
      sendEvent('answer_chunk', { content: replyText })
      sendEvent('answer_done', {})
      return res.end()
    }
    const instructionForDownstream = (thought && thought.refinedInstruction) ? thought.refinedInstruction : message
    sendEvent('think', {
      intentSummary: thought && thought.intentSummary ? thought.intentSummary : '',
      doNot: thought && thought.doNot ? thought.doNot : [],
      target: thought && thought.target ? thought.target : '',
      refinedInstruction: instructionForDownstream
    })
    sendEvent('step', { message: '识别意图并规划改动…' })
    const route = await engineRouter.routeMessage(instructionForDownstream, projectInfo, context)
    const kind = (route && route.kind) ? route.kind : 'qa'
    sendEvent('kind', { kind, engineInstruction: (route && route.engineInstruction) ? route.engineInstruction : instructionForDownstream })
    if (kind === 'qa') {
      sendEvent('step', { message: '调用模型回答…' })
      try {
        for await (const chunk of engineQa.answerQuestionStream(message, projectInfo, context, (route && route.qaHint) ? route.qaHint : '')) {
          sendEvent('answer_chunk', { content: chunk })
        }
      } catch (qaErr) {
        console.error('[engine] execute qa stream 失败', qaErr.message)
        sendEvent('error', { message: qaErr.message || '模型回答失败，请检查 DEEPSEEK_API_KEY 或网络' })
      }
      sendEvent('answer_done', {})
      return res.end()
    }
    const instruction = route.engineInstruction || instructionForDownstream || message
    // 规划器需要用户原话与思维引擎结果，以便在「项目语义地图」上做最近邻视图选择（semanticPicker）：
    // - originalMessage：区分「指令市场列表页」vs「指令市场详情页」等，避免精炼丢掉关键信息；
    // - thought：提供 refinedInstruction 与 intentSummary，提升语义匹配精度。
    const contextWithOriginal = { ...context, originalMessage: message, thought }
    // 多轮 Agent 流程：默认最多 5 轮，更接近 Cursor 的「拆成多步直到满足为止」，
    // 但每一轮都会做满足性判断（thinkSatisfied），已满足就立刻停，不会傻跑固定轮数。
    // 如需关闭多轮，可将 ENGINE_AGENT_MAX_ROUNDS 设为 1；如需更多步，可适当调大（不建议超过 10）。
    const AGENT_MAX_ROUNDS = Math.min(50, Math.max(1, parseInt(process.env.ENGINE_AGENT_MAX_ROUNDS, 10) || 5))
    let currentInstruction = instruction
    let round = 0
    let allChanged = []
    let accumulatedSteps = []
    let lastApplyResult = null
    let thoughtForCodegen = thought
    let lastPlanKey = ''

    while (round < AGENT_MAX_ROUNDS) {
      round++

      sendEvent('step', { message: round === 1 ? '规划具体改动（add_view / modify_view）…' : '继续规划改动…' })
      const plan = await enginePlanner.plan(currentInstruction, projectInfo, contextWithOriginal)

      // 若规划器在「页面选择」层面就发现歧义（例如多个详情页），优先走澄清流程，避免误改错误页面
      if (plan && plan.needsClarification && plan.clarificationQuestion) {
        sendEvent('plan', {
          summary: '需要先确认要改哪个页面',
          round,
          actions: []
        })
        sendEvent('clarification', {
          question: plan.clarificationQuestion,
          reasoning: ''
        })
        const replyText = '需要先和您确认：\n\n' + plan.clarificationQuestion
        sendEvent('answer_chunk', { content: replyText })
        sendEvent('answer_done', {})
        return res.end()
      }

      const actions = plan.actions || []
      const planSummary = actions.length ? actions.map(a => {
        if (a.type === 'add_view') return `新增 ${a.viewName || a.routePath || ''}`
        if (a.type === 'modify_view') return `修改 ${a.file || ''}`
        return a.type
      }).join('；') : '无改动项'

      // 若本轮规划出的「动作集合」与上一轮完全相同，说明已经进入原地打转状态，直接结束多轮流程，
      // 避免在同一类改动上反复生成相似代码（更贴近 Cursor 的「能一轮完成就不要多轮折腾」）。
      const currentPlanKey = JSON.stringify(actions.map(a => ({
        type: a.type,
        file: a.file || '',
        viewName: a.viewName || ''
      })))
      if (round > 1 && currentPlanKey && currentPlanKey === lastPlanKey) {
        sendEvent('satisfaction_check', {
          satisfied: true,
          summary: '多轮规划结果与上一轮完全相同，视为已完成当前可自动执行的改动，停止后续循环。',
          nextInstruction: '',
          reasoning: '为避免在同一类改动上原地打转，多轮结果相同时直接结束。'
        })
        break
      }
      lastPlanKey = currentPlanKey
      sendEvent('plan', {
        summary: planSummary,
        round,
        actions: actions.map(a => ({ type: a.type, file: a.file, viewName: a.viewName, reason: a.reason, description: a.description }))
      })

      if (actions.length === 0) {
        sendEvent('step', { message: '判断是否已满足用户需求…' })
        const check = await engineThinker.thinkSatisfied(message, accumulatedSteps, {
          ...context,
          lastActions: actions,
          lastChanged: [],
          lastThought: thoughtForCodegen
        })
        sendEvent('satisfaction_check', { satisfied: check.satisfied, summary: check.summary, nextInstruction: check.nextInstruction, reasoning: check.reasoning })
        if (check.satisfied || !check.nextInstruction) break
        currentInstruction = check.nextInstruction
        continue
      }

      sendEvent('codegen_start', { summary: actions.length > 1 ? '正在并行生成代码…' : '正在生成代码…', count: actions.length })
      const runOne = async (action, index) => {
        sendEvent('step', { message: `生成第 ${index + 1}/${actions.length} 项：${action.file || action.viewName || '新视图'}…` })
        if (action.type === 'add_view') {
          const vueCode = await engineCodegen.generateForAddView(action, projectInfo)
          sendEvent('codegen_file', { type: 'view', viewName: action.viewName, file: `src/views/${action.viewName}.vue`, content: vueCode })
          return { type: 'view', viewName: action.viewName, routePath: action.routePath, routeTitle: action.routeTitle || action.description || action.viewName, vueCode }
        }
        if (action.type === 'modify_view') {
          const streamOpts = actions.length === 1
            ? { onChunk: (chunk) => sendEvent('codegen_chunk', { file: action.file, chunk }) }
            : {}
          if (thoughtForCodegen && typeof thoughtForCodegen === 'object') {
            streamOpts.thought = thoughtForCodegen
          }
          const mod = await engineCodegen.generateForModifyView(action, projectInfo, streamOpts)
          if (mod.skipped) {
            sendEvent('codegen_skipped', { file: mod.file, message: mod.message })
            return { skipped: true, file: mod.file, message: mod.message }
          }
          sendEvent('codegen_file', { type: 'modify', file: mod.file, content: mod.newContent })
          return { type: 'modify', file: mod.file, newContent: mod.newContent }
        }
        return null
      }
      const results = await Promise.all(actions.map((action, i) => runOne(action, i)))
      const files = results.filter(r => r && !r.skipped)
      const skipped = results.filter(r => r && r.skipped)
      sendEvent('step', { message: '写入文件并更新路由、菜单…' })
      const applyResult = await applyWithRepairRetry(files, projectInfo, currentInstruction, sendEvent)
      lastApplyResult = applyResult
      const changed = applyResult.changed || []
      allChanged = allChanged.concat(changed)
      const changedPaths = changed.map(c => c.path || c.viewFile || c.file).filter(Boolean)
      let applySummary = changedPaths.length ? `已写入 ${changedPaths.length} 个文件：${changedPaths.join('、')}` : '无文件变更'
      if (skipped.length) applySummary += `；已跳过 ${skipped.length} 个：${skipped.map(s => s.file).join('、')}`
      if (!applyResult.buildOk && applyResult.rolledBack && applyResult.rolledBack.length) {
        applySummary += `。构建失败已回滚：${applyResult.rolledBack.join('、')}；已尝试自动修复至通过或达最大重试`
      }
      accumulatedSteps.push({
        round,
        planSummary,
        applySummary,
        actionDescriptions: actions.map(a => a.reason || a.description).filter(Boolean)
      })
      sendEvent('apply', {
        summary: applySummary,
        changed: changed,
        skipped: skipped.length ? skipped : undefined,
        buildOk: applyResult.buildOk,
        buildError: applyResult.buildError,
        rolledBack: applyResult.rolledBack
      })

      sendEvent('step', { message: '判断是否已满足用户需求…' })
      const check = await engineThinker.thinkSatisfied(message, accumulatedSteps, {
        ...context,
        lastActions: actions,
        lastChanged: changed,
        lastThought: thoughtForCodegen
      })
      sendEvent('satisfaction_check', { satisfied: check.satisfied, summary: check.summary, nextInstruction: check.nextInstruction, reasoning: check.reasoning })
      if (check.satisfied || !check.nextInstruction) break
      currentInstruction = check.nextInstruction
    }

    sendEvent('done', {
      changed: allChanged,
      buildOk: lastApplyResult ? lastApplyResult.buildOk : undefined,
      buildError: lastApplyResult ? lastApplyResult.buildError : undefined,
      rolledBack: lastApplyResult ? lastApplyResult.rolledBack : undefined
    })
    // 仅对纯问答结果做短期缓存；对改代码请求每次都重新跑一遍链路
    if (kind === 'qa') {
      executeCache.set(cacheKey, { at: Date.now(), eventLog, kind, changed: allChanged, buildOk: lastApplyResult && lastApplyResult.buildOk, buildError: lastApplyResult && lastApplyResult.buildError })
    }
  } catch (e) {
    console.error('[engine] execute 失败', e.message)
    if (!res.headersSent) {
      return res.status(500).json({ error: 'EXECUTE_FAILED', message: e.message || '执行失败，请查看 server 日志' })
    }
    sendEvent('error', { message: e.message || '执行失败，请查看 server 日志' })
  }
  res.end()
})

// 通用指令引擎：将自然语言指令转为对当前工程的实际改动；支持 stream=true 流式推送各阶段结果
app.post('/api/engine/apply-instruction', async (req, res) => {
  const body = req.body || {}
  const instruction = (body.instruction && String(body.instruction).trim()) || ''
  const stream = !!body.stream
  if (!instruction) {
    return res.status(400).json({
      error: 'NO_INSTRUCTION',
      message: 'instruction 不能为空'
    })
  }

  const sendEvent = (event, data) => {
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify({ event, ...data }) + '\n\n')
      if (typeof res.flush === 'function') res.flush()
    }
  }
  const sendEventAndFlush = (event, data) => {
    return new Promise((resolve) => {
      if (res.writableEnded) return resolve()
      const payload = 'data: ' + JSON.stringify({ event, ...data }) + '\n\n'
      res.write(payload, 'utf8', () => {
        if (typeof res.flush === 'function') res.flush()
        setImmediate(resolve)
      })
    })
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    // 先发一条注释 + started 同包，便于代理/网络尽快把首包发给前端
    const firstPayload = ': connected\n\ndata: ' + JSON.stringify({ event: 'started', message: '引擎已连接，正在分析项目…' }) + '\n\n'
    await new Promise((resolve, reject) => {
      if (res.writableEnded) return resolve()
      res.write(firstPayload, 'utf8', (err) => {
        if (err) reject(err)
        else {
          if (typeof res.flush === 'function') res.flush()
          setImmediate(resolve)
        }
      })
    })
    try {
      sendEvent('step', { message: '读取 package.json、src/router/index.js、src/views 目录，解析路由与视图列表…' })
      console.log('[engine] analyze project...')
      const projectInfo = await engineAnalyzer.analyze()
      const viewNames = (projectInfo.views || []).map(v => v.name || v.file).filter(Boolean)
      const routePaths = (projectInfo.routes || []).map(r => r.path).filter(Boolean)
      sendEvent('analyze', {
        summary: `已扫描工程：共 ${viewNames.length} 个视图、${routePaths.length} 条路由`,
        detail: `视图目录 src/views、路由文件 src/router/index.js 已解析完成`,
        views: viewNames.slice(0, 20),
        routes: routePaths.slice(0, 15)
      })

      sendEvent('step', { message: '调用模型根据指令规划改动（生成 add_view / modify_view 等 actions）…' })
      console.log('[engine] plan changes...')
      const plan = await enginePlanner.plan(instruction, projectInfo, context)
      const actions = plan.actions || []
      const planSummary = actions.length
        ? actions.map(a => {
            if (a.type === 'add_view') return `新增视图 ${a.viewName || a.routePath || ''}`
            if (a.type === 'modify_view') return `修改 ${a.file || ''}：${(a.reason || a.description || '').slice(0, 40)}`
            return a.type
          }).join('；')
        : '无改动项'
      sendEvent('plan', {
        summary: planSummary,
        actions: actions.map(a => ({ type: a.type, file: a.file, viewName: a.viewName, reason: a.reason, description: a.description }))
      })

      sendEvent('codegen_start', { summary: '正在生成代码…', count: actions.length })

      const files = []
      const skipped = []
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]
        const currentLabel = action.file || action.viewName || '新视图'
        sendEvent('step', { message: `生成第 ${i + 1}/${actions.length} 项：${currentLabel}（${action.type === 'add_view' ? '新增页面' : '修改现有文件'}）…` })
        if (action.type === 'add_view') {
          const vueCode = await engineCodegen.generateForAddView(action, projectInfo)
          const item = {
            type: 'view',
            viewName: action.viewName,
            routePath: action.routePath,
            routeTitle: action.routeTitle || action.description || action.viewName,
            vueCode
          }
          files.push(item)
          sendEvent('codegen_file', {
            type: 'view',
            viewName: action.viewName,
            file: `src/views/${action.viewName}.vue`,
            content: vueCode
          })
        } else if (action.type === 'modify_view') {
          const mod = await engineCodegen.generateForModifyView(action, projectInfo)
          if (mod.skipped) {
            skipped.push({ file: mod.file, message: mod.message })
            sendEvent('codegen_skipped', { file: mod.file, message: mod.message })
          } else {
            files.push({ type: 'modify', file: mod.file, newContent: mod.newContent })
            sendEvent('codegen_file', {
              type: 'modify',
              file: mod.file,
              content: mod.newContent
            })
          }
        }
      }

      sendEvent('step', { message: '将生成内容写入磁盘、更新 src/router/index.js 与 App.vue 菜单…' })
      console.log('[engine] apply changes...')
      const applyResult = await applyWithRepairRetry(files, projectInfo, instruction, sendEvent)
      const changed = applyResult.changed || []
      const changedPaths = changed.map(c => c.path || c.viewFile || c.file).filter(Boolean)
      let applySummary = changedPaths.length ? `已写入 ${changedPaths.length} 个文件：${changedPaths.join('、')}` : '无文件变更'
      if (skipped.length) applySummary += `；已跳过 ${skipped.length} 个（样式保护）：${skipped.map(s => s.file).join('、')}`
      if (!applyResult.buildOk && applyResult.rolledBack && applyResult.rolledBack.length) {
        applySummary += `。构建失败已回滚：${applyResult.rolledBack.join('、')}；已尝试自动修复至通过或达最大重试`
      }
      sendEvent('apply', {
        summary: applySummary,
        changed,
        skipped: skipped.length ? skipped : undefined,
        buildOk: applyResult.buildOk,
        buildError: applyResult.buildError,
        rolledBack: applyResult.rolledBack
      })
      sendEvent('done', {
        changed,
        skipped: skipped.length ? skipped : undefined,
        buildOk: applyResult.buildOk,
        buildError: applyResult.buildError,
        rolledBack: applyResult.rolledBack
      })
    } catch (e) {
      console.error('[engine] 应用指令失败（流式）', e.message)
      sendEvent('error', { message: e.message || 'engine apply failed' })
    }
    return res.end()
  }

  try {
    console.log('[engine] analyze project...')
    const projectInfo = await engineAnalyzer.analyze()
    console.log('[engine] plan changes...')
    const plan = await enginePlanner.plan(instruction, projectInfo, context)
    console.log('[engine] plan result:', JSON.stringify(plan, null, 2))
    console.log('[engine] generate code...')
    const genResult = await engineCodegen.generate(plan, projectInfo)
    const files = Array.isArray(genResult) ? genResult : (genResult.files || [])
    const skipped = genResult.skipped || []
    console.log('[engine] generated files:', files.map(f => f.viewName || f.file).join(', '), skipped.length ? `skipped: ${skipped.map(s => s.file).join(', ')}` : '')
    console.log('[engine] apply changes...')
    const applyResult = await applyWithRepairRetry(files, projectInfo, instruction, undefined)
    const changed = applyResult.changed || []
    return res.json({
      ok: true,
      project: {
        root: projectInfo.root,
        routes: projectInfo.routes
      },
      plan,
      changed,
      skipped: skipped.length ? skipped : undefined,
      buildOk: applyResult.buildOk,
      buildError: applyResult.buildError,
      rolledBack: applyResult.rolledBack
    })
  } catch (e) {
    console.error('[engine] 应用指令失败', e.message)
    return res.status(500).json({
      error: 'ENGINE_ERROR',
      message: e.message || 'engine apply failed'
    })
  }
})

// 聊天消息路由：判断一条无代码聊天输入是生成页面、修改已有代码还是仅对话
app.post('/api/engine/route-message', async (req, res) => {
  const body = req.body || {}
  const message = (body.message && String(body.message).trim()) || ''
  const context = body.context || {}
  if (!message) {
    return res.status(400).json({
      error: 'NO_MESSAGE',
      message: 'message 不能为空'
    })
  }
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const route = await engineRouter.routeMessage(message, projectInfo, context)
    return res.json({
      ok: true,
      route
    })
  } catch (e) {
    console.error('[engine] route-message 失败', e.message)
    return res.status(500).json({
      error: 'ROUTE_ERROR',
      message: e.message || 'route failed'
    })
  }
})

// 问答接口：针对 router 判定为 qa 的输入，返回 answer 文本；支持 stream=true 流式输出
app.post('/api/engine/answer-question', async (req, res) => {
  const body = req.body || {}
  const question = (body.question && String(body.question).trim()) || ''
  const context = body.context || {}
  const qaHint = body.qaHint || ''
  const stream = !!body.stream
  if (!question) {
    return res.status(400).json({
      error: 'NO_QUESTION',
      message: 'question 不能为空'
    })
  }
  try {
    const projectInfo = await engineAnalyzer.analyze()
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      try {
        for await (const chunk of engineQa.answerQuestionStream(question, projectInfo, context, qaHint)) {
          res.write('data: ' + JSON.stringify({ content: chunk }) + '\n\n')
          if (typeof res.flush === 'function') res.flush()
        }
        res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
      } catch (streamErr) {
        console.error('[engine] answer-question stream 失败', streamErr.message)
        res.write('data: ' + JSON.stringify({ error: streamErr.message }) + '\n\n')
      }
      return res.end()
    }
    const answer = await engineQa.answerQuestion(question, projectInfo, context, qaHint)
    return res.json({
      ok: true,
      answer
    })
  } catch (e) {
    console.error('[engine] answer-question 失败', e.message)
    return res.status(500).json({
      error: 'QA_ERROR',
      message: e.message || 'qa failed'
    })
  }
})

// ===== 开发用「云编译器」API：安全读写部分项目文件 =====

function isAllowedDevPath (relPath) {
  const safe = typeof relPath === 'string' && relPath && !relPath.includes('..')
  if (!safe) return false
  // 不允许访问部分大型或敏感目录，其余默认允许（工程根目录下所有代码/配置文件都可编辑）
  const blockedPrefixes = [
    'node_modules/',
    'dist/',
    'build/',
    '.git/',
    '.cursor/',
    'terminals/'
  ]
  for (const prefix of blockedPrefixes) {
    if (relPath.startsWith(prefix)) return false
  }
  return true
}

// 列出可编辑文件列表
app.get('/api/dev/files', async (req, res) => {
  try {
    const projectRoot = path.resolve(__dirname, '..')
    const files = []

    function walk (relDir) {
      const absDir = path.resolve(projectRoot, relDir || '.')
      if (!fs.existsSync(absDir)) return
      const entries = fs.readdirSync(absDir, { withFileTypes: true })
      for (const entry of entries) {
        const name = entry.name
        if (entry.isDirectory()) {
          // 跳过一些不需要的目录
          if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === '.cursor' || name === 'terminals') continue
          const nextRel = relDir ? path.posix.join(relDir, name) : name
          walk(nextRel)
        } else if (entry.isFile()) {
          const ext = path.extname(name)
          if (ext === '.js' || ext === '.vue' || ext === '.ts' || ext === '.json') {
            const relPath = relDir ? path.posix.join(relDir, name) : name
            files.push({
              path: relPath,
              label: relPath
            })
          }
        }
      }
    }

    // 收集整个工程（排除大型或无关目录）
    walk('')

    return res.json({ ok: true, files })
  } catch (e) {
    console.error('[dev] list files 失败', e.message)
    return res.status(500).json({ error: 'DEV_LIST_FAILED', message: e.message || 'list failed' })
  }
})

// 读取单个文件内容
app.get('/api/dev/file', async (req, res) => {
  const relPath = String(req.query.path || '')
  if (!isAllowedDevPath(relPath)) {
    return res.status(400).json({ error: 'INVALID_PATH', message: '不允许访问此路径' })
  }
  try {
    const projectRoot = path.resolve(__dirname, '..')
    const absPath = path.resolve(projectRoot, relPath)
    const content = await fsp.readFile(absPath, 'utf8')
    return res.json({ ok: true, path: relPath, content })
  } catch (e) {
    console.error('[dev] 读取文件失败', relPath, e.message)
    return res.status(500).json({ error: 'DEV_READ_FAILED', message: e.message || 'read failed' })
  }
})

// 保存单个文件内容（带 .bak 备份）
app.post('/api/dev/file', async (req, res) => {
  const body = req.body || {}
  const relPath = (body.path && String(body.path)) || ''
  const content = (body.content && String(body.content)) || ''
  if (!isAllowedDevPath(relPath)) {
    return res.status(400).json({ error: 'INVALID_PATH', message: '不允许写入此路径' })
  }
  try {
    const projectRoot = path.resolve(__dirname, '..')
    const absPath = path.resolve(projectRoot, relPath)
    // 备份原文件
    try {
      if (fs.existsSync(absPath)) {
        const bakPath = absPath + '.bak'
        await fsp.copyFile(absPath, bakPath)
      }
    } catch (e) {
      console.warn('[dev] 备份文件失败', relPath, e.message)
    }
    await fsp.writeFile(absPath, content, 'utf8')
    console.log('[dev] 已写入文件:', relPath)
    return res.json({ ok: true })
  } catch (e) {
    console.error('[dev] 写入文件失败', relPath, e.message)
    return res.status(500).json({ error: 'DEV_WRITE_FAILED', message: e.message || 'write failed' })
  }
})

// 使用 Prettier 对代码进行格式化
app.post('/api/dev/format', async (req, res) => {
  const body = req.body || {}
  const relPath = (body.path && String(body.path)) || ''
  const content = (body.content && String(body.content)) || ''
  if (!isAllowedDevPath(relPath)) {
    return res.status(400).json({ error: 'INVALID_PATH', message: '不允许格式化此路径' })
  }
  if (!prettier) {
    return res.status(500).json({ error: 'NO_PRETTIER', message: 'prettier 未安装，请先执行 npm install --save-dev prettier' })
  }
  try {
    const ext = relPath.split('.').pop()
    let parser = 'babel'
    if (ext === 'vue') parser = 'vue'
    else if (ext === 'ts') parser = 'typescript'
    else if (ext === 'json') parser = 'json'
    else if (ext === 'css' || ext === 'scss' || ext === 'less') parser = 'css'
    else if (ext === 'html') parser = 'html'
    const formatted = prettier.format(content, {
      parser,
      semi: false,
      singleQuote: true,
      trailingComma: 'none'
    })
    return res.json({ ok: true, content: formatted })
  } catch (e) {
    console.error('[dev] 格式化失败', relPath, e.message)
    return res.status(500).json({ error: 'DEV_FORMAT_FAILED', message: e.message || 'format failed' })
  }
})

// 简易终端管理：允许在项目根目录执行命令，并通过轮询查看输出
const terminals = new Map()

app.post('/api/dev/terminal/start', (req, res) => {
  const body = req.body || {}
  const command = (body.command && String(body.command).trim()) || ''
  const id = (body.id && String(body.id).trim()) || String(Date.now())
  if (!command) {
    return res.status(400).json({ error: 'NO_COMMAND', message: 'command 不能为空' })
  }
  const projectRoot = path.resolve(__dirname, '..')
  try {
    // 如果同一个 id 已有仍在运行的进程，先拒绝
    const existing = terminals.get(id)
    if (existing && existing.running) {
      return res.status(400).json({ error: 'ALREADY_RUNNING', message: '该终端已有命令在运行，可新建终端窗口' })
    }

    const shell = process.platform === 'win32' ? 'cmd' : 'bash'
    const args = process.platform === 'win32' ? ['/c', command] : ['-lc', command]
    const child = spawn(shell, args, { cwd: projectRoot, env: process.env })
    const info = {
      id,
      command,
      process: child,
      log: `> ${command}\n`,
      running: true,
      exitCode: null,
      startedAt: Date.now()
    }
    const maxLogLength = 100000
    const append = chunk => {
      info.log += chunk
      if (info.log.length > maxLogLength) {
        info.log = info.log.slice(info.log.length - maxLogLength)
      }
    }
    child.stdout.on('data', data => append(String(data)))
    child.stderr.on('data', data => append(String(data)))
    child.on('close', code => {
      info.running = false
      info.exitCode = code
      append(`\n[进程退出，代码: ${code}]\n`)
    })
    child.on('error', err => {
      info.running = false
      append(`\n[进程错误: ${err.message}]\n`)
    })

    terminals.set(id, info)
    return res.json({ ok: true, id })
  } catch (e) {
    console.error('[dev] 启动终端失败', e.message)
    return res.status(500).json({ error: 'TERMINAL_START_FAILED', message: e.message || 'terminal start failed' })
  }
})

app.get('/api/dev/terminal/status', (req, res) => {
  const id = (req.query.id && String(req.query.id).trim()) || ''
  if (!id || !terminals.has(id)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: '终端不存在' })
  }
  const info = terminals.get(id)
  return res.json({
    ok: true,
    id: info.id,
    command: info.command,
    log: info.log,
    running: info.running,
    exitCode: info.exitCode
  })
})

app.post('/api/dev/terminal/stop', (req, res) => {
  const body = req.body || {}
  const id = (body.id && String(body.id).trim()) || ''
  if (!id || !terminals.has(id)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: '终端不存在' })
  }
  const info = terminals.get(id)
  if (info.running && info.process) {
    info.process.kill()
    info.running = false
    info.exitCode = null
    info.log += '\n[进程已被手动终止]\n'
  }
  return res.json({ ok: true })
})

// 回退基于 .bak 的修改（主要用于 modify_existing 场景）
app.post('/api/dev/revert', async (req, res) => {
  const body = req.body || {}
  const files = Array.isArray(body.files) ? body.files.map(f => String(f)) : []
  if (!files.length) {
    return res.status(400).json({ error: 'NO_FILES', message: 'files 不能为空' })
  }
  const projectRoot = path.resolve(__dirname, '..')
  const restored = []
  try {
    for (const rel of files) {
      if (!rel.endsWith('.bak')) continue
      const bakAbs = path.resolve(projectRoot, rel)
      if (!fs.existsSync(bakAbs)) continue
      const targetRel = rel.slice(0, -4)
      const targetAbs = path.resolve(projectRoot, targetRel)
      try {
        await fsp.copyFile(bakAbs, targetAbs)
        restored.push(targetRel)
      } catch (e) {
        console.warn('[dev] 回退文件失败', rel, e.message)
      }
    }
    return res.json({ ok: true, restored })
  } catch (e) {
    console.error('[dev] revert 失败', e.message)
    return res.status(500).json({ error: 'DEV_REVERT_FAILED', message: e.message || 'revert failed' })
  }
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// ---------- Panda 会话（对标 panda-code LogSelector / resume）----------
app.get('/api/panda/slash-commands', (req, res) => {
  try {
    const list = require('./engine/panda/slashRegistry').listCommands()
    res.json({ commands: list })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/sessions', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const list = await pandaAgent.listSessions(projectInfo.root)
    res.json({ sessions: list })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/sessions', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const title = (req.body && req.body.title) || '新会话'
    const meta = await pandaAgent.createSession(projectInfo.root, title)
    res.json({ session: meta })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/runs', (req, res) => {
  try {
    const runHub = require('./engine/panda/runHub')
    res.json({ runs: runHub.listActive() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/runs/:id', (req, res) => {
  try {
    const runHub = require('./engine/panda/runHub')
    const snap = runHub.getSnapshot(req.params.id)
    // 补权限闸门里可能尚未写入 hub 的 pending（极端竞态）
    if (snap.running && !snap.pendingPermission) {
      try {
        const list = require('./engine/panda/permissionGate').listPending(req.params.id)
        if (list && list[0]) snap.pendingPermission = list[0]
      } catch (e) { /* ignore */ }
    }
    res.json(snap)
  } catch (e) {
    res.status(500).json({ error: e.message, running: false })
  }
})

app.get('/api/panda/runs/:id/events', (req, res) => {
  try {
    const runHub = require('./engine/panda/runHub')
    const sessionId = req.params.id
    const snap = runHub.getSnapshot(sessionId)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const writeSse = (event, data) => {
      if (res.writableEnded || res.destroyed) return false
      try {
        res.write('data: ' + JSON.stringify(Object.assign({ event }, data || {})) + '\n\n')
        if (typeof res.flush === 'function') res.flush()
        return true
      } catch (e) {
        return false
      }
    }

    writeSse('panda_run', {
      reattached: true,
      running: !!snap.running,
      status: snap.status || 'idle',
      sessionId,
      message: snap.message || '',
      workStatus: snap.workStatus || '',
      round: snap.round || 0
    })

    if (!snap.running) {
      writeSse('done', { kind: 'panda_reattach', sessionId, idle: true })
      return res.end()
    }

    const unsub = runHub.attach(sessionId, writeSse, {
      replay: req.query.replay === 'ring' ? 'ring' : 'snapshot',
      fromSeq: parseInt(req.query.fromSeq, 10) || 0
    })
    const onClose = () => {
      try { unsub() } catch (e) { /* ignore */ }
      if (!res.writableEnded) {
        try { res.end() } catch (e2) { /* ignore */ }
      }
    }
    req.on('close', onClose)

    // 若 run 在订阅后结束，hub 会发 done；额外轮询兜底关流
    const poll = setInterval(() => {
      if (!runHub.isRunning(sessionId)) {
        clearInterval(poll)
        try { unsub() } catch (e) { /* ignore */ }
        if (!res.writableEnded) {
          writeSse('done', { kind: 'panda_reattach', sessionId, finished: true })
          res.end()
        }
      }
    }, 1500)
    req.on('close', () => clearInterval(poll))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/sessions/:id', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const entries = await pandaAgent.loadRecentTranscript(projectInfo.root, req.params.id, 300)
    let context = null
    try {
      const session = require('./engine/panda/session')
      context = await session.loadSessionContext(projectInfo.root, req.params.id)
    } catch (e) { /* ignore */ }
    let worktree = null
    try {
      const wt = require('./engine/panda/worktree')
      worktree = await wt.currentWorktree(projectInfo.root)
    } catch (e) { /* ignore */ }
    res.json({
      id: req.params.id,
      entries,
      context: context || {},
      worktree: worktree || null
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/panda/sessions/:id', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    await pandaAgent.deleteSession(projectInfo.root, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/permission', (req, res) => {
  const body = req.body || {}
  const id = body.id
  const allow = body.allow !== false && body.allow !== 'false'
  const { resolvePermission } = require('./engine/panda/permissionGate')
  const ok = resolvePermission(id, allow, {
    sessionId: body.sessionId || '',
    permissionMode: body.permissionMode || '',
    sessionAllow: !!body.sessionAllow,
    sessionDeny: !!body.sessionDeny,
    persistDeny: !!body.persistDeny,
    persistAllow: !!body.persistAllow,
    allowRule: body.allowRule || null,
    projectRoot: body.projectRoot || process.cwd()
  })
  res.json({ ok, resolved: ok })
})

app.post('/api/panda/runtime', (req, res) => {
  const body = req.body || {}
  const sessionId = body.sessionId || ''
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' })
  const sessionRuntime = require('./engine/panda/sessionRuntime')
  const result = sessionRuntime.applyPatch(sessionId, {
    permissionMode: body.permissionMode,
    agentMode: body.agentMode,
    sessionAllow: body.sessionAllow,
    sessionDeny: body.sessionDeny,
    appendSessionAllow: body.appendSessionAllow,
    appendSessionDeny: body.appendSessionDeny
  })
  res.json(result)
})

/** 运行中插话：注入下一轮，不重开 Agent（省时间/token） */
app.post('/api/panda/steer', (req, res) => {
  try {
    const body = req.body || {}
    const sessionId = body.sessionId || ''
    const text = body.text || body.message || ''
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' })
    const sessionRuntime = require('./engine/panda/sessionRuntime')
    const result = sessionRuntime.pushSteer(sessionId, text, {
      images: Array.isArray(body.images) ? body.images : []
    })
    if (!result.ok) return res.status(409).json(result)
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/panda/models', (req, res) => {
  try {
    const img = require('./engine/panda/imageUpload')
    res.json(img.listModelsForUi())
  } catch (e) {
    res.json({
      chat: ['deepseek-chat', 'deepseek-reasoner'],
      vision: [],
      multimodalEnabled: false,
      defaultVision: ''
    })
  }
})

app.post('/api/panda/abort', (req, res) => {
  const sessionId = (req.body && req.body.sessionId) || ''
  const abortRegistry = require('./engine/panda/abortRegistry')
  let ok = false
  try {
    ok = abortRegistry.abortRun(sessionId)
  } catch (e) {
    console.warn('[panda] abortRun error:', e && e.message ? e.message : e)
  }
  res.json({ ok, aborted: ok })
})

app.get('/api/panda/usage', (req, res) => {
  const sessionId = req.query.sessionId || ''
  const cost = require('./engine/panda/cost')
  res.json({ usage: cost.getUsage(sessionId) })
})

app.get('/api/panda/mcp', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const mcp = require('./engine/panda/mcp')
    await mcp.ensureConnected(projectInfo.root).catch(() => {})
    const cfg = await mcp.loadMcpConfig(projectInfo.root)
    const connected = await mcp.listConnected(projectInfo.root)
    const mountedTools = mcp.getOpenAiToolDefinitions(projectInfo.root).map(t => t.function.name)
    res.json({
      autoConnect: cfg.autoConnect !== false,
      configured: cfg.servers || {},
      connected,
      mountedTools,
      pendingOAuth: mcp.getPendingOAuth()
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/mcp/connect', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const mcp = require('./engine/panda/mcp')
    const name = (req.body && req.body.server) || ''
    if (!name || name === '*') {
      const r = await mcp.ensureConnected(projectInfo.root, { force: true, reconnect: true })
      return res.json(r)
    }
    const info = await mcp.connectServer(projectInfo.root, name)
    res.json(info)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/mcp/oauth/token', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const mcp = require('./engine/panda/mcp')
    const server = (req.body && req.body.server) || ''
    const accessToken = (req.body && (req.body.access_token || req.body.accessToken)) || ''
    const refreshToken = (req.body && (req.body.refresh_token || req.body.refreshToken)) || undefined
    if (!server || !accessToken) {
      return res.status(400).json({ error: '需要 server + access_token' })
    }
    await mcp.saveOAuthTokens(projectInfo.root, server, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer'
    })
    let info = null
    try {
      info = await mcp.connectServer(projectInfo.root, server)
    } catch (e) {
      return res.json({ ok: true, saved: true, connectError: e.message })
    }
    res.json({ ok: true, saved: true, connected: info })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/mcp/oauth/callback', async (req, res) => {
  const code = req.query.code || ''
  const state = req.query.state || ''
  const err = req.query.error || ''
  const serverQ = req.query.server || ''
  if (err) {
    return res.type('html').send(
      '<!doctype html><meta charset="utf-8"><title>MCP OAuth</title>' +
      '<body style="font-family:system-ui;padding:2rem">' +
      '<h1>MCP OAuth callback</h1>' +
      '<p style="color:#c00">error: ' + String(err) + '</p></body>'
    )
  }
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const mcp = require('./engine/panda/mcp')
    const result = await mcp.exchangeAuthorizationCode(projectInfo.root, {
      code,
      state,
      server: serverQ
    })
    const ok = result && result.ok
    res.type('html').send(
      '<!doctype html><meta charset="utf-8"><title>MCP OAuth</title>' +
      '<body style="font-family:system-ui;padding:2rem">' +
      '<h1>MCP OAuth ' + (ok ? '成功' : '未完成') + '</h1>' +
      '<pre style="white-space:pre-wrap">' +
      JSON.stringify(result, null, 2).replace(/</g, '&lt;') +
      '</pre>' +
      (ok ? '<p>可关闭本页，返回工作台。</p>' : '<p>若缺 tokenUrl，请在 mcp.json 配置 oauth.tokenUrl 后重试，或 POST /api/panda/mcp/oauth/token。</p>') +
      '</body>'
    )
  } catch (e) {
    res.type('html').status(500).send(
      '<!doctype html><meta charset="utf-8"><title>MCP OAuth</title>' +
      '<body style="font-family:system-ui;padding:2rem"><h1>错误</h1><pre>' +
      String(e.message || e).replace(/</g, '&lt;') + '</pre></body>'
    )
  }
})

app.get('/api/panda/sandbox', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const sandbox = require('./engine/panda/sandbox')
    res.json(sandbox.sandboxStatus(projectInfo.root))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/team/permission', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const body = req.body || {}
    const swarmPerm = require('./engine/panda/swarmPerm')
    const teamId = body.teamId || 'default'
    const id = body.id
    if (!id) return res.status(400).json({ ok: false, error: 'id required' })
    const result = await swarmPerm.resolveTeamPermission(
      projectInfo.root,
      teamId,
      id,
      body.allow !== false && body.allow !== 'false',
      body.reason || 'workbench'
    )
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/panda/worktree', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const worktree = require('./engine/panda/worktree')
    const cur = await worktree.currentWorktree(projectInfo.root)
    res.json({ worktree: cur })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/cron', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const cron = require('./engine/panda/cron')
    res.json({ jobs: await cron.listCron(projectInfo.root) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/panda/cron/tick', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const cron = require('./engine/panda/cron')
    const due = await cron.tickCron(projectInfo.root)
    res.json({ due })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/tasks', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const bg = require('./engine/panda/backgroundTasks')
    res.json({ tasks: bg.listTasks(projectInfo.root) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 浏览器控制台错误上报 / 查询（供 panda browser_console 工具）
app.post('/api/panda/console', (req, res) => {
  try {
    const browserConsole = require('./engine/panda/browserConsole')
    const body = req.body || {}
    const n = browserConsole.ingest(body.entries || body.entry || [], body.sessionId || '')
    res.json({ ok: true, ingested: n, stats: browserConsole.stats() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/console', (req, res) => {
  try {
    const browserConsole = require('./engine/panda/browserConsole')
    const entries = browserConsole.list({
      sessionId: req.query.sessionId || '',
      limit: req.query.limit || 40,
      level: req.query.level || 'all',
      query: req.query.q || '',
      since: req.query.since ? parseInt(req.query.since, 10) : undefined
    })
    res.json({ entries, stats: browserConsole.stats() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/panda/console', (req, res) => {
  try {
    const browserConsole = require('./engine/panda/browserConsole')
    const sessionId = (req.body && req.body.sessionId) || req.query.sessionId || ''
    res.json(browserConsole.clear(sessionId))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/bridge', (req, res) => {
  try {
    const bridge = require('./engine/panda/bridge')
    res.json(bridge.bridgeStats())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/panda/swarms', async (req, res) => {
  try {
    const projectInfo = await engineAnalyzer.analyze()
    const swarm = require('./engine/panda/swarm')
    res.json({ swarms: swarm.listSwarms(projectInfo.root) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 调试：查看当前环境是否加载了 Key（不暴露 key 值）
app.get('/api/debug-env', (req, res) => {
  res.json({
    hasKey: !!process.env.DEEPSEEK_API_KEY,
    keyPrefix: process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY.slice(0, 7) + '...' : null,
    base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    envPath: path.resolve(__dirname, '..', '.env.local')
  })
})

/**
 * 启动 HTTP 服务。Electron 桌面端会调用此方法并传入 staticDir。
 * @param {{ port?: number|string, host?: string, staticDir?: string|null, exitOnError?: boolean }} [options]
 * @returns {Promise<{ httpServer: import('http').Server, port: number, host: string, url: string }>}
 */
function startServer (options = {}) {
  const port = options.port != null ? options.port : PORT
  const host = options.host != null ? options.host : (process.env.HOST || '0.0.0.0')
  const staticDir = options.staticDir || process.env.AIFRONT_STATIC || null
  const exitOnError = options.exitOnError !== false

  if (staticDir) {
    const abs = path.resolve(staticDir)
    if (fs.existsSync(abs)) {
      app.use(express.static(abs))
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        if (req.path.startsWith('/api')) return next()
        res.sendFile(path.join(abs, 'index.html'), (err) => {
          if (err) next()
        })
      })
      console.log('[server] serving static UI from', abs)
    } else {
      console.warn('[server] staticDir 不存在，跳过 UI 静态托管:', abs)
    }
  }

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      const addr = httpServer.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : Number(port)
      const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
      console.log(`[server] listening on http://${displayHost}:${actualPort}`)
      if (!process.env.DEEPSEEK_API_KEY) {
        console.log('[server] 未设置 DEEPSEEK_API_KEY，/chat/completions 将不可用')
        console.log('[server] 请在项目根目录创建 .env.local，写入一行：DEEPSEEK_API_KEY=sk-你的key')
      } else {
        console.log('[server] DEEPSEEK_API_KEY 已加载，base:', DEEPSEEK_BASE)
      }
      // 常驻 cron + autoDream（可用 PANDA_CRON_SCHEDULER=0 关闭）
      try {
        const projectRoot = process.env.PANDA_PROJECT_ROOT
          ? path.resolve(process.env.PANDA_PROJECT_ROOT)
          : path.resolve(__dirname, '..')
        require('./engine/panda/cron').startBackgroundScheduler(projectRoot)
      } catch (e) {
        console.warn('[server] cron scheduler failed:', e.message)
      }
      resolve({
        httpServer,
        port: actualPort,
        host,
        url: `http://${displayHost}:${actualPort}`
      })
    })

    httpServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`[server] 端口 ${port} 已被占用。先释放再启动：`)
        console.error(`  lsof -ti :${port} | xargs kill -9`)
        console.error('然后重新执行 yarn server / npm run server')
        if (exitOnError) process.exit(1)
      } else {
        console.error('[server] 启动失败:', err)
        if (exitOnError) process.exit(1)
      }
      reject(err)
    })

    try {
      require('./engine/panda/bridge').attachBridge(httpServer)
    } catch (bridgeErr) {
      console.warn('[panda-bridge] 未能挂载：', bridgeErr.message)
    }

    function gracefulShutdown (signal) {
      console.log('[server] ' + signal + ' — shutting down…')
      try {
        require('./engine/panda/cron').stopBackgroundScheduler()
      } catch (e) { /* ignore */ }
      Promise.resolve()
        .then(() => {
          try {
            return require('./engine/panda/lsp').shutdownAll()
          } catch (e) {
            return null
          }
        })
        .finally(() => {
          httpServer.close(() => process.exit(0))
          setTimeout(() => process.exit(0), 3000)
        })
    }
    if (!process.env.CHOMIRCODE_DESKTOP && !process.env.AIFRONT_DESKTOP) {
      process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
      process.once('SIGINT', () => gracefulShutdown('SIGINT'))
    }
  })
}

module.exports = { app, startServer, PORT }

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[server] start failed:', err)
    process.exit(1)
  })
}
