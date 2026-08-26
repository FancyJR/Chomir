/**
 * 斜杠命令入口：优先走扩表注册，兼容旧逻辑
 */

const { runSlashCommand, listCommandNames } = require('./slashRegistry')

/**
 * @returns {null | { handled: true, reply: string, sideEffects?: object }}
 */
async function tryHandleSlash (message, runtime) {
  const text = String(message || '').trim()
  if (!text.startsWith('/')) return null
  const [cmd, ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  const hit = await runSlashCommand(cmd, arg, runtime)
  if (hit) return hit
  return {
    handled: true,
    reply: `未知命令 /${cmd}。输入 /help 查看 ${listCommandNames().length} 条命令。`
  }
}

module.exports = {
  tryHandleSlash,
  listCommandNames
}
