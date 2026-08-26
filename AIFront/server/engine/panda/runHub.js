/**
 * 运行中会话广播中枢（P0 mid-run reconnect）
 * - 前端刷新/断线后可 attach 再收事件与待处理权限
 * - 原 HTTP SSE 断开不中止 Agent
 * - ring 带 seq，支持 ?fromSeq= 增量重放
 */

const runs = new Map()

const RING_SKIP = new Set(['panda_stream', 'think_reasoning_chunk', 'answer_chunk'])
const RING_MAX = 120

function ensure (sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return null
  let run = runs.get(id)
  if (!run) {
    run = {
      sessionId: id,
      status: 'idle',
      startedAt: 0,
      endedAt: 0,
      message: '',
      model: '',
      workStatus: '',
      round: 0,
      maxRounds: 0,
      permissionMode: '',
      todos: [],
      pendingPermission: null,
      teamPermission: null,
      clients: new Set(),
      ring: [],
      seq: 0
    }
    runs.set(id, run)
  }
  return run
}

function begin (sessionId, meta) {
  const run = ensure(sessionId)
  if (!run) return null
  run.status = 'running'
  run.startedAt = Date.now()
  run.endedAt = 0
  run.message = String((meta && meta.message) || '').slice(0, 240)
  run.model = (meta && meta.model) || ''
  run.workStatus = 'running…'
  run.round = 0
  run.pendingPermission = null
  run.teamPermission = null
  run.ring = []
  run.seq = 0
  return run
}

function end (sessionId) {
  const id = String(sessionId || '').trim()
  const run = runs.get(id)
  if (!run) return
  run.status = 'ended'
  run.endedAt = Date.now()
  run.pendingPermission = null
  run.workStatus = run.workStatus || 'done'
  setTimeout(() => {
    const cur = runs.get(id)
    if (cur && cur.status === 'ended' && Date.now() - (cur.endedAt || 0) >= 25000) {
      runs.delete(id)
    }
  }, 30000)
}

function isRunning (sessionId) {
  const run = runs.get(String(sessionId || '').trim())
  return !!(run && (run.status === 'running' || run.status === 'waiting_permission'))
}

function getSnapshot (sessionId) {
  const run = runs.get(String(sessionId || '').trim())
  if (!run) return { running: false, seq: 0 }
  const live = run.status === 'running' || run.status === 'waiting_permission'
  return {
    running: live,
    status: run.status,
    sessionId: run.sessionId,
    message: run.message,
    model: run.model,
    workStatus: run.workStatus,
    round: run.round,
    maxRounds: run.maxRounds,
    permissionMode: run.permissionMode,
    todos: Array.isArray(run.todos) ? run.todos : [],
    pendingPermission: run.pendingPermission,
    teamPermission: run.teamPermission,
    startedAt: run.startedAt,
    clients: run.clients.size,
    seq: run.seq || 0
  }
}

function pushRing (run, event, data) {
  if (RING_SKIP.has(event)) return
  run.seq = (run.seq || 0) + 1
  run.ring.push({ seq: run.seq, event, data: data || {}, at: Date.now() })
  if (run.ring.length > RING_MAX) run.ring.shift()
}

function updateState (run, event, data) {
  const d = data || {}
  if (event === 'panda_status' || event === 'step' || event === 'started') {
    if (d.message) run.workStatus = String(d.message).slice(0, 200)
    if (d.phase === 'permission' || d.phase === 'permission_wait') {
      run.status = 'waiting_permission'
    } else if (run.status === 'waiting_permission' && d.phase && d.phase !== 'permission' && d.phase !== 'permission_wait') {
      run.status = 'running'
    }
  }
  if (event === 'panda_round') {
    run.round = d.round || run.round
    run.maxRounds = d.maxRounds || run.maxRounds
    run.status = 'running'
  }
  if (event === 'panda_mode' || event === 'panda_context') {
    if (d.permissionMode) run.permissionMode = d.permissionMode
  }
  if (event === 'panda_todos' && Array.isArray(d.todos)) {
    run.todos = d.todos
  }
  if (event === 'panda_permission') {
    run.pendingPermission = Object.assign({}, d)
    run.status = 'waiting_permission'
  }
  if (event === 'panda_permission_resolved' || event === 'permission_resolved') {
    if (!d.id || (run.pendingPermission && run.pendingPermission.id === d.id)) {
      run.pendingPermission = null
    }
    if (run.status === 'waiting_permission') run.status = 'running'
  }
  if (event === 'panda_team_permission') {
    if (d.pending === false) {
      if (run.teamPermission && run.teamPermission.id === d.id) run.teamPermission = null
    } else {
      run.teamPermission = Object.assign({}, d)
    }
  }
  if (event === 'done') {
    run.status = 'ended'
    run.endedAt = Date.now()
    if (Array.isArray(d.todos)) run.todos = d.todos
    run.pendingPermission = null
  }
}

function emit (sessionId, event, data) {
  const run = ensure(sessionId)
  if (!run) return
  if (run.status === 'ended' && event !== 'done') {
    // ok
  } else if (run.status === 'idle') {
    run.status = 'running'
    run.startedAt = run.startedAt || Date.now()
  }
  updateState(run, event, data)
  pushRing(run, event, data)
  const payload = Object.assign({}, data || {}, { _seq: run.seq })
  const dead = []
  for (const client of run.clients) {
    try {
      const ok = client(event, payload)
      if (ok === false) dead.push(client)
    } catch (e) {
      dead.push(client)
    }
  }
  dead.forEach(c => run.clients.delete(c))
}

function attach (sessionId, writeFn, opts) {
  const run = ensure(sessionId)
  if (!run || typeof writeFn !== 'function') return () => {}
  const options = opts || {}
  const replay = options.replay == null ? 'snapshot' : options.replay
  const fromSeq = Number(options.fromSeq) || 0

  if (replay === 'ring') {
    for (const item of run.ring) {
      if (fromSeq && (item.seq || 0) <= fromSeq) continue
      try {
        writeFn(item.event, Object.assign({}, item.data, { _seq: item.seq, _replay: true }))
      } catch (e) { /* ignore */ }
    }
  } else if (replay === 'snapshot') {
    if (run.workStatus) {
      try { writeFn('panda_status', { message: run.workStatus, phase: 'reattach', reattached: true }) } catch (e) { /* */ }
    }
    if (run.pendingPermission) {
      try { writeFn('panda_permission', Object.assign({}, run.pendingPermission, { reattached: true })) } catch (e) { /* */ }
    }
    if (run.teamPermission) {
      try { writeFn('panda_team_permission', Object.assign({}, run.teamPermission, { reattached: true })) } catch (e) { /* */ }
    }
    if (run.todos && run.todos.length) {
      try { writeFn('panda_todos', { todos: run.todos, reattached: true }) } catch (e) { /* */ }
    }
    if (run.permissionMode) {
      try { writeFn('panda_mode', { permissionMode: run.permissionMode, reattached: true }) } catch (e) { /* */ }
    }
    try {
      writeFn('panda_run', {
        reattached: true,
        running: run.status === 'running' || run.status === 'waiting_permission',
        status: run.status,
        round: run.round,
        maxRounds: run.maxRounds,
        message: run.message,
        seq: run.seq || 0
      })
    } catch (e) { /* */ }
  }

  run.clients.add(writeFn)
  return function unsubscribe () {
    run.clients.delete(writeFn)
  }
}

function clearPendingPermission (sessionId, id) {
  const run = runs.get(String(sessionId || '').trim())
  if (!run) return
  if (!id || (run.pendingPermission && run.pendingPermission.id === id)) {
    run.pendingPermission = null
    if (run.status === 'waiting_permission') run.status = 'running'
  }
}

function listActive () {
  const out = []
  for (const [id, run] of runs) {
    if (run.status === 'running' || run.status === 'waiting_permission') {
      out.push(getSnapshot(id))
    }
  }
  return out
}

module.exports = {
  begin,
  end,
  emit,
  attach,
  isRunning,
  getSnapshot,
  clearPendingPermission,
  listActive
}
