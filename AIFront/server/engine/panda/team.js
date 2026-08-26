/**
 * Team（FS 邮箱 + 落盘任务板）
 * 邮箱：.panda/teams/<id>/inbox/<member>.jsonl
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { callDeepseekText } = require('../shared-llm')
const { runExploreAgent, runPlanAgent, runVerifyAgent } = require('./subagents')

/** @type {Map<string, object>} */
const teams = new Map()

function teamKey (projectRoot, name) {
  return projectRoot + '::' + name
}

function teamDir (projectRoot, id) {
  return path.resolve(projectRoot, '.panda', 'teams', String(id || 'team'))
}

function teamMetaPath (projectRoot, id) {
  return path.join(teamDir(projectRoot, id), 'team.json')
}

function inboxPath (projectRoot, teamId, memberId) {
  const safe = String(memberId || 'member').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(teamDir(projectRoot, teamId), 'inbox', safe + '.jsonl')
}

async function persistTeam (team) {
  try {
    const dir = teamDir(team.projectRoot, team.id)
    await fsp.mkdir(path.join(dir, 'inbox'), { recursive: true })
    await fsp.writeFile(
      teamMetaPath(team.projectRoot, team.id),
      JSON.stringify({
        id: team.id,
        members: team.members.map(m => ({ id: m.id, role: m.role })),
        tasks: team.tasks || [],
        createdAt: team.createdAt,
        updatedAt: new Date().toISOString()
      }, null, 2),
      'utf8'
    )
  } catch (e) { /* ignore */ }
}

async function appendInboxFile (projectRoot, teamId, memberId, message) {
  const p = inboxPath(projectRoot, teamId, memberId)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const row = JSON.stringify({
    at: new Date().toISOString(),
    text: String(message || '')
  }) + '\n'
  await fsp.appendFile(p, row, 'utf8')
}

async function readInboxFile (projectRoot, teamId, memberId, clear) {
  const p = inboxPath(projectRoot, teamId, memberId)
  let raw = ''
  try {
    raw = await fsp.readFile(p, 'utf8')
  } catch (e) {
    return []
  }
  const items = raw.split(/\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch (e) { return { text: line } }
  })
  if (clear) {
    try { await fsp.writeFile(p, '', 'utf8') } catch (e) { /* ignore */ }
  }
  return items
}

async function loadPersisted (projectRoot) {
  const root = path.resolve(projectRoot, '.panda', 'teams')
  let names = []
  try {
    names = await fsp.readdir(root)
  } catch (e) {
    return
  }
  for (const name of names) {
    const meta = path.join(root, name, 'team.json')
    // legacy flat json
    const legacy = path.join(root, name + '.json')
    try {
      let t
      if (fs.existsSync(meta)) {
        t = JSON.parse(await fsp.readFile(meta, 'utf8'))
      } else if (name.endsWith('.json') && fs.existsSync(path.join(root, name))) {
        t = JSON.parse(await fsp.readFile(path.join(root, name), 'utf8'))
      } else continue
      if (t && t.id) {
        t.projectRoot = projectRoot
        if (!Array.isArray(t.tasks)) t.tasks = []
        t.members = (t.members || []).map(m => ({
          id: m.id || m,
          role: m.role || m.id || m,
          inbox: []
        }))
        teams.set(teamKey(projectRoot, t.id), t)
      }
    } catch (e) { /* ignore */ }
  }
}

function createTeam (projectRoot, name, members) {
  const id = String(name || 'team').trim() || 'team'
  const key = teamKey(projectRoot, id)
  const list = Array.isArray(members) && members.length
    ? members
    : ['explorer', 'planner', 'implementer']
  const team = {
    id,
    projectRoot,
    members: list.map(m => ({
      id: String(m),
      role: String(m),
      inbox: []
    })),
    tasks: [],
    createdAt: new Date().toISOString()
  }
  teams.set(key, team)
  void persistTeam(team)
  return team
}

function getTeam (projectRoot, name) {
  return teams.get(teamKey(projectRoot, name)) || null
}

function deleteTeam (projectRoot, name) {
  const ok = teams.delete(teamKey(projectRoot, name))
  try {
    const dir = teamDir(projectRoot, name)
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) { /* ignore */ }
  try {
    fs.unlinkSync(path.resolve(projectRoot, '.panda', 'teams', String(name) + '.json'))
  } catch (e) { /* ignore */ }
  return ok
}

async function listTeams (projectRoot) {
  await loadPersisted(projectRoot)
  const out = []
  for (const [key, t] of teams) {
    if (!key.startsWith(projectRoot + '::')) continue
    out.push({
      id: t.id,
      members: t.members.map(m => m.id),
      tasks: (t.tasks || []).length,
      createdAt: t.createdAt,
      mailbox: '.panda/teams/' + t.id + '/inbox/'
    })
  }
  return out
}

async function sendMessage (projectRoot, teamName, to, message) {
  let team = getTeam(projectRoot, teamName)
  if (!team) {
    await loadPersisted(projectRoot)
    team = getTeam(projectRoot, teamName)
  }
  if (!team) return { ok: false, message: 'Team 不存在：' + teamName }
  const member = team.members.find(m => m.id === to || m.role === to)
  if (!member) {
    return { ok: false, message: '成员不存在：' + to + '；可用：' + team.members.map(m => m.id).join(', ') }
  }
  // 内存 + 落盘双写
  member.inbox.push({
    at: new Date().toISOString(),
    text: String(message || '')
  })
  await appendInboxFile(projectRoot, team.id, member.id, message)
  await persistTeam(team)
  return {
    ok: true,
    message: '已发送给 ' + member.id + '（FS: .panda/teams/' + team.id + '/inbox/' + member.id + '.jsonl）'
  }
}

function upsertTask (projectRoot, teamName, task) {
  const team = getTeam(projectRoot, teamName)
  if (!team) return { ok: false, message: 'Team 不存在' }
  if (!Array.isArray(team.tasks)) team.tasks = []
  const id = task.id || ('task_' + (team.tasks.length + 1))
  let t = team.tasks.find(x => x.id === id)
  if (!t) {
    t = { id, content: '', status: 'pending', assignee: null, blocks: [], blockedBy: [] }
    team.tasks.push(t)
  }
  if (task.content != null) t.content = task.content
  if (task.status != null) t.status = task.status
  if (task.assignee != null) t.assignee = task.assignee
  if (task.description != null) t.description = task.description
  if (Array.isArray(task.blocks)) t.blocks = task.blocks
  if (Array.isArray(task.blockedBy)) t.blockedBy = task.blockedBy
  void persistTeam(team)
  return { ok: true, task: t }
}

function getTask (projectRoot, teamName, taskId) {
  const team = getTeam(projectRoot, teamName)
  if (!team) return null
  return (team.tasks || []).find(t => t.id === taskId) || null
}

async function runMember (projectRoot, teamName, memberId, goal, opts) {
  let team = getTeam(projectRoot, teamName)
  if (!team) {
    await loadPersisted(projectRoot)
    team = getTeam(projectRoot, teamName)
  }
  if (!team) return { ok: false, message: 'Team 不存在' }
  const member = team.members.find(m => m.id === memberId)
  if (!member) return { ok: false, message: '成员不存在' }

  const fileInbox = await readInboxFile(projectRoot, team.id, member.id, true)
  const memInbox = member.inbox.splice(0, member.inbox.length)
  const inboxItems = fileInbox.concat(memInbox)
  const inboxText = inboxItems.map(m => m.text).join('\n')
  const assigned = (team.tasks || []).filter(t => t.assignee === member.id && t.status !== 'completed')
  const taskText = assigned.map(t => '- [' + t.status + '] ' + t.id + ': ' + t.content).join('\n')
  const promptGoal = [goal, inboxText, taskText ? ('任务板：\n' + taskText) : ''].filter(Boolean).join('\n')

  let result = ''
  const role = (member.role || '').toLowerCase()
  if (role.includes('explor')) {
    result = await runExploreAgent(promptGoal || goal, projectRoot)
  } else if (role.includes('plan')) {
    result = await runPlanAgent(promptGoal || goal, projectRoot, '')
  } else if (role.includes('verif') || role.includes('review')) {
    result = await runVerifyAgent(promptGoal || goal, projectRoot, [])
  } else if (role.includes('implement')) {
    const agentFork = require('./agentFork')
    const worktree = require('./worktree')
    const swarmPerm = require('./swarmPerm')
    let forkRoot = projectRoot
    let wtInfo = null
    try {
      wtInfo = await worktree.enterAgentWorktree(projectRoot, 'team-' + team.id + '-' + member.id)
      if (wtInfo && wtInfo.ok && wtInfo.worktreePath) forkRoot = wtInfo.worktreePath
    } catch (e) { /* fall back main */ }

    // 权限：bubble 到 leader（文件队列 + 可选父闸门）
    const teamRequire = swarmPerm.createTeamPermissionBridge({
      projectRoot,
      teamId: team.id,
      memberId: member.id,
      leaderId: (team.members.find(m => /lead|coord/i.test(m.role || m.id)) || team.members[0] || {}).id || 'lead',
      parentRequirePermission: opts && opts.parentRequirePermission,
      sendEvent: opts && opts.sendEvent,
      signal: opts && opts.signal
    })

    const report = await agentFork.runFork(forkRoot, {
      type: 'implementer',
      goal: promptGoal || goal,
      writable: true,
      permissionMode: 'bubble',
      model: 'inherit',
      parentSessionId: opts && opts.sessionId,
      parentRequirePermission: teamRequire,
      parentMode: 'default',
      sendEvent: opts && opts.sendEvent,
      signal: opts && opts.signal
    })
    result = String((report && report.result) || '')
    if (wtInfo && wtInfo.ok) {
      result += '\n\n（worktree: ' + wtInfo.worktreePath + ' · branch ' + wtInfo.branch + '）'
    }
  } else {
    result = await callDeepseekText(
      '你是团队成员「' + member.id + '」，根据目标给出可执行建议。',
      promptGoal || goal,
      { max_tokens: 1000 }
    )
  }
  member.lastResult = result
  await persistTeam(team)
  return { ok: true, member: member.id, result }
}

module.exports = {
  createTeam,
  getTeam,
  deleteTeam,
  listTeams,
  sendMessage,
  runMember,
  upsertTask,
  getTask,
  readInboxFile,
  inboxPath
}
