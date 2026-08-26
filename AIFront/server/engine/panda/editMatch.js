/**
 * 写码匹配引擎（复刻 panda-code/tools/FileEditTool/utils.ts）
 */

const fs = require('fs')
const path = require('path')

const LEFT_SINGLE_CURLY_QUOTE = '\u2018'
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'
const LEFT_DOUBLE_CURLY_QUOTE = '\u201C'
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D'

const DESANITIZATIONS = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:'
}

function normalizeQuotes (str) {
  return String(str || '')
    .split(LEFT_SINGLE_CURLY_QUOTE).join("'")
    .split(RIGHT_SINGLE_CURLY_QUOTE).join("'")
    .split(LEFT_DOUBLE_CURLY_QUOTE).join('"')
    .split(RIGHT_DOUBLE_CURLY_QUOTE).join('"')
}

function stripTrailingWhitespace (str) {
  const lines = String(str || '').split(/(\r\n|\n|\r)/)
  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part === undefined) continue
    if (i % 2 === 0) result += part.replace(/\s+$/, '')
    else result += part
  }
  return result
}

function toLF (s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function detectEOL (raw) {
  return String(raw || '').includes('\r\n') ? '\r\n' : '\n'
}

function applyEOL (lfContent, eol) {
  const lf = toLF(lfContent)
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

function findActualString (fileContent, searchString) {
  if (fileContent.includes(searchString)) return searchString
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }
  return null
}

function isOpeningContext (chars, index) {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ||
    prev === '(' || prev === '[' || prev === '{' ||
    prev === '\u2014' || prev === '\u2013'
  )
}

function applyCurlyDoubleQuotes (str) {
  const chars = Array.from(str)
  const result = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE)
    } else result.push(chars[i])
  }
  return result.join('')
}

function applyCurlySingleQuotes (str) {
  const chars = Array.from(str)
  const result = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /[A-Za-z\u00C0-\u024F]/.test(prev)
      const nextIsLetter = next !== undefined && /[A-Za-z\u00C0-\u024F]/.test(next)
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE)
      }
    } else result.push(chars[i])
  }
  return result.join('')
}

function preserveQuoteStyle (oldString, actualOldString, newString) {
  if (oldString === actualOldString) return newString
  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  if (!hasDouble && !hasSingle) return newString
  let result = newString
  if (hasDouble) result = applyCurlyDoubleQuotes(result)
  if (hasSingle) result = applyCurlySingleQuotes(result)
  return result
}

function desanitizeMatchString (matchString) {
  let result = matchString
  const appliedReplacements = []
  for (const from of Object.keys(DESANITIZATIONS)) {
    const to = DESANITIZATIONS[from]
    const before = result
    result = result.split(from).join(to)
    if (before !== result) appliedReplacements.push({ from, to })
  }
  return { result, appliedReplacements }
}

function applyEditToFile (originalContent, oldString, newString, replaceAll) {
  // 一律用 split/join：避免 String.replace 把 newString 里的 $& / $1 当特殊替换符
  const replaceFirst = function (content, search, replace) {
    const idx = content.indexOf(search)
    if (idx < 0) return content
    return content.slice(0, idx) + replace + content.slice(idx + search.length)
  }
  const f = replaceAll
    ? function (content, search, replace) { return content.split(search).join(replace) }
    : replaceFirst

  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }
  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')
  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

function normalizeOneEdit (fileContentLF, filePath, old_string, new_string, replace_all) {
  const isMarkdown = /\.(md|mdx)$/i.test(filePath || '')
  let oldStr = String(old_string == null ? '' : old_string)
  let newStr = String(new_string == null ? '' : new_string)
  if (!isMarkdown) newStr = stripTrailingWhitespace(newStr)

  if (oldStr === '' || fileContentLF.includes(oldStr)) {
    return { old_string: oldStr, new_string: newStr, replace_all: !!replace_all }
  }

  const d = desanitizeMatchString(oldStr)
  if (fileContentLF.includes(d.result)) {
    let desanitizedNew = newStr
    for (let i = 0; i < d.appliedReplacements.length; i++) {
      const r = d.appliedReplacements[i]
      desanitizedNew = desanitizedNew.split(r.from).join(r.to)
    }
    return { old_string: d.result, new_string: desanitizedNew, replace_all: !!replace_all }
  }

  return { old_string: oldStr, new_string: newStr, replace_all: !!replace_all }
}

function applyOneEditLF (fileContentLF, edit) {
  let old_string = String(edit.old_string == null ? '' : edit.old_string)
  let new_string = String(edit.new_string == null ? '' : edit.new_string)
  const replace_all = !!edit.replace_all

  if (old_string === new_string) {
    return { ok: false, message: 'old_string 与 new_string 相同，拒绝无操作编辑。' }
  }

  if (old_string === '') {
    if (fileContentLF.length > 0) {
      return { ok: false, message: 'old_string 为空仅可用于空文件；该文件已有内容，请提供精确 old_string。' }
    }
    return { ok: true, content: new_string, count: 1, actualOld: '', actualNew: new_string }
  }

  const actualOld = findActualString(fileContentLF, old_string)
  if (!actualOld) {
    const hint = suggestNearby(fileContentLF, old_string)
    return {
      ok: false,
      message: 'old_string 未在文件中找到。请重新 read_file，从文件原样复制（勿含行号前缀 N|），或提供更长上下文。\nString: ' + old_string.slice(0, 200) + (hint ? '\n\n【附近可能相关行】\n' + hint : '')
    }
  }

  const actualNew = preserveQuoteStyle(old_string, actualOld, new_string)
  const matches = fileContentLF.split(actualOld).length - 1
  if (matches > 1 && !replace_all) {
    return {
      ok: false,
      message: '找到 ' + matches + ' 处匹配，但 replace_all=false。请扩大上下文使唯一，或设 replace_all=true。\nString: ' + old_string.slice(0, 200)
    }
  }

  const next = applyEditToFile(fileContentLF, actualOld, actualNew, replace_all)
  if (next === fileContentLF) {
    return { ok: false, message: '编辑未改变文件内容（匹配失败或替换为空操作）。' }
  }
  return { ok: true, content: next, count: replace_all ? matches : 1, actualOld: actualOld, actualNew: actualNew }
}

function applyEditsLF (fileContentLF, filePath, edits) {
  let content = fileContentLF
  const appliedNewStrings = []
  const results = []

  for (let i = 0; i < edits.length; i++) {
    const raw = edits[i] || {}
    const normalized = normalizeOneEdit(content, filePath, raw.old_string, raw.new_string, raw.replace_all)
    const oldCheck = String(normalized.old_string || '').replace(/\n+$/, '')
    for (let j = 0; j < appliedNewStrings.length; j++) {
      const prevNew = appliedNewStrings[j]
      if (oldCheck && prevNew.indexOf(oldCheck) !== -1) {
        return {
          ok: false,
          message: '第 ' + (i + 1) + ' 处编辑失败：old_string 是先前 new_string 的子串，请拆成独立调用或调整顺序。'
        }
      }
    }
    const r = applyOneEditLF(content, normalized)
    if (!r.ok) {
      return { ok: false, message: '第 ' + (i + 1) + ' 处编辑失败：' + r.message }
    }
    content = r.content
    if (normalized.new_string) appliedNewStrings.push(normalized.new_string)
    results.push(r)
  }
  let count = 0
  for (let i = 0; i < results.length; i++) count += results[i].count || 0
  return { ok: true, content: content, results: results, count: count }
}

function assertReadableForWrite (runtime, absPath, diskContentLF) {
  if (!runtime || !runtime.readFileState) {
    return { ok: false, message: 'File has not been read yet. Read it first before writing to it.（请先 read_file）' }
  }
  const key = path.resolve(absPath)
  const st = runtime.readFileState.get(key)
  if (!st) {
    return {
      ok: false,
      message: 'File has not been read yet. Read it first before writing to it.（请先对该路径调用 read_file）'
    }
  }
  if (st.isPartialView) {
    return {
      ok: false,
      message: '此前只读取了文件的部分内容（offset/limit）。请先对该文件做完整 read_file 再编辑。'
    }
  }
  try {
    if (!fs.existsSync(key)) return { ok: true, state: st }
    const mtimeMs = fs.statSync(key).mtimeMs
    if (mtimeMs > (st.timestamp || 0)) {
      const cachedLF = toLF(st.content || '')
      if (cachedLF !== diskContentLF) {
        return {
          ok: false,
          message: 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'
        }
      }
    }
  } catch (e) { /* ignore */ }
  return { ok: true, state: st }
}

const READ_FILE_STATE_MAX = parseInt(process.env.PANDA_READ_STATE_MAX, 10) || 80

function trimReadFileState (runtime) {
  if (!runtime || !runtime.readFileState || runtime.readFileState.size <= READ_FILE_STATE_MAX) return
  const keys = [...runtime.readFileState.keys()]
  const drop = keys.length - READ_FILE_STATE_MAX
  for (let i = 0; i < drop; i++) runtime.readFileState.delete(keys[i])
}

function rememberRead (runtime, absPath, content, opts) {
  if (!runtime) return
  if (!runtime.readFileState) runtime.readFileState = new Map()
  const key = path.resolve(absPath)
  let mtimeMs = Date.now()
  try { mtimeMs = fs.statSync(key).mtimeMs } catch (e) { /* new */ }
  const offset = opts && opts.offset
  const limit = opts && opts.limit
  const isPartialView = !!(offset != null || limit != null)
  runtime.readFileState.set(key, {
    content: String(content || ''),
    timestamp: mtimeMs,
    offset: offset != null ? offset : undefined,
    limit: limit != null ? limit : undefined,
    isPartialView: isPartialView
  })
  trimReadFileState(runtime)
}

function rememberWrite (runtime, absPath, content) {
  if (!runtime) return
  if (!runtime.readFileState) runtime.readFileState = new Map()
  const key = path.resolve(absPath)
  let mtimeMs = Date.now()
  try { mtimeMs = fs.statSync(key).mtimeMs } catch (e) { /* */ }
  runtime.readFileState.set(key, {
    content: String(content || ''),
    timestamp: mtimeMs,
    offset: undefined,
    limit: undefined,
    isPartialView: false
  })
  trimReadFileState(runtime)
}

function findSimilarFile (projectRoot, relPath) {
  const base = path.basename(relPath || '')
  if (!base) return []
  const hits = []
  function walk (dir, depth) {
    if (depth > 6 || hits.length >= 5) return
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (let i = 0; i < ents.length; i++) {
      const ent = ents[i]
      if (hits.length >= 5) return
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'panda-code') continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, depth + 1)
      else if (ent.isFile() && ent.name === base) {
        hits.push(path.relative(projectRoot, abs).split(path.sep).join('/'))
      }
    }
  }
  walk(projectRoot, 0)
  return hits.filter(function (h) { return h !== relPath })
}

/**
 * 去掉 read_file 行号前缀（N|）。
 * 可叠多层（落盘后再 Read 会变成 1|1|1|…），逐行剥离直到不再以「数字|」开头。
 */
function stripLineNumberPrefix (text) {
  return String(text || '')
    .split('\n')
    .map(function (line) {
      let l = line
      for (let i = 0; i < 64; i++) {
        if (!/^\s*\d+\|/.test(l)) break
        l = l.replace(/^\s*\d+\|/, '')
      }
      return l
    })
    .join('\n')
}

/** 编辑失败时给出附近相似行，帮助模型纠正 old_string */
function suggestNearby (fileContentLF, oldString) {
  const needle = String(oldString || '').split('\n').map(l => l.trim()).filter(Boolean)[0] || ''
  if (!needle || needle.length < 4) return ''
  const lines = String(fileContentLF || '').split('\n')
  const hits = []
  const lower = needle.toLowerCase().slice(0, 60)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lower.slice(0, Math.min(40, lower.length)))) {
      const from = Math.max(0, i - 1)
      const to = Math.min(lines.length, i + 2)
      for (let j = from; j < to; j++) {
        hits.push((j + 1) + '|' + lines[j])
      }
      hits.push('---')
      if (hits.length > 40) break
    }
  }
  return hits.slice(0, 40).join('\n')
}

module.exports = {
  normalizeQuotes,
  stripTrailingWhitespace,
  toLF,
  detectEOL,
  applyEOL,
  findActualString,
  preserveQuoteStyle,
  applyEditToFile,
  normalizeOneEdit,
  applyOneEditLF,
  applyEditsLF,
  assertReadableForWrite,
  rememberRead,
  rememberWrite,
  findSimilarFile,
  stripLineNumberPrefix,
  suggestNearby,
  DESANITIZATIONS
}
