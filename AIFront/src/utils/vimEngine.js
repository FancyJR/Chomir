/**
 * Vim 文本对象 + 操作符（移植 panda-code/vim/textObjects + operators 精简）
 * 用于 PandaWorkbench 输入框 NORMAL 模式。
 */

const PAIRS = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
  '"': ['"', '"'],
  "'": ["'", "'"],
  '`': ['`', '`']
}

function isWs (ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function isWordChar (ch) {
  return /[A-Za-z0-9_]/.test(ch)
}

function isPunct (ch) {
  return ch && !isWs(ch) && !isWordChar(ch)
}

export function findTextObject (text, offset, objectType, isInner) {
  if (objectType === 'w') return findWordObject(text, offset, isInner, isWordChar)
  if (objectType === 'W') return findWordObject(text, offset, isInner, ch => !isWs(ch))
  const pair = PAIRS[objectType]
  if (!pair) return null
  const [open, close] = pair
  return open === close
    ? findQuoteObject(text, offset, open, isInner)
    : findBracketObject(text, offset, open, close, isInner)
}

function findWordObject (text, offset, isInner, isWord) {
  if (!text.length) return null
  let i = Math.max(0, Math.min(offset, text.length - 1))
  let start = i
  let end = i
  const ch = text[i] || ''
  if (isWord(ch)) {
    while (start > 0 && isWord(text[start - 1])) start--
    while (end < text.length && isWord(text[end])) end++
  } else if (isWs(ch)) {
    while (start > 0 && isWs(text[start - 1])) start--
    while (end < text.length && isWs(text[end])) end++
    return { start, end }
  } else if (isPunct(ch)) {
    while (start > 0 && isPunct(text[start - 1])) start--
    while (end < text.length && isPunct(text[end])) end++
  } else {
    return { start: i, end: Math.min(i + 1, text.length) }
  }
  if (!isInner) {
    if (end < text.length && isWs(text[end])) {
      while (end < text.length && isWs(text[end])) end++
    } else if (start > 0 && isWs(text[start - 1])) {
      while (start > 0 && isWs(text[start - 1])) start--
    }
  }
  return { start, end }
}

function findQuoteObject (text, offset, quote, isInner) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  let lineEnd = text.indexOf('\n', offset)
  if (lineEnd === -1) lineEnd = text.length
  const line = text.slice(lineStart, lineEnd)
  const posInLine = offset - lineStart
  const positions = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) positions.push(i)
  }
  for (let i = 0; i < positions.length - 1; i += 2) {
    const qs = positions[i]
    const qe = positions[i + 1]
    if (qs <= posInLine && posInLine <= qe) {
      return isInner
        ? { start: lineStart + qs + 1, end: lineStart + qe }
        : { start: lineStart + qs, end: lineStart + qe + 1 }
    }
  }
  return null
}

function findBracketObject (text, offset, open, close, isInner) {
  let depth = 0
  let start = -1
  for (let i = offset; i >= 0; i--) {
    if (text[i] === close && i !== offset) depth++
    else if (text[i] === open) {
      if (depth === 0) { start = i; break }
      depth--
    }
  }
  if (start === -1) return null
  depth = 0
  let end = -1
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      if (depth === 0) { end = i; break }
      depth--
    }
  }
  if (end === -1) return null
  return isInner ? { start: start + 1, end } : { start, end: end + 1 }
}

function lineBounds (text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  let end = text.indexOf('\n', offset)
  if (end === -1) end = text.length
  else end += 1 // include newline
  return { start, end }
}

function moveWord (text, offset, count, forward) {
  let i = offset
  for (let n = 0; n < count; n++) {
    if (forward) {
      if (i >= text.length) break
      if (isWordChar(text[i])) while (i < text.length && isWordChar(text[i])) i++
      else if (!isWs(text[i])) while (i < text.length && isPunct(text[i])) i++
      while (i < text.length && isWs(text[i])) i++
    } else {
      if (i <= 0) break
      i--
      while (i > 0 && isWs(text[i])) i--
      if (isWordChar(text[i])) while (i > 0 && isWordChar(text[i - 1])) i--
      else while (i > 0 && isPunct(text[i - 1])) i--
    }
  }
  return i
}

/**
 * 创建可复用的 Vim 状态机（绑定到组件）
 */
export function createVimController (api) {
  // api: { getText, setText, getOffset, setOffset, enterInsert, getRegister?, setRegister? }
  let op = null // 'd' | 'c' | 'y'
  let scope = null // 'i' | 'a'
  let countBuf = ''
  let register = { content: '', linewise: false }
  let lastChange = null

  function resetPending () {
    op = null
    scope = null
    countBuf = ''
  }

  function getCount () {
    const n = parseInt(countBuf, 10)
    countBuf = ''
    return Number.isFinite(n) && n > 0 ? n : 1
  }

  function applyRange (from, to, operator, linewise) {
    const text = api.getText()
    const a = Math.min(from, to)
    const b = Math.max(from, to)
    const sliced = text.slice(a, b)
    register = { content: sliced, linewise: !!linewise }
    if (api.setRegister) api.setRegister(register.content, register.linewise)
    if (operator === 'y') {
      api.setOffset(a)
      return
    }
    const next = text.slice(0, a) + text.slice(b)
    api.setText(next)
    api.setOffset(Math.min(a, next.length))
    if (operator === 'c') api.enterInsert(Math.min(a, next.length))
    lastChange = { type: 'range', operator, from: a, to: b, linewise: !!linewise, text: sliced }
  }

  function doLineOp (operator, count) {
    const text = api.getText()
    let offset = api.getOffset()
    let start = lineBounds(text, offset).start
    let end = start
    for (let i = 0; i < count; i++) {
      const b = lineBounds(text, Math.min(end, text.length ? text.length - 1 : 0))
      end = b.end
      if (end >= text.length) break
    }
    applyRange(start, end, operator, true)
  }

  function paste (after) {
    const reg = api.getRegister ? api.getRegister() : register
    const content = reg.content || register.content || ''
    if (!content) return
    const linewise = reg.linewise != null ? reg.linewise : register.linewise
    let text = api.getText()
    let offset = api.getOffset()
    if (linewise) {
      const b = lineBounds(text, offset)
      const insertAt = after ? b.end : b.start
      const piece = content.endsWith('\n') ? content : content + '\n'
      text = text.slice(0, insertAt) + piece + text.slice(insertAt)
      api.setText(text)
      api.setOffset(insertAt)
    } else {
      const at = after ? Math.min(offset + 1, text.length) : offset
      text = text.slice(0, at) + content + text.slice(at)
      api.setText(text)
      api.setOffset(at + content.length)
    }
  }

  /**
   * @returns {boolean} handled
   */
  function handleKey (key, e) {
    const text = api.getText()
    const offset = api.getOffset()

    if (/^[1-9]$/.test(key) || (countBuf && key === '0' && !op && !scope)) {
      countBuf += key
      return true
    }

    // pending text-object: diw, daw, ci", ya(
    if (op && scope) {
      const count = getCount()
      const range = findTextObject(text, offset, key, scope === 'i')
      resetPending()
      if (!range) return true
      // count>1 for words: extend
      let { start, end } = range
      if (count > 1 && (key === 'w' || key === 'W')) {
        for (let n = 1; n < count; n++) {
          const more = findTextObject(text, end, key, scope === 'i')
          if (!more) break
          end = more.end
        }
      }
      applyRange(start, end, op, false)
      return true
    }

    // operator waiting for motion/object
    if (op) {
      if (key === 'i' || key === 'a') {
        scope = key
        return true
      }
      if (key === op) {
        // dd / cc / yy
        const count = getCount()
        doLineOp(op, count)
        resetPending()
        return true
      }
      // motions with operator
      const count = getCount()
      if (key === 'w' || key === 'W') {
        const to = moveWord(text, offset, count, true)
        applyRange(offset, to, op, false)
        resetPending()
        return true
      }
      if (key === 'b') {
        const to = moveWord(text, offset, count, false)
        applyRange(to, offset, op, false)
        resetPending()
        return true
      }
      if (key === '0' || key === 'Home') {
        const b = lineBounds(text, offset)
        applyRange(b.start, offset, op, false)
        resetPending()
        return true
      }
      if (key === '$' || key === 'End') {
        const b = lineBounds(text, offset)
        const end = b.end > b.start && text[b.end - 1] === '\n' ? b.end - 1 : b.end
        applyRange(offset, end, op, false)
        resetPending()
        return true
      }
      if (key === 'G') {
        applyRange(offset, text.length, op, false)
        resetPending()
        return true
      }
      resetPending()
      return true
    }

    // start operator
    if (key === 'd' || key === 'c' || key === 'y') {
      op = key
      return true
    }

    if (key === 'p') { paste(true); return true }
    if (key === 'P') { paste(false); return true }

    if (key === 'x') {
      const count = getCount()
      applyRange(offset, Math.min(offset + count, text.length), 'd', false)
      return true
    }

    if (key === '~') {
      // toggle case
      if (offset >= text.length) return true
      const ch = text[offset]
      const tog = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
      api.setText(text.slice(0, offset) + tog + text.slice(offset + 1))
      api.setOffset(Math.min(offset + 1, text.length))
      return true
    }

    // motions only
    const count = getCount()
    if (key === 'h' || key === 'ArrowLeft') {
      api.setOffset(Math.max(0, offset - count)); return true
    }
    if (key === 'l' || key === 'ArrowRight') {
      api.setOffset(Math.min(text.length, offset + count)); return true
    }
    if (key === 'j' || key === 'ArrowDown') {
      // move down roughly by finding next lines
      let i = offset
      for (let n = 0; n < count; n++) {
        const nl = text.indexOf('\n', i)
        if (nl === -1) { i = text.length; break }
        i = nl + 1
      }
      api.setOffset(i); return true
    }
    if (key === 'k' || key === 'ArrowUp') {
      let i = offset
      for (let n = 0; n < count; n++) {
        const b = lineBounds(text, i)
        if (b.start === 0) { i = 0; break }
        i = b.start - 1
        const prev = lineBounds(text, i)
        i = prev.start
      }
      api.setOffset(i); return true
    }
    if (key === 'w') { api.setOffset(moveWord(text, offset, count, true)); return true }
    if (key === 'b') { api.setOffset(moveWord(text, offset, count, false)); return true }
    if (key === '0' || key === 'Home') { api.setOffset(lineBounds(text, offset).start); return true }
    if (key === '$' || key === 'End') {
      const b = lineBounds(text, offset)
      api.setOffset(b.end > 0 && text[b.end - 1] === '\n' ? b.end - 1 : b.end)
      return true
    }
    if (key === 'g') {
      // gg
      if (countBuf === '' && !api._vimGPending) {
        api._vimGPending = true
        return true
      }
    }
    if (api._vimGPending && key === 'g') {
      api._vimGPending = false
      api.setOffset(0)
      return true
    }
    api._vimGPending = false
    if (key === 'G') { api.setOffset(text.length); return true }

    if (key === 'i') { api.enterInsert(offset); return true }
    if (key === 'a') { api.enterInsert(Math.min(offset + 1, text.length)); return true }
    if (key === 'A') {
      const b = lineBounds(text, offset)
      const end = b.end > 0 && text[b.end - 1] === '\n' ? b.end - 1 : b.end
      api.enterInsert(end); return true
    }
    if (key === 'I') { api.enterInsert(lineBounds(text, offset).start); return true }
    if (key === 'o') {
      const b = lineBounds(text, offset)
      const next = text.slice(0, b.end) + '\n' + text.slice(b.end)
      api.setText(next)
      api.enterInsert(b.end)
      return true
    }
    if (key === 'O') {
      const b = lineBounds(text, offset)
      const next = text.slice(0, b.start) + '\n' + text.slice(b.start)
      api.setText(next)
      api.enterInsert(b.start)
      return true
    }

    return false
  }

  return {
    handleKey,
    resetPending,
    getRegister: () => register,
    setRegister: (c, lw) => { register = { content: c, linewise: !!lw } }
  }
}
