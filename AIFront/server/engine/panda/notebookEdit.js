/**
 * NotebookEdit（对标 panda-code NotebookEditTool）
 * 按 cell_id / 索引对 .ipynb 做 replace | insert | delete
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { canWriteFile } = require('./permissions')
const { snapshotBeforeWrite, unifiedDiff } = require('./fileHistory')

function cellSource (cell) {
  if (!cell) return ''
  if (Array.isArray(cell.source)) return cell.source.join('')
  return String(cell.source || '')
}

function setCellSource (cell, text) {
  // nbformat 常用按行数组（含换行）
  const lines = String(text || '').split(/(?<=\n)/)
  cell.source = lines.length === 1 && !String(text || '').endsWith('\n')
    ? [text]
    : (lines[lines.length - 1] === '' && lines.length > 1 ? lines.slice(0, -1).concat(['']) : lines)
  if (lines.length === 1) cell.source = [String(text || '')]
}

function findCellIndex (nb, cellId) {
  const cells = nb.cells || []
  if (cellId == null || cellId === '') return -1
  const id = String(cellId)
  // 数字索引
  if (/^\d+$/.test(id)) {
    const i = parseInt(id, 10)
    return i >= 0 && i < cells.length ? i : -1
  }
  for (let i = 0; i < cells.length; i++) {
    if (String(cells[i].id || '') === id) return i
  }
  return -1
}

function newCellId () {
  return 'cell-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 6)
}

/**
 * @param {object} args
 * @param {string} args.notebook_path
 * @param {string} [args.cell_id]
 * @param {string} [args.new_source]
 * @param {'code'|'markdown'} [args.cell_type]
 * @param {'replace'|'insert'|'delete'} [args.edit_mode]
 */
async function editNotebook (projectRoot, args, runtime) {
  const mode = (runtime && runtime.mode) || 'default'
  const gate = canWriteFile(projectRoot, args.notebook_path, mode)
  if (!gate.ok) return { ok: false, content: gate.reason }
  if (!String(gate.rel || '').endsWith('.ipynb')) {
    return { ok: false, content: 'notebook_edit 仅用于 .ipynb 文件' }
  }
  if (!fs.existsSync(gate.target)) {
    return { ok: false, content: '文件不存在：' + gate.rel }
  }

  const before = await fsp.readFile(gate.target, 'utf8')
  let nb
  try {
    nb = JSON.parse(before)
  } catch (e) {
    return { ok: false, content: '无效 notebook JSON：' + e.message }
  }
  if (!Array.isArray(nb.cells)) nb.cells = []

  const editMode = String(args.edit_mode || 'replace').toLowerCase()
  const cellId = args.cell_id
  let idx = findCellIndex(nb, cellId)

  if (editMode === 'delete') {
    if (idx < 0) return { ok: false, content: '找不到 cell：' + cellId }
    const removed = nb.cells.splice(idx, 1)[0]
    const after = JSON.stringify(nb, null, 1)
    await snapshotBeforeWrite(projectRoot, gate.rel, before)
    await fsp.writeFile(gate.target, after, 'utf8')
    return {
      ok: true,
      content: '已删除 cell ' + (removed.id || idx) + ' @ ' + gate.rel,
      meta: { file: gate.rel, changed: true, diff: unifiedDiff(gate.rel, before, after, 80) }
    }
  }

  if (editMode === 'insert') {
    const cellType = args.cell_type || 'code'
    if (cellType !== 'code' && cellType !== 'markdown') {
      return { ok: false, content: 'insert 需要 cell_type=code|markdown' }
    }
    const cell = {
      id: newCellId(),
      cell_type: cellType,
      metadata: {},
      source: []
    }
    if (cellType === 'code') {
      cell.outputs = []
      cell.execution_count = null
    }
    setCellSource(cell, args.new_source == null ? '' : args.new_source)
    const insertAt = idx < 0 ? 0 : idx + 1
    nb.cells.splice(insertAt, 0, cell)
    const after = JSON.stringify(nb, null, 1)
    await snapshotBeforeWrite(projectRoot, gate.rel, before)
    await fsp.writeFile(gate.target, after, 'utf8')
    return {
      ok: true,
      content: '已插入 ' + cellType + ' cell `' + cell.id + '` at index ' + insertAt + ' @ ' + gate.rel,
      meta: { file: gate.rel, changed: true, cell_id: cell.id, diff: unifiedDiff(gate.rel, before, after, 80) }
    }
  }

  // replace
  if (idx < 0) {
    if (nb.cells.length === 1 && (cellId == null || cellId === '')) idx = 0
    else return { ok: false, content: '找不到 cell：' + (cellId == null ? '(请传 cell_id 或索引)' : cellId) }
  }
  const cell = nb.cells[idx]
  if (args.cell_type === 'code' || args.cell_type === 'markdown') {
    cell.cell_type = args.cell_type
    if (cell.cell_type === 'code' && !Array.isArray(cell.outputs)) {
      cell.outputs = []
      cell.execution_count = null
    }
  }
  setCellSource(cell, args.new_source == null ? '' : args.new_source)
  const after = JSON.stringify(nb, null, 1)
  await snapshotBeforeWrite(projectRoot, gate.rel, before)
  await fsp.writeFile(gate.target, after, 'utf8')
  return {
    ok: true,
    content: '已替换 cell `' + (cell.id || idx) + '` @ ' + gate.rel + '\n\n' + cellSource(cell).slice(0, 500),
    meta: { file: gate.rel, changed: true, cell_id: cell.id, diff: unifiedDiff(gate.rel, before, after, 80) }
  }
}

module.exports = {
  editNotebook,
  findCellIndex,
  cellSource
}
