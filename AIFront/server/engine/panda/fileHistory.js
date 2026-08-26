/**
 * 文件历史快照 / 回退（对标 panda-code fileHistory）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function historyDir (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'file-history')
}

function safeKey (rel) {
  return String(rel || '').replace(/[\\/]/g, '__')
}

async function snapshotBeforeWrite (projectRoot, relPath, contentBefore) {
  const dir = historyDir(projectRoot)
  await fsp.mkdir(dir, { recursive: true })
  const stamp = Date.now().toString(16)
  const key = safeKey(relPath)
  const metaPath = path.join(dir, 'index.json')
  let index = []
  try {
    index = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
  } catch (e) {
    index = []
  }
  const snapFile = `${key}.${stamp}.snap`
  await fsp.writeFile(path.join(dir, snapFile), contentBefore == null ? '' : String(contentBefore), 'utf8')
  index.push({
    id: stamp,
    file: relPath,
    snap: snapFile,
    at: new Date().toISOString()
  })
  // 只保留最近 80 条
  if (index.length > 80) {
    const drop = index.splice(0, index.length - 80)
    for (const d of drop) {
      try { await fsp.unlink(path.join(dir, d.snap)) } catch (e) { /* ignore */ }
    }
  }
  await fsp.writeFile(metaPath, JSON.stringify(index, null, 2), 'utf8')
  return stamp
}

async function listHistory (projectRoot, relPath, limit = 20) {
  const metaPath = path.join(historyDir(projectRoot), 'index.json')
  let index = []
  try {
    index = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
  } catch (e) {
    return []
  }
  const filtered = relPath ? index.filter(i => i.file === relPath) : index
  return filtered.slice(-limit).reverse()
}

async function undoLast (projectRoot, relPath) {
  const dir = historyDir(projectRoot)
  const metaPath = path.join(dir, 'index.json')
  let index = []
  try {
    index = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
  } catch (e) {
    return { ok: false, message: '没有可回退的历史' }
  }
  let idx = -1
  for (let i = index.length - 1; i >= 0; i--) {
    if (!relPath || index[i].file === relPath) {
      idx = i
      break
    }
  }
  if (idx < 0) return { ok: false, message: '没有可回退的历史' }
  const entry = index[idx]
  const snapPath = path.join(dir, entry.snap)
  const content = await fsp.readFile(snapPath, 'utf8')
  const target = path.resolve(projectRoot, entry.file)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, content, 'utf8')
  index.splice(idx, 1)
  await fsp.writeFile(metaPath, JSON.stringify(index, null, 2), 'utf8')
  try { await fsp.unlink(snapPath) } catch (e) { /* ignore */ }
  return { ok: true, file: entry.file, message: `已回退 ${entry.file} 到快照 ${entry.id}` }
}

function unifiedDiff (file, before, after, maxLines = 120) {
  const a = String(before || '').split(/\n/)
  const b = String(after || '').split(/\n/)
  const lines = [`--- a/${file}`, `+++ b/${file}`]
  // 简易行 diff：窗口前瞻在「相似重复行」场景下可能两边都不前进，必须强制推进，否则死循环拖死 Edit
  let i = 0
  let j = 0
  let guard = 0
  const guardMax = a.length + b.length + 8
  while (i < a.length || j < b.length) {
    if (++guard > guardMax) {
      lines.push('…[diff aborted: progress guard]')
      break
    }
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
      continue
    }
    const hunkA = []
    const hunkB = []
    const startA = i + 1
    const startB = j + 1
    const i0 = i
    const j0 = j
    while (i < a.length && (j >= b.length || a[i] !== b[j])) {
      let found = -1
      for (let k = j; k < Math.min(b.length, j + 8); k++) {
        if (a[i] === b[k]) { found = k; break }
      }
      if (found !== -1 && found !== j) break
      hunkA.push('-' + a[i])
      i++
      if (hunkA.length + hunkB.length > maxLines) break
    }
    while (j < b.length && (i >= a.length || a[i] !== b[j])) {
      let found = -1
      for (let k = i; k < Math.min(a.length, i + 8); k++) {
        if (b[j] === a[k]) { found = k; break }
      }
      if (found !== -1 && found !== i) break
      hunkB.push('+' + b[j])
      j++
      if (hunkA.length + hunkB.length > maxLines) break
    }
    // 前瞻导致双 break、零推进 → 强制吃掉一侧，避免死循环
    if (i === i0 && j === j0) {
      if (i < a.length) {
        hunkA.push('-' + a[i])
        i++
      }
      if (j < b.length && (hunkA.length === 0 || a[i0] !== b[j0])) {
        hunkB.push('+' + b[j])
        j++
      }
    }
    if (hunkA.length || hunkB.length) {
      lines.push(`@@ -${startA},${hunkA.length || 0} +${startB},${hunkB.length || 0} @@`)
      lines.push(...hunkA, ...hunkB)
    }
    if (lines.length > maxLines + 10) {
      lines.push('…[diff truncated]')
      break
    }
  }
  if (lines.length <= 2) return `(no textual diff for ${file})`
  return lines.join('\n')
}

async function showDiff (projectRoot, relPath) {
  const list = await listHistory(projectRoot, relPath || '', 1)
  if (!list.length) {
    // 无快照时退回 git diff
    const { spawnSync } = require('child_process')
    const args = relPath ? ['diff', '--', relPath] : ['diff']
    const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    const out = ((r.stdout || '') + (r.stderr || '')).trim()
    return out
      ? { ok: true, source: 'git', content: out.slice(0, 12000) }
      : { ok: false, message: '无文件历史快照，且 git diff 为空。改文件后会自动快照。' }
  }
  const entry = list[0]
  const snapPath = path.join(historyDir(projectRoot), entry.snap)
  let before = ''
  try {
    before = await fsp.readFile(snapPath, 'utf8')
  } catch (e) {
    return { ok: false, message: '快照丢失：' + entry.snap }
  }
  const target = path.resolve(projectRoot, entry.file)
  let after = ''
  try {
    after = await fsp.readFile(target, 'utf8')
  } catch (e) {
    after = ''
  }
  return {
    ok: true,
    source: 'snapshot',
    file: entry.file,
    at: entry.at,
    content: unifiedDiff(entry.file, before, after, 200)
  }
}

module.exports = {
  snapshotBeforeWrite,
  listHistory,
  undoLast,
  unifiedDiff,
  showDiff
}
