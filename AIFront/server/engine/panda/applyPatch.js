/**
 * 应用 unified diff / 简易 patch（利于精准改码）
 */

function applyUnifiedDiff (original, patchText) {
  const src = String(original || '').replace(/\r\n/g, '\n').split('\n')
  const lines = String(patchText || '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  // skip headers
  while (i < lines.length && (lines[i].startsWith('diff ') || lines[i].startsWith('index ') || lines[i].startsWith('---') || lines[i].startsWith('+++'))) i++

  const out = src.slice()
  let offset = 0

  while (i < lines.length) {
    const h = lines[i]
    const m = h.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
    if (!m) { i++; continue }
    i++
    const oldStart = parseInt(m[1], 10) - 1
    const remove = []
    const add = []
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const L = lines[i]
      if (L.startsWith('\\')) { i++; continue }
      if (L.startsWith('-')) remove.push(L.slice(1))
      else if (L.startsWith('+')) add.push(L.slice(1))
      else if (L.startsWith(' ') || L === '') {
        // context — keep as remove+add same
        remove.push(L.startsWith(' ') ? L.slice(1) : L)
        add.push(L.startsWith(' ') ? L.slice(1) : L)
      } else break
      i++
    }
    // Find oldStart in out considering prior offsets — use content match for robustness
    let at = oldStart + offset
    // verify context
    let ok = true
    for (let k = 0; k < remove.length; k++) {
      if (out[at + k] !== remove[k]) { ok = false; break }
    }
    if (!ok) {
      // search nearby
      const needle = remove.filter(r => r.trim()).slice(0, 3)
      let found = -1
      for (let p = 0; p < out.length; p++) {
        let match = true
        for (let k = 0; k < remove.length; k++) {
          if (out[p + k] !== remove[k]) { match = false; break }
        }
        if (match) { found = p; break }
      }
      if (found < 0) {
        return { ok: false, message: 'patch 无法定位片段：\n' + remove.slice(0, 5).map(x => '- ' + x).join('\n') }
      }
      at = found
    }
    out.splice(at, remove.length, ...add)
    offset += add.length - remove.length
  }
  return { ok: true, content: out.join('\n') }
}

function replaceLines (original, startLine, endLine, newContent) {
  const lines = String(original || '').replace(/\r\n/g, '\n').split('\n')
  const start = Math.max(1, parseInt(startLine, 10) || 1)
  const end = Math.max(start, parseInt(endLine, 10) || start)
  if (start > lines.length + 1) {
    return { ok: false, message: 'start_line 超出文件行数 ' + lines.length }
  }
  const replacement = String(newContent == null ? '' : newContent).replace(/\r\n/g, '\n').split('\n')
  // if newContent ends with newline, split leaves trailing ''; keep as-is for line replace
  const before = lines.slice(0, start - 1)
  const after = lines.slice(end)
  const next = before.concat(replacement).concat(after)
  return { ok: true, content: next.join('\n'), replaced: end - start + 1 }
}

module.exports = { applyUnifiedDiff, replaceLines }
