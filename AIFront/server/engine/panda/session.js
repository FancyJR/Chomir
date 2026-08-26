/**
 * 会话 transcript + 元数据（对标 panda-code sessionStorage / LogSelector）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function pandaRoot (projectRoot) {
  return path.resolve(projectRoot, '.panda')
}

function sessionDir (projectRoot) {
  return path.join(pandaRoot(projectRoot), 'sessions')
}

function sessionFile (projectRoot, sessionId) {
  return path.join(sessionDir(projectRoot), `${sessionId}.jsonl`)
}

function metaFile (projectRoot) {
  return path.join(pandaRoot(projectRoot), 'sessions-meta.json')
}

async function ensureDirs (projectRoot) {
  await fsp.mkdir(sessionDir(projectRoot), { recursive: true })
}

async function readMetaMap (projectRoot) {
  try {
    const raw = await fsp.readFile(metaFile(projectRoot), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch (e) {
    return {}
  }
}

async function writeMetaMap (projectRoot, map) {
  await ensureDirs(projectRoot)
  await fsp.writeFile(metaFile(projectRoot), JSON.stringify(map, null, 2), 'utf8')
}

async function touchSessionMeta (projectRoot, sessionId, patch) {
  if (!sessionId) return
  const map = await readMetaMap(projectRoot)
  const prev = map[sessionId] || {}
  map[sessionId] = Object.assign({}, prev, patch || {}, {
    id: sessionId,
    updatedAt: new Date().toISOString(),
    createdAt: prev.createdAt || new Date().toISOString(),
    title: (patch && patch.title) || prev.title || '新会话'
  })
  await writeMetaMap(projectRoot, map)
  return map[sessionId]
}

async function createSession (projectRoot, title) {
  const id = 'sess_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6)
  const meta = await touchSessionMeta(projectRoot, id, {
    title: title || '新会话',
    lastMessage: ''
  })
  await appendTranscript(projectRoot, id, { type: 'system', content: '会话已创建' })
  return meta
}

async function listSessions (projectRoot) {
  const map = await readMetaMap(projectRoot)
  return Object.values(map).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

async function appendTranscript (projectRoot, sessionId, entry) {
  if (!sessionId) return
  await ensureDirs(projectRoot)
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n'
  await fsp.appendFile(sessionFile(projectRoot, sessionId), line, 'utf8')
}

async function loadRecentTranscript (projectRoot, sessionId, maxLines = 200) {
  if (!sessionId) return []
  const p = sessionFile(projectRoot, sessionId)
  try {
    const text = await fsp.readFile(p, 'utf8')
    const lines = text.trim().split(/\n/).filter(Boolean)
    return lines.slice(-maxLines).map(l => {
      try { return JSON.parse(l) } catch (e) { return null }
    }).filter(Boolean)
  } catch (e) {
    return []
  }
}

async function deleteSession (projectRoot, sessionId) {
  const map = await readMetaMap(projectRoot)
  delete map[sessionId]
  await writeMetaMap(projectRoot, map)
  try {
    await fsp.unlink(sessionFile(projectRoot, sessionId))
  } catch (e) { /* ignore */ }
  try {
    await fsp.unlink(contextFile(projectRoot, sessionId))
  } catch (e) { /* ignore */ }
}

function contextFile (projectRoot, sessionId) {
  return path.join(sessionDir(projectRoot), `${sessionId}.context.json`)
}

async function loadSessionContext (projectRoot, sessionId) {
  if (!sessionId) return { readFileState: [], recentMessages: [], todos: [] }
  try {
    const raw = await fsp.readFile(contextFile(projectRoot, sessionId), 'utf8')
    const data = JSON.parse(raw)
    return {
      readFileState: Array.isArray(data.readFileState) ? data.readFileState : [],
      recentMessages: Array.isArray(data.recentMessages) ? data.recentMessages : [],
      permissionMode: data.permissionMode || null,
      todos: Array.isArray(data.todos) ? data.todos : [],
      lastUserGoal: data.lastUserGoal || '',
      changedFiles: Array.isArray(data.changedFiles) ? data.changedFiles : []
    }
  } catch (e) {
    return { readFileState: [], recentMessages: [], todos: [] }
  }
}

async function saveSessionContext (projectRoot, sessionId, ctx) {
  if (!sessionId || !ctx) return
  await ensureDirs(projectRoot)
  const payload = {
    updatedAt: new Date().toISOString(),
    permissionMode: ctx.permissionMode || null,
    readFileState: ctx.readFileState || [],
    recentMessages: (ctx.recentMessages || []).slice(-40),
    todos: Array.isArray(ctx.todos) ? ctx.todos.slice(0, 80) : [],
    lastUserGoal: ctx.lastUserGoal ? String(ctx.lastUserGoal).slice(0, 2000) : '',
    changedFiles: Array.isArray(ctx.changedFiles) ? ctx.changedFiles.slice(-40) : []
  }
  await fsp.writeFile(contextFile(projectRoot, sessionId), JSON.stringify(payload), 'utf8')
}

function serializeReadFileState (map) {
  if (!map || typeof map.entries !== 'function') return []
  const out = []
  for (const [key, val] of map.entries()) {
    out.push({
      path: key,
      content: String((val && val.content) || '').slice(0, 400000),
      timestamp: (val && val.timestamp) || Date.now(),
      offset: val && val.offset,
      limit: val && val.limit,
      isPartialView: !!(val && val.isPartialView)
    })
  }
  return out
}

function restoreReadFileState (entries) {
  const map = new Map()
  if (!Array.isArray(entries)) return map
  for (const e of entries) {
    if (!e || !e.path) continue
    map.set(path.resolve(e.path), {
      content: String(e.content || ''),
      timestamp: e.timestamp || Date.now(),
      offset: e.offset,
      limit: e.limit,
      isPartialView: !!e.isPartialView
    })
  }
  return map
}

/** 从 API messages 抽出可跨轮续传的片段（不含 system；禁止持久化 image_url base64） */
function extractPersistableMessages (messages) {
  const { flattenContentToText } = require('./messageSanitize')
  const list = Array.isArray(messages) ? messages : []
  const body = list.filter(m => m && m.role && m.role !== 'system')
  return body.slice(-36).map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: flattenContentToText(m.content).slice(0, 12000) }
    }
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: flattenContentToText(m.content).slice(0, 8000) || null }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) o.tool_calls = m.tool_calls
      return o
    }
    return { role: m.role, content: flattenContentToText(m.content).slice(0, 8000) }
  })
}

module.exports = {
  appendTranscript,
  loadRecentTranscript,
  touchSessionMeta,
  createSession,
  listSessions,
  deleteSession,
  sessionDir,
  loadSessionContext,
  saveSessionContext,
  serializeReadFileState,
  restoreReadFileState,
  extractPersistableMessages
}
