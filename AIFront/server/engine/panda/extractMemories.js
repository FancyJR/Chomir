/**
 * 记忆抽取（对标 panda-code services/extractMemories）
 * 回合结束后，用短 LLM 从对话抽取可复用记忆，追加到 .panda/memory/auto.md
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { callDeepseekJson } = require('../shared-llm')

function autoMemoryPath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'memory', 'auto.md')
}

async function isEnabled (projectRoot) {
  try {
    const cfg = JSON.parse(await fsp.readFile(path.resolve(projectRoot, '.panda', 'config.json'), 'utf8'))
    if (cfg.autoMemory === false || cfg.autoMemoryEnabled === false) return false
  } catch (e) { /* default on */ }
  // 默认开启轻量抽取；可用 PANDA_AUTO_MEMORY=0 关闭
  if (process.env.PANDA_AUTO_MEMORY === '0' || process.env.CLAW_AUTO_MEMORY === '0') return false
  return true
}

function recentDialogue (messages, limit) {
  const out = []
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const m = list[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '')
    if (!text || text.startsWith('# Hook') || text.startsWith('Keep working')) continue
    out.unshift({ role: m.role, text: String(text).slice(0, 1200) })
  }
  return out
}

/**
 * @returns {Promise<{ extracted: number, notes: string[] }>}
 */
async function extractMemories (projectRoot, runtime, messages) {
  if (!(await isEnabled(projectRoot))) {
    return { extracted: 0, notes: [], skipped: 'disabled' }
  }
  if (runtime && runtime.didMemoryAppend) {
    return { extracted: 0, notes: [], skipped: 'already_wrote' }
  }
  const dialogue = recentDialogue(messages, 8)
  if (dialogue.length < 2) {
    return { extracted: 0, notes: [], skipped: 'too_short' }
  }

  let data
  try {
    data = await callDeepseekJson(
      [
        '你是记忆抽取器。从对话中提取值得跨会话保留的项目事实（用户偏好、架构约定、踩坑、路径约定）。',
        '输出 JSON：{ "memories": [ "一条简短记忆", ... ] }',
        '若无可保留内容，返回 { "memories": [] }。不要编造。最多 3 条，每条 ≤120 字。'
      ].join('\n'),
      dialogue.map(d => d.role.toUpperCase() + ': ' + d.text).join('\n\n')
    )
  } catch (e) {
    return { extracted: 0, notes: [], error: e.message }
  }

  const memories = Array.isArray(data && data.memories)
    ? data.memories.map(m => String(m || '').trim()).filter(Boolean).slice(0, 3)
    : []
  if (!memories.length) return { extracted: 0, notes: [] }

  const file = autoMemoryPath(projectRoot)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let prev = ''
  try {
    prev = await fsp.readFile(file, 'utf8')
  } catch (e) {
    prev = '# Auto Memory\n\n'
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const block = memories.map(m => '- (' + stamp + ') ' + m).join('\n') + '\n'
  // 去重：已有近似句跳过
  const fresh = memories.filter(m => !prev.includes(m.slice(0, 40)))
  if (!fresh.length) return { extracted: 0, notes: memories, skipped: 'dup' }
  const append = fresh.map(m => '- (' + stamp + ') ' + m).join('\n') + '\n'
  await fsp.writeFile(file, prev.trimEnd() + '\n' + append, 'utf8')

  // 确保索引结构存在；全文并入 topics 由 autoDream 空闲完成
  try {
    await require('./memoryIndex').migrateIfNeeded(projectRoot)
  } catch (e) { /* ignore */ }

  return { extracted: fresh.length, notes: fresh }
}

module.exports = {
  extractMemories,
  autoMemoryPath,
  isEnabled
}
