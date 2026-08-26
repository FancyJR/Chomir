/**
 * 轻量工具观测轨迹（对标「behaviorTrace」传言的真实可用子集）
 * 仅本地 jsonl，不杀进程、不广播兄弟 Agent。
 */

const fsp = require('fs').promises
const path = require('path')

async function appendToolTrace (projectRoot, sessionId, entry) {
  if (process.env.PANDA_TOOL_TRACE === '0') return
  try {
    const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
    const dir = path.resolve(projectRoot, '.panda', 'sessions', sid)
    await fsp.mkdir(dir, { recursive: true })
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry || {})) + '\n'
    await fsp.appendFile(path.join(dir, 'tool-trace.jsonl'), line, 'utf8')
  } catch (e) { /* ignore */ }
}

module.exports = { appendToolTrace }
