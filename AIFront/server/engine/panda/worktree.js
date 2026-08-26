/**
 * Git Worktree 隔离（对标 panda-code EnterWorktree / ExitWorktree）
 * - 会话级：enterWorktree / exitWorktree（全局 state）
 * - Agent 级：enterAgentWorktree / removeAgentWorktree（多路并行，互不覆盖）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')

function run (cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function statePath (mainRoot) {
  return path.resolve(mainRoot, '.panda', 'worktree-state.json')
}

function agentStatePath (mainRoot) {
  return path.resolve(mainRoot, '.panda', 'agent-worktrees.json')
}

async function readState (mainRoot) {
  try {
    return JSON.parse(await fsp.readFile(statePath(mainRoot), 'utf8'))
  } catch (e) {
    return null
  }
}

async function writeState (mainRoot, state) {
  await fsp.mkdir(path.resolve(mainRoot, '.panda'), { recursive: true })
  await fsp.writeFile(statePath(mainRoot), JSON.stringify(state, null, 2), 'utf8')
}

async function readAgentMap (mainRoot) {
  try {
    return JSON.parse(await fsp.readFile(agentStatePath(mainRoot), 'utf8'))
  } catch (e) {
    return { agents: {} }
  }
}

async function writeAgentMap (mainRoot, map) {
  await fsp.mkdir(path.resolve(mainRoot, '.panda'), { recursive: true })
  await fsp.writeFile(agentStatePath(mainRoot), JSON.stringify(map, null, 2), 'utf8')
}

function sanitizeSlug (name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._/-]/g, '-').replace(/\/+/g, '-').slice(0, 48)
  return s || ('wt-' + Date.now().toString(16))
}

async function createWorktreeDir (mainRoot, slug) {
  const branch = 'panda/' + slug
  const parent = path.resolve(mainRoot, '..')
  const worktreePath = path.join(parent, path.basename(mainRoot) + '-panda-' + slug.replace(/\//g, '-'))

  const check = await run('git rev-parse --is-inside-work-tree', mainRoot)
  if (check.code !== 0) {
    return { ok: false, message: '当前项目不是 git 仓库，无法创建 worktree' }
  }

  if (fs.existsSync(worktreePath)) {
    return { ok: true, worktreePath, branch, reused: true, slug }
  }

  let result = await run('git worktree add -b "' + branch + '" "' + worktreePath + '"', mainRoot)
  if (result.code !== 0) {
    result = await run('git worktree add "' + worktreePath + '" "' + branch + '"', mainRoot)
  }
  if (result.code !== 0) {
    const slug2 = slug + '-' + Date.now().toString(16).slice(-4)
    const branch2 = 'panda/' + slug2
    const path2 = path.join(parent, path.basename(mainRoot) + '-panda-' + slug2.replace(/\//g, '-'))
    result = await run('git worktree add -b "' + branch2 + '" "' + path2 + '"', mainRoot)
    if (result.code !== 0) {
      return { ok: false, message: '创建 worktree 失败：' + (result.stderr || result.stdout) }
    }
    return { ok: true, worktreePath: path2, branch: branch2, slug: slug2 }
  }
  return { ok: true, worktreePath, branch, slug }
}

async function enterWorktree (mainRoot, name) {
  const existing = await readState(mainRoot)
  if (existing && existing.worktreePath && fs.existsSync(existing.worktreePath)) {
    return {
      ok: true,
      already: true,
      worktreePath: existing.worktreePath,
      branch: existing.branch,
      message: '已在 worktree 中：' + existing.worktreePath
    }
  }

  const slug = sanitizeSlug(name)
  const created = await createWorktreeDir(mainRoot, slug)
  if (!created.ok) return created

  const state = {
    mainRoot,
    worktreePath: created.worktreePath,
    branch: created.branch,
    slug: created.slug || slug,
    enteredAt: new Date().toISOString()
  }
  await writeState(mainRoot, state)
  try {
    await fsp.mkdir(path.join(created.worktreePath, '.panda'), { recursive: true })
    await fsp.writeFile(
      path.join(created.worktreePath, '.panda', 'worktree-state.json'),
      JSON.stringify(state, null, 2),
      'utf8'
    )
  } catch (e) { /* ignore */ }

  return {
    ok: true,
    worktreePath: created.worktreePath,
    branch: created.branch,
    message: '已进入隔离 worktree：' + created.worktreePath + '（分支 ' + created.branch + '）。可用 exit_worktree 退出。'
  }
}

async function enterAgentWorktree (mainRoot, agentKey) {
  const map = await readAgentMap(mainRoot)
  const key = sanitizeSlug(agentKey)
  const prev = map.agents[key]
  if (prev && prev.worktreePath && fs.existsSync(prev.worktreePath)) {
    return {
      ok: true,
      already: true,
      worktreePath: prev.worktreePath,
      branch: prev.branch,
      agentKey: key,
      message: '复用 agent worktree：' + prev.worktreePath
    }
  }

  const created = await createWorktreeDir(mainRoot, 'ag-' + key)
  if (!created.ok) return created

  const entry = {
    agentKey: key,
    worktreePath: created.worktreePath,
    branch: created.branch,
    enteredAt: new Date().toISOString()
  }
  map.agents[key] = entry
  await writeAgentMap(mainRoot, map)
  return Object.assign({ ok: true, message: '已创建 agent worktree：' + created.worktreePath }, entry)
}

async function removeAgentWorktree (mainRoot, agentKey, options = {}) {
  const map = await readAgentMap(mainRoot)
  const key = sanitizeSlug(agentKey)
  const entry = map.agents[key]
  if (!entry) return { ok: false, message: '无此 agent worktree' }
  const remove = options.remove !== false
  if (remove && entry.worktreePath && fs.existsSync(entry.worktreePath)) {
    const r = await run('git worktree remove --force "' + entry.worktreePath + '"', mainRoot)
    if (r.code !== 0) {
      try { await fsp.rm(entry.worktreePath, { recursive: true, force: true }) } catch (e) { /* ignore */ }
      await run('git worktree prune', mainRoot)
    }
  }
  delete map.agents[key]
  await writeAgentMap(mainRoot, map)
  return { ok: true, message: '已移除 agent worktree：' + (entry.worktreePath || key) }
}

async function exitWorktree (mainRoot, options = {}) {
  const state = await readState(mainRoot)
  if (!state || !state.worktreePath) {
    return { ok: false, message: '当前没有活动的 worktree 会话' }
  }
  const wt = state.worktreePath
  const remove = options.remove !== false
  if (remove && fs.existsSync(wt)) {
    const r = await run('git worktree remove --force "' + wt + '"', mainRoot)
    if (r.code !== 0) {
      try {
        await fsp.rm(wt, { recursive: true, force: true })
      } catch (e) { /* ignore */ }
      await run('git worktree prune', mainRoot)
    }
  }
  try {
    await fsp.unlink(statePath(mainRoot))
  } catch (e) { /* ignore */ }
  return {
    ok: true,
    message: remove
      ? '已退出并移除 worktree：' + wt
      : '已退出 worktree（保留目录）：' + wt,
    mainRoot
  }
}

async function currentWorktree (mainRoot) {
  return await readState(mainRoot)
}

async function listAgentWorktrees (mainRoot) {
  const map = await readAgentMap(mainRoot)
  return Object.values(map.agents || {})
}

module.exports = {
  enterWorktree,
  exitWorktree,
  currentWorktree,
  enterAgentWorktree,
  removeAgentWorktree,
  listAgentWorktrees,
  sanitizeSlug
}
