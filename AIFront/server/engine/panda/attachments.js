/**
 * 回合附件（对齐 panda-code/utils/attachments.ts + messages.ts normalizeAttachmentForAPI）
 * 原则：软提示（may or may not be related），不做意图分类、不把 activeFile 全文塞进 system
 */

const path = require('path')
const fs = require('fs')

const MAX_AT_FILE_CHARS = 48000
const MAX_SELECTION_CHARS = 2000

function resolveProjectFile (projectRoot, relOrAbs) {
  if (!relOrAbs) return null
  const abs = path.isAbsolute(relOrAbs)
    ? relOrAbs
    : path.resolve(projectRoot, relOrAbs)
  const root = path.resolve(projectRoot)
  if (!abs.startsWith(root + path.sep) && abs !== root) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return abs
}

function toRel (projectRoot, abs) {
  return path.relative(projectRoot, abs).split(path.sep).join('/')
}

/**
 * 提取 @path 提及（简化版 extractAtMentionedFiles）
 * 支持：@src/foo.vue  @"path with spaces"  @./bar.js
 */
function extractAtMentionedFiles (input) {
  const text = String(input || '')
  const found = []
  const re = /@(?:"([^"]+)"|([A-Za-z0-9_./\\-]+(?:\.[A-Za-z0-9]+)?))/g
  let m
  while ((m = re.exec(text))) {
    const p = (m[1] || m[2] || '').trim()
    if (!p || p.length < 2) continue
    if (/^(agent-|https?:)/i.test(p)) continue
    found.push(p)
  }
  return [...new Set(found)]
}

function readFileSafe (abs, maxChars) {
  try {
    let raw = fs.readFileSync(abs, 'utf8')
    if (raw.length > maxChars) {
      raw = raw.slice(0, maxChars) + '\n…[截断]'
    }
    return raw
  } catch (e) {
    return null
  }
}

/**
 * 收集本轮附件（对标 getAttachments 中与意图相关的部分）
 * @param {string} userInput
 * @param {object} context
 * @param {string} projectRoot
 */
function collectTurnAttachments (userInput, context, projectRoot) {
  const out = []
  const ctx = context || {}

  // @ 提及：读入文件内容（对标 processAtMentionedFiles → file attachment）
  for (const mention of extractAtMentionedFiles(userInput)) {
    const abs = resolveProjectFile(projectRoot, mention)
    if (!abs) {
      out.push({ type: 'at_mention_missing', path: mention })
      continue
    }
    const content = readFileSafe(abs, MAX_AT_FILE_CHARS)
    if (content == null) continue
    out.push({
      type: 'at_mentioned_file',
      path: toRel(projectRoot, abs),
      content
    })
  }

  // IDE 选区（若前端传来）
  const sel = ctx.ideSelection || ctx.selection
  if (sel && sel.text && sel.path) {
    let text = String(sel.text)
    if (text.length > MAX_SELECTION_CHARS) text = text.slice(0, MAX_SELECTION_CHARS) + '\n…'
    out.push({
      type: 'selected_lines_in_ide',
      path: sel.path,
      lineStart: sel.lineStart || sel.startLine || 1,
      lineEnd: sel.lineEnd || sel.endLine || 1,
      text
    })
  }

  // IDE 打开文件：仅路径软提示（对标 opened_file_in_ide）——有选区则跳过
  const openFile = ctx.activeFile || ctx.preferredFile || ctx.openedFile || ''
  if (openFile && !(sel && sel.text && sel.path)) {
    out.push({
      type: 'opened_file_in_ide',
      path: String(openFile)
    })
  }

  return out
}

/**
 * 附件 → 注入模型的 user meta 消息文本（对标 normalizeAttachmentForAPI）
 */
function formatAttachmentMessages (attachments) {
  const messages = []
  for (const a of attachments || []) {
    if (!a || !a.type) continue
    if (a.type === 'opened_file_in_ide') {
      messages.push({
        role: 'user',
        content: 'The user opened the file ' + a.path +
          ' in the IDE. This may or may not be related to the current task.',
        _attachment: true
      })
    } else if (a.type === 'selected_lines_in_ide') {
      messages.push({
        role: 'user',
        content: 'The user selected the lines ' + a.lineStart + ' to ' + a.lineEnd +
          ' from ' + a.path + ':\n' + a.text +
          '\n\nThis may or may not be related to the current task.',
        _attachment: true
      })
    } else if (a.type === 'at_mentioned_file') {
      messages.push({
        role: 'user',
        content: 'Attached file from @ mention: ' + a.path + '\n```\n' + a.content + '\n```',
        _attachment: true
      })
    } else if (a.type === 'at_mention_missing') {
      messages.push({
        role: 'user',
        content: 'Note: @' + a.path + ' was mentioned but the file was not found in the project.',
        _attachment: true
      })
    } else if (a.type === 'edited_text_file') {
      messages.push({
        role: 'user',
        content: [
          'Note: ' + a.path + ' was modified since last read (disk mtime ahead of readFileState).',
          'This may or may not be related to the current task. Diff snippet:',
          '```',
          String(a.snippet || '').slice(0, 4000),
          '```',
          'Re-read before editing.'
        ].join('\n'),
        _attachment: true
      })
    } else if (a.type === 'soft_candidate_paths') {
      messages.push({
        role: 'user',
        content: [
          'Soft candidate paths (from IDE open + recent git dirty files). May or may not be related — do NOT treat as confirmed edit targets until read_file.',
          a.paths.map(p => '- ' + p).join('\n')
        ].join('\n'),
        _attachment: true
      })
    } else if (a.type === 'diagnostics' && a.text) {
      messages.push({
        role: 'user',
        content: a.text,
        _attachment: true
      })
    }
  }
  return messages
}

/**
 * 软候选路径（对标「意图锁定」的真实做法：软注入，非 IntentRouter）
 * 实体来自：IDE 打开文件 + git porcelain 脏文件；不硬拒、不伪造 read。
 */
function collectSoftCandidatePaths (context, projectRoot, max = 12) {
  const paths = []
  const push = (p) => {
    const s = String(p || '').trim().replace(/\\/g, '/')
    if (!s || paths.indexOf(s) !== -1) return
    paths.push(s)
  }
  const ctx = context || {}
  push(ctx.activeFile || ctx.preferredFile || ctx.openedFile)
  try {
    const { execSync } = require('child_process')
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2500
    })
    for (const line of String(status || '').split('\n')) {
      if (!line.trim()) continue
      // XY PATH or XY ORIG -> PATH
      let p = line.slice(3).trim()
      if (p.includes(' -> ')) p = p.split(' -> ').pop()
      push(p)
      if (paths.length >= max) break
    }
  } catch (e) { /* ignore */ }
  if (!paths.length) return []
  return [{ type: 'soft_candidate_paths', paths: paths.slice(0, max) }]
}

/**
 * readFileState 中磁盘已变的文件（对标 attachments.getChangedFiles）
 * 注入 diff snippet；更新 cache timestamp，避免每轮刷屏。
 */
function getChangedFileAttachments (runtime, projectRoot, max = 6) {
  if (!runtime || !runtime.readFileState || typeof runtime.readFileState.entries !== 'function') {
    return []
  }
  const out = []
  for (const [abs, st] of runtime.readFileState.entries()) {
    if (!st || st.isPartialView || st.offset != null || st.limit != null) continue
    try {
      if (!fs.existsSync(abs)) continue
      const mtime = fs.statSync(abs).mtimeMs
      if (mtime <= (st.timestamp || 0)) continue
      const disk = fs.readFileSync(abs, 'utf8')
      const old = String(st.content || '')
      if (disk === old) {
        st.timestamp = mtime
        continue
      }
      const snippet = makeSimpleDiffSnippet(old, disk)
      if (!snippet) {
        st.content = disk
        st.timestamp = mtime
        continue
      }
      out.push({
        type: 'edited_text_file',
        path: toRel(projectRoot, abs),
        snippet
      })
      st.content = disk
      st.timestamp = mtime
      if (out.length >= max) break
    } catch (e) { /* ignore */ }
  }
  return out
}

function makeSimpleDiffSnippet (oldText, newText, maxLines = 40) {
  const a = String(oldText || '').split('\n')
  const b = String(newText || '').split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let ja = a.length - 1
  let jb = b.length - 1
  while (ja > i && jb > i && a[ja] === b[jb]) { ja--; jb-- }
  const lines = []
  for (let k = i; k <= ja && lines.length < maxLines; k++) lines.push('- ' + a[k])
  for (let k = i; k <= jb && lines.length < maxLines; k++) lines.push('+ ' + b[k])
  return lines.join('\n')
}

/**
 * 轻量 git 状态（对标 context.ts getGitStatus → systemContext）
 */
function getGitStatusSnippet (projectRoot, maxChars = 2000) {
  try {
    const { execSync } = require('child_process')
    const opts = { cwd: projectRoot, encoding: 'utf8', timeout: 2500 }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim()
    let mainBranch = ''
    try {
      mainBranch = execSync('git rev-parse --abbrev-ref origin/HEAD', opts).trim().replace(/^origin\//, '')
    } catch (e) {
      mainBranch = 'main'
    }
    let userName = ''
    try { userName = execSync('git config user.name', opts).trim() } catch (e) { /* */ }
    const status = execSync('git status -sb --porcelain', opts).trim()
    const log = execSync('git log -5 --oneline', opts).trim()
    let body = [
      '# Git status',
      'This is the git status at the start of the conversation. It may or may not be relevant.',
      'Current branch: ' + branch,
      'Main branch (usually): ' + mainBranch,
      userName ? 'git user.name: ' + userName : '',
      '',
      'Status:',
      status || '(clean)',
      '',
      'Recent commits:',
      log || '(none)'
    ].filter(Boolean).join('\n')
    if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…'
    return body
  } catch (e) {
    return ''
  }
}

module.exports = {
  extractAtMentionedFiles,
  collectTurnAttachments,
  collectSoftCandidatePaths,
  getChangedFileAttachments,
  formatAttachmentMessages,
  getGitStatusSnippet
}
