/**
 * 轻量定时任务（对标 panda-code ScheduleCronTool）
 * 存储于 .panda/cron.json；支持常驻 interval 调度 + autoDream
 */

const fsp = require('fs').promises
const path = require('path')

function cronFile (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'cron.json')
}

async function loadCron (projectRoot) {
  try {
    const data = JSON.parse(await fsp.readFile(cronFile(projectRoot), 'utf8'))
    return Array.isArray(data.jobs) ? data : { jobs: [] }
  } catch (e) {
    return { jobs: [] }
  }
}

async function saveCron (projectRoot, data) {
  await fsp.mkdir(path.resolve(projectRoot, '.panda'), { recursive: true })
  await fsp.writeFile(cronFile(projectRoot), JSON.stringify(data, null, 2), 'utf8')
}

function parseEvery (every) {
  const m = String(every || '').trim().match(/^(\d+)\s*(s|m|h|d)$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const u = m[2].toLowerCase()
  const mult = u === 's' ? 1000 : u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000
  return n * mult
}

async function createCron (projectRoot, job) {
  const data = await loadCron(projectRoot)
  const id = job.id || ('cron_' + Date.now().toString(16))
  const everyMs = parseEvery(job.every)
  if (!everyMs && !job.runAt) {
    return { ok: false, message: '需要 every（如 5m/1h）或 runAt（ISO 时间）' }
  }
  const item = {
    id,
    prompt: job.prompt || job.command || '',
    every: job.every || null,
    everyMs,
    runAt: job.runAt || null,
    enabled: job.enabled !== false,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: job.runAt || new Date(Date.now() + (everyMs || 0)).toISOString()
  }
  data.jobs.push(item)
  await saveCron(projectRoot, data)
  return { ok: true, job: item }
}

async function deleteCron (projectRoot, id) {
  const data = await loadCron(projectRoot)
  const before = data.jobs.length
  data.jobs = data.jobs.filter(j => j.id !== id)
  await saveCron(projectRoot, data)
  return { ok: data.jobs.length < before, message: data.jobs.length < before ? '已删除' : '未找到' }
}

async function listCron (projectRoot) {
  const data = await loadCron(projectRoot)
  return data.jobs
}

async function tickCron (projectRoot) {
  const data = await loadCron(projectRoot)
  const now = Date.now()
  const due = []
  for (const j of data.jobs) {
    if (!j.enabled) continue
    const next = j.nextRunAt ? Date.parse(j.nextRunAt) : 0
    if (next && next <= now) {
      due.push(Object.assign({}, j))
      j.lastRunAt = new Date().toISOString()
      if (j.everyMs) {
        j.nextRunAt = new Date(now + j.everyMs).toISOString()
      } else {
        j.enabled = false
        j.nextRunAt = null
      }
    }
  }
  await saveCron(projectRoot, data)
  return due
}

/** @type {NodeJS.Timeout|null} */
let _timer = null
let _dreamAt = 0
let _running = false

function isAgentBusy () {
  try {
    return !!require('./abortRegistry').hasActiveRuns()
  } catch (e) {
    return false
  }
}

/**
 * 常驻后台调度：tick cron + 空闲 autoDream
 */
function startBackgroundScheduler (projectRoot, opts = {}) {
  stopBackgroundScheduler()
  if (process.env.PANDA_CRON_SCHEDULER === '0') {
    console.log('[panda-cron] scheduler disabled (PANDA_CRON_SCHEDULER=0)')
    return { ok: false, reason: 'disabled' }
  }
  const intervalMs = Math.max(15000, opts.intervalMs || parseInt(process.env.PANDA_CRON_INTERVAL_MS, 10) || 60000)
  const dreamEveryMs = Math.max(60000, opts.dreamEveryMs || parseInt(process.env.PANDA_DREAM_INTERVAL_MS, 10) || 15 * 60000)

  const tick = async () => {
    if (_running) return
    _running = true
    try {
      const busy = isAgentBusy()
      const due = await tickCron(projectRoot)
      if (due.length) {
        const logDir = path.resolve(projectRoot, '.panda')
        await fsp.mkdir(logDir, { recursive: true })
        await fsp.appendFile(
          path.join(logDir, 'cron-due.jsonl'),
          due.map(j => JSON.stringify({
            at: new Date().toISOString(),
            id: j.id,
            prompt: String(j.prompt || '').slice(0, 500)
          })).join('\n') + '\n',
          'utf8'
        )
        if (typeof opts.onDue === 'function') {
          try { await opts.onDue(due) } catch (e) { console.warn('[panda-cron] onDue', e.message) }
        }
        console.log('[panda-cron] due', due.map(d => d.id).join(','))
      }

      const now = Date.now()
      if (!busy && now - _dreamAt >= dreamEveryMs) {
        _dreamAt = now
        try {
          const dream = await require('./memoryIndex').runAutoDream(projectRoot)
          if (typeof opts.onDream === 'function') await opts.onDream(dream)
          console.log('[panda-cron] autoDream', (dream.notes || []).join('; '))
        } catch (e) {
          console.warn('[panda-cron] autoDream failed', e.message)
        }
      }
    } catch (e) {
      console.warn('[panda-cron] tick error', e.message)
    } finally {
      _running = false
    }
  }

  _timer = setInterval(tick, intervalMs)
  if (_timer.unref) _timer.unref()
  const boot = setTimeout(tick, 8000)
  if (boot.unref) boot.unref()
  console.log('[panda-cron] scheduler started interval=' + intervalMs + 'ms dreamEvery=' + dreamEveryMs + 'ms')
  return { ok: true, intervalMs, dreamEveryMs }
}

function stopBackgroundScheduler () {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}

module.exports = {
  createCron,
  deleteCron,
  listCron,
  tickCron,
  parseEvery,
  startBackgroundScheduler,
  stopBackgroundScheduler
}
