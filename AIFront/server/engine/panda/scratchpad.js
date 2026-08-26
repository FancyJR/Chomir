/**
 * Scratchpad（对标 panda-code tengu_scratch / getScratchpadDir）
 * 会话级可写草稿目录，供 Agent / Swarm worker 记笔记，不污染业务树。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function scratchpadDir (projectRoot, sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.resolve(projectRoot, '.panda', 'sessions', sid, 'scratchpad')
}

async function ensureScratchpad (projectRoot, sessionId) {
  const dir = scratchpadDir(projectRoot, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const readme = path.join(dir, 'README.md')
  if (!fs.existsSync(readme)) {
    await fsp.writeFile(
      readme,
      '# Scratchpad\n\n会话草稿区。可用 write_file / edit_file 写笔记、中间结果、计划草稿。\n',
      'utf8'
    )
  }
  return dir
}

function relativeScratchpad (projectRoot, sessionId) {
  return path.relative(projectRoot, scratchpadDir(projectRoot, sessionId)).split(path.sep).join('/')
}

function isUnderScratchpad (projectRoot, sessionId, absOrRel) {
  const root = scratchpadDir(projectRoot, sessionId)
  const target = path.isAbsolute(absOrRel)
    ? path.resolve(absOrRel)
    : path.resolve(projectRoot, absOrRel)
  const rel = path.relative(root, target)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function getScratchpadSection (projectRoot, sessionId) {
  if (!sessionId) return ''
  const rel = relativeScratchpad(projectRoot, sessionId)
  return [
    '# Scratchpad',
    '会话草稿目录（可写）：`' + rel + '`',
    '用 write_file/edit_file 在此记录中间笔记、对比方案、待办草稿；不要把临时笔记写进业务源码树。'
  ].join('\n')
}

module.exports = {
  scratchpadDir,
  ensureScratchpad,
  relativeScratchpad,
  isUnderScratchpad,
  getScratchpadSection
}
