/**
 * Swarm 编排（加深：落盘 + implementer 真 fork 工具循环）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { callDeepseekText, callDeepseekJson } = require('../shared-llm')
const { runExploreAgent, runPlanAgent, runVerifyAgent } = require('./subagents')

/** @type {Map<string, object>} */
const swarms = new Map()

function swarmKey (projectRoot, id) {
  return projectRoot + '::' + id
}

function swarmDir (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'swarms')
}

async function persistSwarm (swarm) {
  try {
    const dir = swarmDir(swarm.projectRoot)
    await fsp.mkdir(dir, { recursive: true })
    const slim = {
      id: swarm.id,
      goal: swarm.goal,
      status: swarm.status,
      createdAt: swarm.createdAt,
      finishedAt: swarm.finishedAt,
      synthesis: swarm.synthesis,
      workers: (swarm.workers || []).map(w => ({
        id: w.id,
        role: w.role,
        task: w.task,
        status: w.status,
        result: String(w.result || '').slice(0, 8000)
      }))
    }
    await fsp.writeFile(path.join(dir, swarm.id + '.json'), JSON.stringify(slim, null, 2), 'utf8')
  } catch (e) { /* ignore */ }
}

async function loadPersisted (projectRoot) {
  const dir = swarmDir(projectRoot)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const s = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
      if (s && s.id) {
        s.projectRoot = projectRoot
        swarms.set(swarmKey(projectRoot, s.id), s)
      }
    } catch (e) { /* ignore */ }
  }
}

async function planWorkers (goal) {
  try {
    const data = await callDeepseekJson(
      '你是 Swarm 调度器。输出 JSON：{ "workers": [ { "id": "w1", "role": "explorer|planner|implementer|reviewer", "task": "..." } ] }，2~4 个 worker。implementer 仅在需要改代码时使用。',
      '目标：' + goal
    )
    if (data && Array.isArray(data.workers) && data.workers.length) {
      return data.workers.slice(0, 4).map((w, i) => ({
        id: w.id || ('w' + (i + 1)),
        role: w.role || 'explorer',
        task: w.task || goal
      }))
    }
  } catch (e) { /* fallthrough */ }
  return [
    { id: 'explorer', role: 'explorer', task: '探索与目标相关的代码位置：' + goal },
    { id: 'planner', role: 'planner', task: '制定实施计划：' + goal },
    { id: 'reviewer', role: 'reviewer', task: '列出风险与验收点：' + goal }
  ]
}

async function runWorker (projectRoot, worker, opts) {
  const role = String(worker.role || '').toLowerCase()
  const task = worker.task || ''
  const scratchRel = opts && opts.scratchRel
  const taskNote = scratchRel
    ? (task + '\n\n（可把笔记写到 scratchpad：' + scratchRel + '）')
    : task
  try {
    if (role.includes('explor')) {
      return await runExploreAgent(taskNote, projectRoot)
    }
    if (role.includes('plan')) {
      return await runPlanAgent(taskNote, projectRoot, '')
    }
    if (role.includes('verif') || role.includes('review')) {
      return await runVerifyAgent(taskNote, projectRoot, [])
    }
    if (role.includes('implement')) {
      const agentFork = require('./agentFork')
      const worktree = require('./worktree')
      let forkRoot = projectRoot
      let wtInfo = null
      try {
        const key = 'swarm-' + ((opts && opts.swarmId) || 'x') + '-' + (worker.id || 'w')
        wtInfo = await worktree.enterAgentWorktree(projectRoot, key)
        if (wtInfo && wtInfo.ok && wtInfo.worktreePath) forkRoot = wtInfo.worktreePath
      } catch (e) { /* main root */ }
      const report = await agentFork.runFork(forkRoot, {
        type: 'implementer',
        goal: taskNote,
        parentSessionId: opts && opts.sessionId,
        writable: true,
        permissionMode: 'acceptEdits',
        model: 'inherit',
        onProgress: opts && opts.onProgress
          ? (k, m) => opts.onProgress('swarm', m)
          : undefined,
        sendEvent: opts && opts.sendEvent
      })
      let text = String((report && report.result) || '')
      if (wtInfo && wtInfo.ok) {
        text += '\n\n（agent worktree: `' + wtInfo.worktreePath + '` · `' + wtInfo.branch + '`）'
      }
      return text
    }
    return await callDeepseekText(
      '你是 Swarm worker，角色=' + worker.role + '。给出可执行结果。',
      taskNote,
      { max_tokens: 1200 }
    )
  } catch (e) {
    return 'Worker 失败：' + e.message
  }
}

async function runSwarm (projectRoot, goal, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const id = 'swarm_' + Date.now().toString(16)
  let scratchRel = ''
  try {
    const sp = require('./scratchpad')
    if (opts.sessionId) {
      await sp.ensureScratchpad(projectRoot, opts.sessionId)
      scratchRel = sp.relativeScratchpad(projectRoot, opts.sessionId) + '/swarm-' + id
      await fsp.mkdir(path.resolve(projectRoot, scratchRel), { recursive: true })
    }
  } catch (e) { /* ignore */ }

  onProgress('swarm', '分解 worker…')
  const workers = await planWorkers(goal)
  const swarm = {
    id,
    goal,
    projectRoot,
    workers: workers.map(w => Object.assign({}, w, { status: 'pending', result: null })),
    status: 'running',
    createdAt: new Date().toISOString(),
    synthesis: null
  }
  swarms.set(swarmKey(projectRoot, id), swarm)
  await persistSwarm(swarm)

  onProgress('swarm', '并行运行 ' + workers.length + ' 个 worker…')
  const results = await Promise.all(workers.map(async (w, idx) => {
    swarm.workers[idx].status = 'running'
    await persistSwarm(swarm)
    const result = await runWorker(projectRoot, w, {
      sessionId: opts.sessionId,
      scratchRel,
      swarmId: id,
      onProgress,
      sendEvent: opts.sendEvent
    })
    swarm.workers[idx].status = 'done'
    swarm.workers[idx].result = result
    await persistSwarm(swarm)
    onProgress('swarm', 'worker ' + w.id + ' 完成')
    return { id: w.id, role: w.role, result }
  }))

  onProgress('swarm', 'Queen 汇总…')
  const prompt = [
    '你是 Swarm Queen。汇总各 worker 结果，输出：',
    '1) 总体结论',
    '2) 建议主 Agent 立刻执行的有序步骤（对应工具）',
    '3) 分歧/风险',
    '',
    '目标：' + goal,
    '',
    ...results.map(r => '### ' + r.id + ' (' + r.role + ')\n' + r.result)
  ].join('\n')

  let synthesis = ''
  try {
    synthesis = await callDeepseekText('输出清晰中文行动汇总。', prompt, { max_tokens: 1600 })
  } catch (e) {
    synthesis = results.map(r => '## ' + r.id + '\n' + String(r.result).slice(0, 800)).join('\n\n')
  }

  swarm.status = 'done'
  swarm.synthesis = synthesis
  swarm.finishedAt = new Date().toISOString()
  await persistSwarm(swarm)

  return {
    id,
    workers: swarm.workers,
    synthesis
  }
}

function getSwarm (projectRoot, id) {
  return swarms.get(swarmKey(projectRoot, id)) || null
}

async function listSwarms (projectRoot) {
  await loadPersisted(projectRoot)
  const out = []
  for (const [key, s] of swarms) {
    if (!key.startsWith(projectRoot + '::')) continue
    out.push({
      id: s.id,
      goal: s.goal,
      status: s.status,
      workers: (s.workers || []).map(w => ({ id: w.id, role: w.role, status: w.status })),
      createdAt: s.createdAt
    })
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

module.exports = {
  runSwarm,
  getSwarm,
  listSwarms
}
