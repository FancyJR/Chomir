/**
 * Team/Swarm 权限同步（对齐 permissionSync.ts）
 * Worker → pending 文件 → Leader UI / team_perm_resolve → worker 轮询
 */

const fsp = require('fs').promises
const path = require('path')

function permDir (projectRoot, teamId) {
  return path.resolve(projectRoot, '.panda', 'teams', String(teamId || 'default'), 'permissions')
}

function inboxPath (projectRoot, teamId, memberId) {
  const safe = String(memberId || 'member').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(
    path.resolve(projectRoot, '.panda', 'teams', String(teamId || 'default'), 'inbox'),
    safe + '.jsonl'
  )
}

async function submitTeamPermission (projectRoot, teamId, req) {
  const dir = permDir(projectRoot, teamId)
  await fsp.mkdir(dir, { recursive: true })
  const id = 'tperm_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 6)
  const row = {
    id,
    status: 'pending',
    tool: req.tool || '',
    detail: String(req.detail || '').slice(0, 500),
    risk: req.risk || 'write',
    fromMember: req.fromMember || '',
    workerId: req.workerId || req.fromMember || '',
    teamId: String(teamId || 'default'),
    toolUseId: req.toolUseId || '',
    suggestions: req.suggestions || [],
    createdAt: new Date().toISOString()
  }
  await fsp.writeFile(path.join(dir, id + '.json'), JSON.stringify(row, null, 2), 'utf8')

  // 写入 leader 邮箱提示
  try {
    const lead = String(req.leaderId || 'lead')
    const p = inboxPath(projectRoot, teamId, lead)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.appendFile(p, JSON.stringify({
      at: new Date().toISOString(),
      type: 'permission_request',
      text: '权限请求 ' + row.id + ' · ' + row.fromMember + ' · ' + row.tool + ' · ' + row.detail,
      permissionId: row.id
    }) + '\n', 'utf8')
  } catch (e) { /* ignore */ }

  return row
}

async function listPending (projectRoot, teamId) {
  const dir = permDir(projectRoot, teamId)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const row = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))
      if (row && row.status === 'pending') out.push(row)
    } catch (e) { /* ignore */ }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

async function resolveTeamPermission (projectRoot, teamId, id, allow, reason) {
  const file = path.join(permDir(projectRoot, teamId), String(id) + '.json')
  let row
  try {
    row = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (e) {
    return { ok: false, reason: 'not found' }
  }
  row.status = allow ? 'allowed' : 'denied'
  row.resolvedAt = new Date().toISOString()
  row.resolvedBy = 'leader'
  row.reason = reason || ''
  await fsp.writeFile(file, JSON.stringify(row, null, 2), 'utf8')

  // 回写 worker 邮箱
  try {
    const worker = row.fromMember || row.workerId
    if (worker) {
      const p = inboxPath(projectRoot, teamId, worker)
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.appendFile(p, JSON.stringify({
        at: new Date().toISOString(),
        type: 'permission_response',
        permissionId: row.id,
        allow: !!allow,
        text: (allow ? '已批准' : '已拒绝') + ' · ' + row.id + (reason ? ' · ' + reason : '')
      }) + '\n', 'utf8')
    }
  } catch (e) { /* ignore */ }

  return { ok: true, request: row }
}

async function readPermission (projectRoot, teamId, id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(permDir(projectRoot, teamId), String(id) + '.json'), 'utf8'))
  } catch (e) {
    return null
  }
}

/**
 * Worker 等待 leader 决议（轮询文件）
 * @returns {Promise<boolean>} allow
 */
async function waitForResolution (projectRoot, teamId, id, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 300000
  const signal = opts && opts.signal
  const sendEvent = opts && opts.sendEvent
  const started = Date.now()
  if (sendEvent) {
    sendEvent('panda_block', {
      type: 'system',
      content: 'Team 权限等待 leader：' + id + '（team_perm_resolve / 工作台弹窗）'
    })
    sendEvent('panda_team_permission', {
      teamId,
      id,
      pending: true
    })
  }
  while (Date.now() - started < timeoutMs) {
    if (signal && signal.aborted) return false
    const row = await readPermission(projectRoot, teamId, id)
    if (row && row.status === 'allowed') return true
    if (row && row.status === 'denied') return false
    await new Promise(r => setTimeout(r, 800))
  }
  return false
}

/**
 * 包装父级 requirePermission：先提交 team 队列，同时弹 leader UI，再等待决议
 */
function createTeamPermissionBridge (opts) {
  const {
    projectRoot,
    teamId,
    memberId,
    leaderId,
    parentRequirePermission,
    sendEvent,
    signal
  } = opts || {}

  return async function teamRequirePermission (req) {
    const row = await submitTeamPermission(projectRoot, teamId, {
      tool: req.tool,
      detail: req.detail,
      risk: req.risk,
      fromMember: memberId,
      workerId: memberId,
      leaderId: leaderId || 'lead',
      toolUseId: req.id || '',
      suggestions: req.suggestions || []
    })

    // 同步推给工作台（leader 会话）
    if (sendEvent) {
      sendEvent('panda_team_permission', {
        teamId,
        id: row.id,
        tool: row.tool,
        detail: row.detail,
        risk: row.risk,
        fromMember: memberId,
        pending: true
      })
    }

    // 若 leader 同进程有 UI 闸门，也弹一次（可与文件轮询并行）
    let uiPromise = null
    if (typeof parentRequirePermission === 'function') {
      uiPromise = parentRequirePermission(Object.assign({}, req, {
        forceAsk: true,
        reason: (req.reason || '') + ' · team member ' + memberId,
        teamPermissionId: row.id,
        teamId
      })).then(async (allow) => {
        await resolveTeamPermission(projectRoot, teamId, row.id, !!allow, allow ? 'leader UI' : 'leader UI deny')
        return !!allow
      }).catch(() => null)
    }

    const fileAllow = waitForResolution(projectRoot, teamId, row.id, { signal, sendEvent, timeoutMs: 300000 })
    if (uiPromise) {
      const first = await Promise.race([
        uiPromise.then(v => ({ from: 'ui', allow: v })),
        fileAllow.then(v => ({ from: 'file', allow: v }))
      ])
      if (first.from === 'ui' && first.allow != null) return !!first.allow
      return !!first.allow
    }
    return !!(await fileAllow)
  }
}

module.exports = {
  submitTeamPermission,
  listPending,
  resolveTeamPermission,
  readPermission,
  waitForResolution,
  createTeamPermissionBridge,
  permDir
}
