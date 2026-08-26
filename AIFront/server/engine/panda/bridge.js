/**
 * Remote Bridge：WebSocket 将会话事件同步到远程客户端（对标 panda-code bridge）
 * 浏览器也可连上 ws://host/panda-bridge?session=xxx 旁听/遥控
 *
 * 遥控协议：
 * - inject_user { content }
 * - permission_resolve { id, allow, persistAllow?, allowRule? }  — 权限中继
 * - ping
 */

const { WebSocketServer } = require('ws')

/** @type {WebSocketServer|null} */
let wss = null
/** sessionId -> Set<ws> */
const rooms = new Map()

function attachBridge (httpServer) {
  if (wss) return wss
  wss = new WebSocketServer({ server: httpServer, path: '/panda-bridge' })
  wss.on('error', (err) => {
    console.warn('[panda-bridge] error:', err && err.message ? err.message : err)
  })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost')
    const sessionId = url.searchParams.get('session') || 'default'
    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set())
    rooms.get(sessionId).add(ws)
    ws.send(JSON.stringify({ event: 'bridge_hello', sessionId, message: 'Panda Remote Bridge connected' }))

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch (e) { return }
      if (msg && msg.type === 'inject_user' && msg.content) {
        broadcast(sessionId, {
          event: 'bridge_inject',
          content: String(msg.content),
          from: 'remote'
        }, ws)
      }
      if (msg && (msg.type === 'permission_resolve' || msg.type === 'resolve_permission') && msg.id) {
        try {
          const { resolvePermission } = require('./permissionGate')
          const allow = msg.allow !== false && msg.allow !== 'false'
          const ok = resolvePermission(msg.id, allow, {
            sessionId,
            permissionMode: msg.permissionMode || '',
            sessionAllow: !!msg.sessionAllow,
            sessionDeny: !!msg.sessionDeny,
            persistDeny: !!msg.persistDeny,
            persistAllow: !!msg.persistAllow,
            allowRule: msg.allowRule || null,
            projectRoot: msg.projectRoot || process.cwd()
          })
          ws.send(JSON.stringify({
            event: 'permission_resolved',
            id: msg.id,
            allow,
            ok
          }))
          broadcast(sessionId, {
            event: 'bridge_permission_resolved',
            id: msg.id,
            allow,
            ok
          }, ws)
        } catch (e) {
          ws.send(JSON.stringify({
            event: 'permission_resolved',
            id: msg.id,
            ok: false,
            error: e.message || String(e)
          }))
        }
      }
      if (msg && msg.type === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', t: Date.now() }))
      }
    })

    ws.on('close', () => {
      const set = rooms.get(sessionId)
      if (set) {
        set.delete(ws)
        if (!set.size) rooms.delete(sessionId)
      }
    })
  })
  console.log('[panda-bridge] WebSocket ready at /panda-bridge?session=<id>')
  return wss
}

function broadcast (sessionId, payload, except) {
  const set = rooms.get(sessionId)
  if (!set || !set.size) return 0
  const data = JSON.stringify(payload)
  let n = 0
  for (const ws of set) {
    if (except && ws === except) continue
    if (ws.readyState === 1) {
      ws.send(data)
      n++
    }
  }
  return n
}

function bridgeSendEvent (sessionId, event, data) {
  return broadcast(sessionId, Object.assign({ event }, data || {}))
}

function bridgeStats () {
  const sessions = []
  for (const [id, set] of rooms) {
    sessions.push({ sessionId: id, clients: set.size })
  }
  return { sessions, totalClients: sessions.reduce((a, b) => a + b.clients, 0) }
}

module.exports = {
  attachBridge,
  bridgeSendEvent,
  bridgeStats,
  broadcast
}
