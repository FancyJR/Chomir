/**
 * 保证发给 API 的 messages 满足：
 * 1) tool 消息必须紧跟带 tool_calls 的 assistant，且每个 tool_call_id 都有结果
 * 2) 多模态：仅当 allowMultimodal 时保留 image_url；否则压成纯文本（不对不支持的模型带该参数）
 */

function flattenContentToText (content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch (e) { return String(content) }
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text != null) {
      parts.push(String(block.text))
      continue
    }
    if (block.type === 'image_url') {
      const url = (block.image_url && block.image_url.url) || ''
      if (url.startsWith('data:')) {
        parts.push('[图片已省略 · 当前模型不支持多模态 image_url]')
      } else {
        parts.push('[图片引用] ' + String(url).slice(0, 300))
      }
      continue
    }
    if (block.text != null) parts.push(String(block.text))
  }
  return parts.join('\n').trim() || '（空内容）'
}

/** 保留多模态 content parts（仅 user/system）；assistant/tool 仍压成文本 */
function preserveContent (content, allowMultimodal) {
  if (!allowMultimodal || typeof content === 'string' || content == null) {
    return flattenContentToText(content)
  }
  if (!Array.isArray(content)) return flattenContentToText(content)
  const parts = content.filter(b => b && (b.type === 'text' || b.type === 'image_url'))
  if (!parts.length) return flattenContentToText(content)
  if (!parts.some(b => b.type === 'image_url')) return flattenContentToText(content)
  return parts
}

/**
 * @param {Array} messages
 * @param {{ allowMultimodal?: boolean }} [opts]
 */
function sanitizeMessagesForApi (messages, opts) {
  const allowMultimodal = !!(opts && opts.allowMultimodal)
  if (!Array.isArray(messages) || !messages.length) return messages || []

  const out = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (!m || !m.role) {
      i++
      continue
    }

    // 孤立的 tool：丢掉（前面没有匹配的 assistant.tool_calls）
    if (m.role === 'tool') {
      i++
      continue
    }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.filter(tc => tc && tc.id)
      if (!calls.length) {
        out.push({
          role: 'assistant',
          content: flattenContentToText(m.content)
        })
        i++
        continue
      }

      out.push({
        role: 'assistant',
        content: m.content != null ? flattenContentToText(m.content) : null,
        tool_calls: calls
      })

      const needed = new Map()
      for (const tc of calls) needed.set(tc.id, true)

      i++
      while (i < messages.length && messages[i] && messages[i].role === 'tool') {
        const t = messages[i]
        const id = t.tool_call_id
        if (id && needed.has(id)) {
          out.push({
            role: 'tool',
            tool_call_id: id,
            content: flattenContentToText(t.content)
          })
          needed.delete(id)
        }
        i++
      }

      for (const id of needed.keys()) {
        out.push({
          role: 'tool',
          tool_call_id: id,
          content: '（工具未执行完成或上下文压缩时丢失结果）'
        })
      }
      continue
    }

    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: flattenContentToText(m.content) })
      i++
      continue
    }

    if (m.role === 'user' || m.role === 'system') {
      out.push({
        role: m.role,
        content: preserveContent(m.content, allowMultimodal)
      })
      i++
      continue
    }

    out.push({
      role: m.role,
      content: flattenContentToText(m.content)
    })
    i++
  }

  return out
}

/**
 * 压缩时不要从 tool 中间切开：把 keep 起点向前扩到所属 assistant.tool_calls。
 */
function expandKeepStart (body, keepStart) {
  let start = Math.max(0, keepStart)
  while (start > 0 && body[start] && body[start].role === 'tool') {
    start--
  }
  while (start < body.length && body[start] && body[start].role === 'tool') {
    start++
  }
  return start
}

module.exports = {
  sanitizeMessagesForApi,
  flattenContentToText,
  expandKeepStart
}
