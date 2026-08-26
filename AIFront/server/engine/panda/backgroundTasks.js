/**
 * 后台任务（对标 panda-code LocalShellTask / TaskOutput / TaskStop）
 */

const { spawn } = require('child_process')
const path = require('path')

/** @type {Map<string, object>} */
const tasks = new Map()

function listTasks (projectRoot) {
  const out = []
  for (const t of tasks.values()) {
    if (t.projectRoot !== projectRoot && t.mainRoot !== projectRoot) continue
    out.push({
      id: t.id,
      command: t.command,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt || null,
      exitCode: t.exitCode
    })
  }
  return out
}

function createBackgroundShell (projectRoot, command, options = {}) {
  const id = 'bg_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 5)
  const cwd = options.cwd || projectRoot
  const child = spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    detached: false
  })
  const task = {
    id,
    projectRoot,
    mainRoot: options.mainRoot || projectRoot,
    command,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    child
  }
  child.stdout.on('data', d => {
    task.stdout += d.toString()
    if (task.stdout.length > 200000) task.stdout = task.stdout.slice(-150000)
  })
  child.stderr.on('data', d => {
    task.stderr += d.toString()
    if (task.stderr.length > 100000) task.stderr = task.stderr.slice(-80000)
  })
  child.on('close', (code) => {
    task.status = code === 0 ? 'completed' : 'failed'
    task.exitCode = code
    task.endedAt = new Date().toISOString()
  })
  child.on('error', (err) => {
    task.status = 'failed'
    task.stderr += '\n' + err.message
    task.endedAt = new Date().toISOString()
  })
  tasks.set(id, task)
  return { id, status: 'running', command }
}

function getTaskOutput (id, options = {}) {
  const t = tasks.get(id)
  if (!t) return { ok: false, message: '任务不存在：' + id }
  const tail = Math.min(20000, parseInt(options.tail, 10) || 8000)
  return {
    ok: true,
    id: t.id,
    status: t.status,
    command: t.command,
    exitCode: t.exitCode,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    stdout: t.stdout.slice(-tail),
    stderr: t.stderr.slice(-Math.floor(tail / 2))
  }
}

function stopTask (id) {
  const t = tasks.get(id)
  if (!t) return { ok: false, message: '任务不存在：' + id }
  if (t.status !== 'running') return { ok: true, message: '任务已结束：' + t.status }
  try {
    t.child.kill('SIGTERM')
    setTimeout(() => {
      try { if (t.status === 'running') t.child.kill('SIGKILL') } catch (e) { /* ignore */ }
    }, 2000)
  } catch (e) {
    return { ok: false, message: e.message }
  }
  t.status = 'stopped'
  t.endedAt = new Date().toISOString()
  return { ok: true, message: '已停止任务 ' + id }
}

module.exports = {
  createBackgroundShell,
  getTaskOutput,
  stopTask,
  listTasks
}
