/* 共享的 DeepSeek JSON 调用封装，用于 planner / codegen 等模块 */

const path = require('path')
const envPath = path.resolve(__dirname, '..', '..', '.env.local')
require('dotenv').config({ path: envPath, quiet: true })
// legacy fallback (server/.env.local)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true })

const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')
const DEEPSEEK_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_TIMEOUT_MS, 10) || 120000

// 简单 JSON 安全解析：去掉 ``` 包裹 + 截断情况下尽量返回 null
function safeJsonParse (text) {
  if (!text) return null
  let s = String(text || '').trim()
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(s)
  } catch (e) {
    return null
  }
}

async function callDeepseekJson (systemPrompt, userPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('NO_MODEL_CONFIG')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS)

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    // 请求 JSON 输出，降低解析出错概率
    response_format: { type: 'json_object' }
  }

  const url = `${DEEPSEEK_BASE}/chat/completions`
  let res
  try {
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
      throw new Error('大模型请求超时，请稍后重试')
    }
    throw e
  }

  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const errRoot = text ? JSON.parse(text) : null
      if (errRoot && errRoot.error && errRoot.error.message) {
        msg = errRoot.error.message
      }
    } catch (e) {
      // ignore
    }
    throw new Error(msg)
  }

  if (!text) return null

  // DeepSeek / OpenAI 风格：先解析顶层 JSON，再从 choices[0].message.content 中取出模型输出
  let root = null
  try {
    root = JSON.parse(text)
  } catch (e) {
    // 顶层不是 JSON，尝试直接解析为 { "answer": ... } 这类 JSON 文本
    return safeJsonParse(text)
  }

  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = choices[0]
  const message = first && first.message
  const content = message && message.content

  // response_format 为 json_object 时，content 可能已经是对象
  if (content && typeof content === 'object') {
    return content
  }
  if (typeof content === 'string') {
    return safeJsonParse(content)
  }

  // 兜底：再尝试直接解析顶层
  return safeJsonParse(text)
}

module.exports = {
  callDeepseekJson
}

// 纯文本模式：直接拿模型输出的 content 字符串；options 可传 { max_tokens } 避免大文件被截断
async function callDeepseekText (systemPrompt, userPrompt, options) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('NO_MODEL_CONFIG')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS)

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false
  }
  if (options && typeof options.max_tokens === 'number' && options.max_tokens > 0) {
    body.max_tokens = options.max_tokens
  }

  const url = `${DEEPSEEK_BASE}/chat/completions`
  let res
  try {
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
      throw new Error('大模型请求超时，请稍后重试')
    }
    throw e
  }

  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const errRoot = text ? JSON.parse(text) : null
      if (errRoot && errRoot.error && errRoot.error.message) {
        msg = errRoot.error.message
      }
    } catch (e) {
      // ignore
    }
    throw new Error(msg)
  }

  if (!text) return ''
  let root = null
  try {
    root = JSON.parse(text)
  } catch (e) {
    // 顶层不是 JSON，则整个当作文本返回
    return text
  }
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = choices[0]
  const message = first && first.message
  const content = message && message.content
  if (typeof content === 'string') return content
  return JSON.stringify(content || {})
}

module.exports.callDeepseekText = callDeepseekText

/**
 * 流式调用 DeepSeek，逐块返回 content（用于问答等需实时展示的场景）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @yields {string} 每块文本
 */
async function * callDeepseekStream (systemPrompt, userPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('NO_MODEL_CONFIG')
  }

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: true
  }

  const url = `${DEEPSEEK_BASE}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text()
    let msg = `HTTP ${res.status}`
    try {
      const errRoot = text ? JSON.parse(text) : null
      if (errRoot && errRoot.error && errRoot.error.message) {
        msg = errRoot.error.message
      }
    } catch (e) {
      // ignore
    }
    throw new Error(msg)
  }

  const reader = res.body && res.body.getReader()
  if (!reader) {
    throw new Error('Stream not available')
  }

  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6))
            const content = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content
            if (typeof content === 'string' && content) {
              yield content
            }
          } catch (e) {
            // ignore parse error for single chunk
          }
        }
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6))
          const content = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content
          if (typeof content === 'string' && content) {
            yield content
          }
        } catch (e) {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 流式调用 DeepSeek 纯文本（用于 codegen 等需边生成边展示的场景，支持 max_tokens）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{ max_tokens?: number }} options
 * @yields {string} 每块文本
 */
async function * callDeepseekTextStream (systemPrompt, userPrompt, options) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('NO_MODEL_CONFIG')
  }

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: true
  }
  if (options && typeof options.max_tokens === 'number' && options.max_tokens > 0) {
    body.max_tokens = options.max_tokens
  }

  const url = `${DEEPSEEK_BASE}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text()
    let msg = `HTTP ${res.status}`
    try {
      const errRoot = text ? JSON.parse(text) : null
      if (errRoot && errRoot.error && errRoot.error.message) {
        msg = errRoot.error.message
      }
    } catch (e) {
      // ignore
    }
    throw new Error(msg)
  }

  const reader = res.body && res.body.getReader()
  if (!reader) {
    throw new Error('Stream not available')
  }

  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6))
            const content = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content
            if (typeof content === 'string' && content) {
              yield content
            }
          } catch (e) {
            // ignore parse error for single chunk
          }
        }
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6))
          const content = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content
          if (typeof content === 'string' && content) {
            yield content
          }
        } catch (e) {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 流式调用 DeepSeek 并期望最终为 JSON：逐块回调 onChunk，流结束后解析完整内容为 JSON 返回
 * （用于思维引擎等需边推流展示思考过程、最后再解析结构化结果的场景）
 */
async function callDeepseekStreamJson (systemPrompt, userPrompt, onChunk) {
  let fullContent = ''
  for await (const chunk of callDeepseekStream(systemPrompt, userPrompt)) {
    fullContent += chunk
    if (typeof onChunk === 'function') onChunk(chunk)
  }
  return safeJsonParse(fullContent)
}

const REASONING_SEP = '\n---JSON---\n'

/**
 * 流式调用：模型先输出自然段思考，再输出 ---JSON--- 换行后的一行 JSON。
 * 只把「思考段落」逐块传给 onChunk（和 Cursor 一样只展示可读思考），JSON 部分仅用于解析返回。
 */
async function callDeepseekStreamJsonReasoningFirst (systemPrompt, userPrompt, onChunk) {
  let fullContent = ''
  let sentLength = 0
  let jsonPart = null
  for await (const chunk of callDeepseekStream(systemPrompt, userPrompt)) {
    fullContent += chunk
    if (jsonPart !== null) {
      jsonPart += chunk
      continue
    }
    const sepIdx = fullContent.indexOf(REASONING_SEP)
    if (sepIdx === -1) {
      if (typeof onChunk === 'function') onChunk(chunk)
      sentLength = fullContent.length
    } else {
      if (sentLength < sepIdx && typeof onChunk === 'function') {
        onChunk(fullContent.slice(sentLength, sepIdx))
      }
      jsonPart = fullContent.slice(sepIdx + REASONING_SEP.length)
    }
  }
  const jsonStr = jsonPart !== null ? jsonPart : fullContent
  return safeJsonParse(jsonStr)
}

module.exports.callDeepseekStream = callDeepseekStream
module.exports.callDeepseekTextStream = callDeepseekTextStream
module.exports.callDeepseekStreamJson = callDeepseekStreamJson
module.exports.callDeepseekStreamJsonReasoningFirst = callDeepseekStreamJsonReasoningFirst

/**
 * OpenAI/DeepSeek 兼容的多轮 messages + tools 调用（Panda Agent 主循环用）
 * 支持 stream + AbortSignal + onDelta/onThinking（reasoner）
 * @param {object} options
 * @param {Array} options.messages
 * @param {Array} [options.tools]
 * @param {string} [options.model]
 * @param {number} [options.max_tokens]
 * @param {string} [options.tool_choice]
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.onDelta]
 * @param {function} [options.onThinking]
 * @param {boolean} [options.stream]
 * @returns {Promise<{ message: object, finish_reason: string, usage?: object, reasoning?: string }>}
 */
async function callDeepseekChat (options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('NO_MODEL_CONFIG')
  }
  const messages = Array.isArray(options.messages) ? options.messages : []
  if (!messages.length) {
    throw new Error('callDeepseekChat: messages 不能为空')
  }

  const wantStream = options.stream === true ||
    typeof options.onDelta === 'function' ||
    typeof options.onThinking === 'function'

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    try { timeoutController.abort() } catch (e) { /* ignore */ }
  }, DEEPSEEK_TIMEOUT_MS)
  const external = options.signal

  /** 吞掉 cancel()/abort 引发的 Promise 拒绝，避免未捕获 AbortError 打崩进程 */
  const swallow = (p) => {
    try {
      if (p && typeof p.then === 'function') p.then(function () {}, function () {})
    } catch (e) { /* ignore */ }
  }

  let reader = null
  let res = null

  const safeCancelStream = () => {
    try {
      if (reader && typeof reader.cancel === 'function') swallow(reader.cancel())
    } catch (e) { /* ignore */ }
    try {
      if (res && res.body && typeof res.body.cancel === 'function') swallow(res.body.cancel())
    } catch (e) { /* ignore */ }
  }

  const onExtAbort = () => {
    try { timeoutController.abort() } catch (e) { /* ignore */ }
    safeCancelStream()
  }
  if (external) {
    if (external.aborted) {
      clearTimeout(timeoutId)
      throw new Error('已取消')
    }
    external.addEventListener('abort', onExtAbort, { once: true })
  }

  const body = {
    model: options.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages,
    stream: wantStream
  }
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = options.tools
    body.tool_choice = options.tool_choice || 'auto'
  }
  if (options.max_tokens) body.max_tokens = options.max_tokens
  if (options.temperature != null) body.temperature = options.temperature

  const url = `${DEEPSEEK_BASE}/chat/completions`
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    })
  } catch (e) {
    clearTimeout(timeoutId)
    if (external) external.removeEventListener('abort', onExtAbort)
    if (e && (e.name === 'AbortError' || e.code === 20 || /aborted/i.test(String(e.message || '')))) {
      throw new Error(external && external.aborted ? '已取消' : '大模型请求超时，请稍后重试')
    }
    throw e
  }

  if (!res.ok) {
    clearTimeout(timeoutId)
    if (external) external.removeEventListener('abort', onExtAbort)
    let text = ''
    try { text = await res.text() } catch (e) { /* ignore */ }
    let msg = `HTTP ${res.status}`
    try {
      const errRoot = text ? JSON.parse(text) : null
      if (errRoot && errRoot.error && errRoot.error.message) msg = errRoot.error.message
    } catch (e) {}
    const err = new Error(msg)
    err.status = res.status
    err.statusCode = res.status
    if (
      res.status === 413 ||
      /prompt\s*(is\s*)?too\s*long/i.test(msg) ||
      /context[_ ]length|maximum context|too many tokens|token limit|request too large/i.test(msg)
    ) {
      err.code = 'PROMPT_TOO_LONG'
    }
    throw err
  }

  if (!wantStream) {
    clearTimeout(timeoutId)
    if (external) external.removeEventListener('abort', onExtAbort)
    let text
    try {
      text = await res.text()
    } catch (e) {
      if (e && (e.name === 'AbortError' || (external && external.aborted))) throw new Error('已取消')
      throw e
    }
    let root
    try { root = JSON.parse(text) } catch (e) { throw new Error('模型返回非 JSON') }
    const choice = (root.choices && root.choices[0]) || {}
    const message = choice.message || { role: 'assistant', content: '' }
    return {
      message,
      finish_reason: choice.finish_reason || 'stop',
      usage: root.usage || null,
      reasoning: message.reasoning_content || ''
    }
  }

  const onDelta = typeof options.onDelta === 'function' ? options.onDelta : () => {}
  const onThinking = typeof options.onThinking === 'function' ? options.onThinking : () => {}
  let content = ''
  let reasoning = ''
  const toolAcc = new Map()
  let finishReason = 'stop'
  let usage = null

  if (external && external.aborted) {
    clearTimeout(timeoutId)
    external.removeEventListener('abort', onExtAbort)
    safeCancelStream()
    throw new Error('已取消')
  }

  try {
    reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      if (external && external.aborted) throw new Error('已取消')
      let chunk
      try {
        chunk = await reader.read()
      } catch (readErr) {
        if ((external && external.aborted) || (readErr && (readErr.name === 'AbortError' || /aborted/i.test(String(readErr.message || ''))))) {
          throw new Error('已取消')
        }
        throw readErr
      }
      const { done, value } = chunk
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() || ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        let json
        try { json = JSON.parse(data) } catch (e) { continue }
        if (json.usage) usage = json.usage
        const choice = (json.choices && json.choices[0]) || {}
        if (choice.finish_reason) finishReason = choice.finish_reason
        const delta = choice.delta || {}
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content
          onThinking(delta.reasoning_content)
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content
          onDelta(delta.content)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index != null ? tc.index : 0
            if (!toolAcc.has(idx)) {
              toolAcc.set(idx, {
                id: tc.id || ('call_' + idx),
                type: 'function',
                function: { name: '', arguments: '' }
              })
            }
            const acc = toolAcc.get(idx)
            if (tc.id) acc.id = tc.id
            if (tc.function) {
              if (tc.function.name) acc.function.name += tc.function.name
              if (tc.function.arguments) acc.function.arguments += tc.function.arguments
            }
          }
        }
      }
    }
  } catch (streamErr) {
    if ((external && external.aborted) || (streamErr && (streamErr.name === 'AbortError' || streamErr.message === '已取消' || /aborted/i.test(String(streamErr.message || ''))))) {
      throw new Error('已取消')
    }
    throw streamErr
  } finally {
    clearTimeout(timeoutId)
    if (external) external.removeEventListener('abort', onExtAbort)
    safeCancelStream()
  }

  const tool_calls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter(v => v.function && v.function.name)

  const message = {
    role: 'assistant',
    content: content || null,
    tool_calls: tool_calls.length ? tool_calls : undefined
  }
  if (reasoning) message.reasoning_content = reasoning

  return { message, finish_reason: finishReason, usage, reasoning }
}

module.exports.callDeepseekChat = callDeepseekChat
