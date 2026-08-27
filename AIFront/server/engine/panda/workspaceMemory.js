/**
 * 工作区级长期记忆汇总（对标 Cursor Memories + 跨会话 chat 摘要）
 * - 每次 Agent 启动注入：MEMORY 索引 + topics 摘要 + 全部历史会话要点
 * - 超过阈值后压缩（默认与 chomircode context 配置同量级：inject 6k / compress 12k chars）
 * - 压缩结果缓存到 .panda/memory/topics/workspace-chats.md
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULT_INJECT_MAX = parseInt(process.env.PANDA_WORKSPACE_MEMORY_MAX, 10) || 6000
const DEFAULT_COMPRESS_THRESHOLD = parseInt(process.env.PANDA_WORKSPACE_MEMORY_COMPRESS, 10) || 12000
const ROLLUP_TOPIC_ID = 'workspace-chats'
const CACHE_FILE = 'workspace-memory-cache.md'

function pandaRoot (projectRoot) {
  return path.resolve(projectRoot, '.panda')
}

function chatHistoryDir (projectRoot) {
  return path.join(pandaRoot(projectRoot), 'chat-history')
}

function sessionMemoryPath (projectRoot, sessionId) {
  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  const modern = path.join(pandaRoot(projectRoot), 'sessions', sid, 'session-memory', 'summary.md')
  const legacy = path.join(pandaRoot(projectRoot), 'sessions', sid, 'memory.md')
  return { modern, legacy }
}

async function readConfigLimits (projectRoot) {
  let injectMax = DEFAULT_INJECT_MAX
  let compressThreshold = DEFAULT_COMPRESS_THRESHOLD
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(pandaRoot(projectRoot), 'config.json'), 'utf8'))
    if (cfg.workspaceMemoryMaxChars > 0) injectMax = cfg.workspaceMemoryMaxChars
    if (cfg.workspaceMemoryCompressThreshold > 0) compressThreshold = cfg.workspaceMemoryCompressThreshold
  } catch (e) { /* defaults */ }
  return { injectMax, compressThreshold }
}

function extractSection (text, header) {
  const re = new RegExp('(# ' + header + '[\\s\\S]*?)(?=\\n# |$)', 'i')
  const m = String(text || '').match(re)
  if (!m) return ''
  return m[1]
    .replace(/^# .+\n/i, '')
    .replace(/^_[^\n]+_\n/gm, '')
    .trim()
    .slice(0, 800)
}

async function readSessionSnippet (projectRoot, sessionId) {
  const snippets = []
  const memPaths = sessionMemoryPath(projectRoot, sessionId)
  for (const p of [memPaths.modern, memPaths.legacy]) {
    try {
      const text = await fsp.readFile(p, 'utf8')
      const state = extractSection(text, 'Current State')
      const task = extractSection(text, 'Task specification')
      const learnings = extractSection(text, 'Learnings')
      if (state) snippets.push('state: ' + state)
      if (task && task !== state) snippets.push('task: ' + task)
      if (learnings) snippets.push('learn: ' + learnings.slice(0, 400))
      if (snippets.length) break
    } catch (e) { /* try next */ }
  }

  const jsonl = path.join(pandaRoot(projectRoot), 'sessions', sessionId + '.jsonl')
  try {
    const lines = (await fsp.readFile(jsonl, 'utf8')).trim().split(/\n/).filter(Boolean).slice(-8)
    const turns = []
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        const role = String(e.role || e.type || '').toLowerCase()
        const content = String(e.content || e.text || '').trim()
        if (!content || role === 'system') continue
        if (role === 'user' || role === 'human') turns.push('U: ' + content.slice(0, 280))
        else if (role === 'assistant' || role === 'ai') turns.push('A: ' + content.slice(0, 280))
      } catch (e2) { /* skip */ }
    }
    if (turns.length) snippets.push('recent: ' + turns.slice(-4).join(' | '))
  } catch (e) { /* no jsonl */ }

  const md = path.join(chatHistoryDir(projectRoot), sessionId + '.md')
  try {
    const text = await fsp.readFile(md, 'utf8')
    const blocks = text.split(/\n### /).filter(Boolean).slice(-2)
    for (const block of blocks) {
      const m = /^(user|assistant)\s*·[^\n]*\n([\s\S]*)$/i.exec(block.trim())
      if (m) snippets.push(m[1][0].toUpperCase() + ': ' + m[2].trim().slice(0, 240))
    }
  } catch (e) { /* no md */ }

  return snippets.join('\n').slice(0, 1200)
}

async function collectTopicSummaries (projectRoot, perTopicMax) {
  const memoryIndex = require('./memoryIndex')
  await memoryIndex.migrateIfNeeded(projectRoot)
  const topics = await memoryIndex.listTopicFiles(projectRoot)
  const lines = []
  for (const t of topics) {
    if (t.id === ROLLUP_TOPIC_ID) continue
    let body = ''
    try {
      body = await fsp.readFile(memoryIndex.topicPath(projectRoot, t.id), 'utf8')
    } catch (e) { continue }
    const excerpt = body
      .replace(/^# .+\n/m, '')
      .trim()
      .slice(0, perTopicMax)
    if (!excerpt) continue
    lines.push('- **' + t.id + '** (' + (t.mtime || '') + '): ' + excerpt.replace(/\n+/g, ' '))
  }
  return lines
}

async function collectSessionSummaries (projectRoot, excludeSessionId) {
  const session = require('./session')
  const list = await session.listSessions(projectRoot)
  const out = []
  for (const s of list) {
    const id = String(s.id || '')
    if (!id || id === excludeSessionId) continue
    const title = String(s.title || s.lastMessage || id).trim().slice(0, 120)
    const last = String(s.lastMessage || '').trim().slice(0, 200)
    const updated = String(s.updatedAt || s.createdAt || '').slice(0, 10)
    const snippet = await readSessionSnippet(projectRoot, id)
    out.push({
      id,
      updated,
      title,
      last,
      snippet,
      block: [
        '### ' + title + ' (`' + id + '`, ' + updated + ')',
        last ? '> ' + last : '',
        snippet ? snippet : '(no transcript summary)'
      ].filter(Boolean).join('\n')
    })
  }
  return out
}

function compressRollup (sections, targetMax) {
  const header = sections.header || ''
  const topics = sections.topics || ''
  const sessions = sections.sessions || []
  let body = [header, topics, '## Past chats (all sessions)', ''].concat(sessions.map(s => s.block)).join('\n')

  if (body.length <= targetMax) {
    return { text: body, compressed: false, originalChars: body.length, finalChars: body.length }
  }

  // Pass 1: one-liner older sessions, keep last 8 detailed
  const detailed = sessions.slice(0, 8)
  const older = sessions.slice(8)
  const olderLines = older.map(s => '- `' + s.id + '` (' + s.updated + ') ' + (s.title || s.last).slice(0, 100))
  body = [
    header,
    topics,
    '## Past chats (all sessions)',
    '',
    ...detailed.map(s => s.block),
    older.length ? '\n## Older sessions (compressed)\n' + olderLines.join('\n') : ''
  ].join('\n')

  if (body.length <= targetMax) {
    return { text: body, compressed: true, originalChars: sections.rawChars, finalChars: body.length }
  }

  // Pass 2: trim topic excerpts
  const shortTopics = String(topics).split('\n').map(l => l.slice(0, 180)).join('\n')
  body = [
    header,
    shortTopics,
    '## Past chats (recent only)',
    '',
    ...detailed.slice(0, 5).map(s => s.block)
  ].join('\n')

  if (body.length <= targetMax) {
    return { text: body, compressed: true, originalChars: sections.rawChars, finalChars: body.length }
  }

  // Pass 3: hard truncate with marker
  body = body.slice(0, targetMax - 80) + '\n\n…[workspace memory truncated — use memory_read(topic) for details]…'
  return { text: body, compressed: true, originalChars: sections.rawChars, finalChars: body.length }
}

async function persistRollupCache (projectRoot, text) {
  const memoryIndex = require('./memoryIndex')
  const p = memoryIndex.topicPath(projectRoot, ROLLUP_TOPIC_ID)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const stamp = new Date().toISOString()
  await fsp.writeFile(p, [
    '# workspace-chats',
    '',
    '_Auto-maintained rollup of all past chat sessions. Refreshed ' + stamp + '._',
    '',
    text
  ].join('\n'), 'utf8')
  const cachePath = path.join(pandaRoot(projectRoot), 'memory', CACHE_FILE)
  await fsp.writeFile(cachePath, text, 'utf8')
  try {
    await memoryIndex.writeIndex(projectRoot, [])
  } catch (e) { /* ignore */ }
}

/**
 * @param {string} projectRoot
 * @param {{ excludeSessionId?: string, injectMax?: number, compressThreshold?: number }} opts
 */
async function buildWorkspaceMemorySection (projectRoot, opts = {}) {
  if (!projectRoot) return { section: '', compressed: false, stats: {} }

  const limits = await readConfigLimits(projectRoot)
  const injectMax = opts.injectMax || limits.injectMax
  const compressThreshold = opts.compressThreshold || limits.compressThreshold
  const excludeSessionId = opts.excludeSessionId || ''

  const memoryIndex = require('./memoryIndex')
  await memoryIndex.migrateIfNeeded(projectRoot)

  let indexText = ''
  try {
    indexText = await fsp.readFile(memoryIndex.indexPath(projectRoot), 'utf8')
  } catch (e) {
    indexText = await memoryIndex.writeIndex(projectRoot, [])
  }

  const topicLines = await collectTopicSummaries(projectRoot, 500)
  const sessionBlocks = await collectSessionSummaries(projectRoot, excludeSessionId)

  const header = [
    '【工作区长期记忆 · 自动注入】',
    '以下包含 MEMORY 索引、各 topic 摘要、以及**全部历史 Chat 会话**要点。新 Chat 也会带上；超过约 ' + compressThreshold + ' 字符会压缩到 ~' + injectMax + '（对标 Cursor Memories 体量）。',
    '',
    '### MEMORY 索引',
    indexText.trim().slice(0, 2200),
    '',
    topicLines.length ? '### Topic 摘要\n' + topicLines.join('\n') : ''
  ].filter(Boolean).join('\n')

  const rawSessions = sessionBlocks.map(s => s.block).join('\n\n')
  const rawChars = header.length + rawSessions.length

  let section = ''
  let compressed = false

  if (rawChars <= injectMax) {
    section = [header, '### Past chats (all sessions)', '', rawSessions].filter(Boolean).join('\n\n')
  } else if (rawChars <= compressThreshold) {
    section = [header, '### Past chats (all sessions)', '', rawSessions].filter(Boolean).join('\n\n')
    section = section.slice(0, injectMax - 60) + '\n…[trimmed to workspace memory budget]…'
    compressed = true
  } else {
    const result = compressRollup({
      header,
      topics: topicLines.length ? '### Topic 摘要\n' + topicLines.join('\n') : '',
      sessions: sessionBlocks,
      rawChars
    }, injectMax)
    section = result.text
    compressed = result.compressed
    if (compressed) {
      await persistRollupCache(projectRoot, section)
    }
  }

  return {
    section,
    compressed,
    stats: {
      sessions: sessionBlocks.length,
      topics: topicLines.length,
      injectMax,
      compressThreshold,
      chars: section.length
    }
  }
}

async function readCachedSection (projectRoot) {
  const cachePath = path.join(pandaRoot(projectRoot), 'memory', CACHE_FILE)
  try {
    const text = await fsp.readFile(cachePath, 'utf8')
    if (text && text.trim()) return text.trim()
  } catch (e) { /* rebuild */ }
  const built = await buildWorkspaceMemorySection(projectRoot, {})
  return built.section
}

module.exports = {
  buildWorkspaceMemorySection,
  readCachedSection,
  compressRollup,
  persistRollupCache,
  DEFAULT_INJECT_MAX,
  DEFAULT_COMPRESS_THRESHOLD
}
