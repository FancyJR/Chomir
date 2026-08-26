/**
 * PowerShell 只读 / acceptEdits 轻量判定（对齐 Bash readOnly 厚度，非完整 AST）
 * 复合：按 ; 与 | 分段，全段合格才放行。
 */

const bashReadOnly = require('./bashReadOnly')

const READONLY_CMDLETS = new Set([
  'get-childitem', 'gci', 'ls', 'dir',
  'get-content', 'gc', 'cat', 'type',
  'get-item', 'gi',
  'get-location', 'gl', 'pwd',
  'get-process', 'gps',
  'get-service',
  'get-command', 'gcm',
  'get-help', 'help', 'man',
  'get-date',
  'get-host',
  'get-member', 'gm',
  'get-variable', 'gv',
  'test-path',
  'resolve-path',
  'select-string', 'sls',
  'select-object', 'select',
  'where-object', 'where', '?',
  'foreach-object', '%',
  'measure-object', 'measure',
  'sort-object', 'sort',
  'group-object', 'group',
  'format-table', 'ft',
  'format-list', 'fl',
  'format-wide', 'fw',
  'out-string', 'out-null',
  'write-output', 'echo', 'write-host', 'write-information',
  'convertto-json', 'convertfrom-json',
  'convertto-csv', 'convertfrom-csv',
  'compare-object',
  'measure-command'
])

const ACCEPT_EDITS_CMDLETS = new Set([
  'new-item', 'ni',
  'remove-item', 'ri', 'rm', 'rmdir', 'del',
  'copy-item', 'cpi', 'copy', 'cp',
  'move-item', 'mi', 'mv', 'move',
  'set-content', 'sc',
  'add-content', 'ac',
  'clear-content',
  'rename-item', 'rni', 'ren'
])

function splitPsSegments (command) {
  const raw = String(command || '').trim()
  if (!raw) return []
  // 粗分：; 与 |（引号内可能误伤，可接受的 lite）
  return raw.split(/[;|]/).map(s => s.trim()).filter(Boolean)
}

function firstToken (seg) {
  const s = String(seg || '').replace(/^\s*&?\s*/, '').trim()
  const m = s.match(/^([^\s(]+)/)
  return m ? m[1].replace(/^.*[\\/]/, '').toLowerCase() : ''
}

function isReadOnlySegment (segment) {
  const raw = String(segment || '').trim()
  if (!raw) return false
  // 重定向到文件 → 非只读
  if (/(^|[^2])>\s*(?!\$null)/i.test(raw) || />>/.test(raw) || /\|\s*out-file\b/i.test(raw)) {
    return false
  }
  if (/\bset-content\b|\badd-content\b|\bnew-item\b|\bremove-item\b|\bcopy-item\b|\bmove-item\b/i.test(raw)) {
    return false
  }
  const tok = firstToken(raw)
  if (READONLY_CMDLETS.has(tok)) return true
  // 外部命令：复用 bash 只读判定（git / rg / npm ls …）
  if (/^[a-z0-9._+-]+$/i.test(tok) && !tok.includes('-')) {
    return bashReadOnly.isReadOnlyBash(raw)
  }
  // pwsh -Command 外层已剥；裸 git/npm 等
  return bashReadOnly.isReadOnlyBash(raw)
}

function isAcceptEditsSegment (segment) {
  const tok = firstToken(segment)
  if (ACCEPT_EDITS_CMDLETS.has(tok)) return true
  return bashReadOnly.isAcceptEditsBash(String(segment || ''))
}

function isReadOnlyPowerShell (command) {
  const segs = splitPsSegments(command)
  if (!segs.length) return false
  return segs.every(isReadOnlySegment)
}

function isAcceptEditsPowerShell (command) {
  const segs = splitPsSegments(command)
  if (!segs.length) return false
  return segs.every(seg => isAcceptEditsSegment(seg) || isReadOnlySegment(seg))
}

module.exports = {
  isReadOnlyPowerShell,
  isAcceptEditsPowerShell,
  splitPsSegments
}
