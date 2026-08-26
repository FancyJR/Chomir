/**
 * 轻量 autoDream：空闲时整合记忆
 * - 将 auto.md 去重并入 topics/auto.md
 * - 重建 MEMORY.md 短索引
 * - 可选压缩过长 topic
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function memoryRoot (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'memory')
}

function indexPath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'MEMORY.md')
}

function topicPath (projectRoot, id) {
  const safe = String(id || 'general').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  return path.join(memoryRoot(projectRoot), 'topics', safe + '.md')
}

async function listTopicFiles (projectRoot) {
  const dir = path.join(memoryRoot(projectRoot), 'topics')
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.replace(/\.md$/, '')
    const full = path.join(dir, name)
    let summary = ''
    let mtime = ''
    try {
      const st = await fsp.stat(full)
      mtime = st.mtime.toISOString().slice(0, 10)
      const text = await fsp.readFile(full, 'utf8')
      const line = text.split(/\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
      summary = (line || '').replace(/^[-*]\s*/, '').slice(0, 80)
    } catch (e) { /* ignore */ }
    out.push({ id, summary, mtime, path: '.panda/memory/topics/' + name })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function buildIndexMarkdown (projectRoot, pins) {
  const topics = await listTopicFiles(projectRoot)
  const lines = [
    '# Panda Memory Index',
    '',
    '> 这是**目录**，不是全文。详情在 `.panda/memory/topics/<topic>.md`。',
    '> 用工具 `memory_read` 传 `topic` 拉取；`memory_append` 可指定 `topic`。',
    ''
  ]
  if (pins && pins.length) {
    lines.push('## Pins', '')
    pins.forEach(p => lines.push('- ' + p))
    lines.push('')
  }
  lines.push('## Topics', '', '| topic | summary | updated |', '|-------|---------|---------|')
  if (!topics.length) {
    lines.push('| _(empty)_ | 尚无主题文件 | — |')
  } else {
    for (const t of topics) {
      lines.push('| `' + t.id + '` | ' + (t.summary || '—').replace(/\|/g, '/') + ' | ' + t.mtime + ' |')
    }
  }
  lines.push('')
  return lines.join('\n')
}

async function writeIndex (projectRoot, pins) {
  await fsp.mkdir(path.join(memoryRoot(projectRoot), 'topics'), { recursive: true })
  const md = await buildIndexMarkdown(projectRoot, pins)
  await fsp.writeFile(indexPath(projectRoot), md, 'utf8')
  return md
}

function extractPinsFromLegacy (text) {
  const pins = []
  const lines = String(text || '').split(/\n/)
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)/)
    if (m) pins.push(m[1].trim().slice(0, 120))
    if (pins.length >= 8) break
  }
  return pins
}

/**
 * 若 MEMORY.md 仍是旧式长文，迁到 topics/general.md 并建索引
 */
async function migrateIfNeeded (projectRoot) {
  await fsp.mkdir(path.join(memoryRoot(projectRoot), 'topics'), { recursive: true })
  const idx = indexPath(projectRoot)
  let raw = ''
  try {
    raw = await fsp.readFile(idx, 'utf8')
  } catch (e) {
    await writeIndex(projectRoot, [])
    return { migrated: false }
  }
  const isIndex = /Panda Memory Index|# Memory Index/i.test(raw) ||
    /\|\s*topic\s*\|/i.test(raw)
  if (isIndex) return { migrated: false }

  const pins = extractPinsFromLegacy(raw)
  const general = topicPath(projectRoot, 'general')
  if (!fs.existsSync(general) && raw.trim()) {
    await fsp.writeFile(
      general,
      '# general\n\n' + raw.trim() + '\n',
      'utf8'
    )
  }
  await writeIndex(projectRoot, pins)
  return { migrated: true, pins: pins.length }
}

async function appendTopic (projectRoot, topicId, note) {
  await migrateIfNeeded(projectRoot)
  const id = String(topicId || 'general').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'general'
  const full = topicPath(projectRoot, id)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  let prev = ''
  try {
    prev = await fsp.readFile(full, 'utf8')
  } catch (e) {
    prev = '# ' + id + '\n\n'
  }
  const line = '- [' + new Date().toISOString() + '] ' + String(note || '').trim() + '\n'
  await fsp.writeFile(full, prev.trimEnd() + '\n' + line, 'utf8')
  // 刷新索引（保留原 pins）
  let pins = []
  try {
    const idx = await fsp.readFile(indexPath(projectRoot), 'utf8')
    const m = idx.match(/## Pins\n\n([\s\S]*?)(?:\n## |\n$)/)
    if (m) {
      pins = m[1].split(/\n/).map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
    }
  } catch (e) { /* ignore */ }
  await writeIndex(projectRoot, pins)
  return id
}

async function readTopic (projectRoot, topicId) {
  await migrateIfNeeded(projectRoot)
  if (!topicId || topicId === 'index' || topicId === 'MEMORY') {
    try {
      return { ok: true, topic: 'index', content: await fsp.readFile(indexPath(projectRoot), 'utf8') }
    } catch (e) {
      return { ok: true, topic: 'index', content: '(无索引)' }
    }
  }
  const full = topicPath(projectRoot, topicId)
  try {
    const content = await fsp.readFile(full, 'utf8')
    return { ok: true, topic: topicId, content }
  } catch (e) {
    const topics = await listTopicFiles(projectRoot)
    return {
      ok: false,
      topic: topicId,
      content: '主题不存在：' + topicId + '\n可用：' + (topics.map(t => t.id).join(', ') || '(无)')
    }
  }
}

/**
 * 空闲整合
 */
async function runAutoDream (projectRoot, opts = {}) {
  await migrateIfNeeded(projectRoot)
  const notes = []
  const autoFile = path.join(memoryRoot(projectRoot), 'auto.md')
  let auto = ''
  try {
    auto = await fsp.readFile(autoFile, 'utf8')
  } catch (e) {
    auto = ''
  }

  if (auto.trim()) {
    const bullets = auto.split(/\n/)
      .map(l => l.trim())
      .filter(l => l.startsWith('-'))
    const topicFile = topicPath(projectRoot, 'auto')
    let existing = ''
    try {
      existing = await fsp.readFile(topicFile, 'utf8')
    } catch (e) {
      existing = '# auto\n\n'
    }
    let added = 0
    for (const b of bullets) {
      const key = b.replace(/^-\s*(\([^)]*\)\s*)?/, '').slice(0, 60)
      if (key && !existing.includes(key)) {
        existing = existing.trimEnd() + '\n' + b + '\n'
        added++
      }
    }
    if (added) {
      await fsp.writeFile(topicFile, existing, 'utf8')
      notes.push('merged auto.md → topics/auto.md (+' + added + ')')
    }
    // 清空已合并的 auto 缓冲（保留标题）
    await fsp.writeFile(autoFile, '# Auto Memory buffer\n\n（已由 autoDream 并入 topics/auto.md）\n', 'utf8')
  }

  // 截断过长 topic
  const topics = await listTopicFiles(projectRoot)
  const maxChars = opts.maxTopicChars || 12000
  for (const t of topics) {
    const full = topicPath(projectRoot, t.id)
    try {
      let text = await fsp.readFile(full, 'utf8')
      if (text.length > maxChars) {
        const keep = text.slice(-Math.floor(maxChars * 0.7))
        text = '# ' + t.id + '\n\n…[autoDream truncated older notes]…\n\n' + keep
        await fsp.writeFile(full, text, 'utf8')
        notes.push('truncated topic:' + t.id)
      }
    } catch (e) { /* ignore */ }
  }

  await writeIndex(projectRoot, [])
  notes.push('index rebuilt (' + topics.length + ' topics)')
  return {
    ok: true,
    notes,
    at: new Date().toISOString()
  }
}

module.exports = {
  memoryRoot,
  indexPath,
  topicPath,
  listTopicFiles,
  writeIndex,
  buildIndexMarkdown,
  migrateIfNeeded,
  appendTopic,
  readTopic,
  runAutoDream
}
