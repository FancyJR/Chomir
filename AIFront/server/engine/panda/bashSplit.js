/**
 * Quote-aware bash compound split（对齐 splitCommand_DEPRECATED 精髓）
 * 按 && || ; | 拆段；不完整 AST，但堵住「mkdir && npm i」整串白名单洞。
 */

/**
 * @param {string} command
 * @returns {string[]} 子命令列表（已 trim，去掉空段）
 */
function splitBashSegments (command) {
  const s = String(command || '')
  if (!s.trim()) return []

  const parts = []
  let cur = ''
  let quote = null // ' | " | `
  let escaped = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const next = s[i + 1]

    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (quote) {
      if (ch === '\\' && quote !== "'") {
        cur += ch
        escaped = true
        continue
      }
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '\\') {
      cur += ch
      escaped = true
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }

    // operators outside quotes
    if (ch === '&' && next === '&') {
      push(parts, cur)
      cur = ''
      i++
      continue
    }
    if (ch === '|' && next === '|') {
      push(parts, cur)
      cur = ''
      i++
      continue
    }
    if (ch === ';' || ch === '|') {
      // single | (pipeline) — 每段分别校验
      push(parts, cur)
      cur = ''
      continue
    }
    // newlines as separators
    if (ch === '\n' || ch === '\r') {
      push(parts, cur)
      cur = ''
      continue
    }

    cur += ch
  }
  push(parts, cur)
  return parts
}

function push (parts, cur) {
  const t = String(cur || '').trim()
  if (t) parts.push(t)
}

/**
 * 取段首 token（命令名）
 */
function baseCommand (segment) {
  const t = String(segment || '').trim()
  if (!t) return ''
  // strip env assigns: FOO=1 BAR=2 cmd ...
  const withoutEnv = t.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
  const m = withoutEnv.match(/^([^\s]+)/)
  return m ? m[1].replace(/^\\/, '') : ''
}

/**
 * 建议 allow 前缀：前 1–2 个有意义 token（对齐 Bash(npm run:*)）
 */
function suggestBashPrefix (command) {
  const segs = splitBashSegments(command)
  const first = segs[0] || String(command || '').trim()
  if (!first) return null
  const withoutEnv = first.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
  const tokens = withoutEnv.split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  const cmd = tokens[0]
  // 常见双词：npm run / git xxx / yarn / pnpm / cargo / docker
  if (/^(npm|pnpm|yarn|git|docker|cargo|pip|pip3|composer)$/i.test(cmd) && tokens[1] && !/^-/.test(tokens[1])) {
    return cmd + ' ' + tokens[1]
  }
  return cmd
}

module.exports = {
  splitBashSegments,
  baseCommand,
  suggestBashPrefix
}
