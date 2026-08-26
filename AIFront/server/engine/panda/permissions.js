/**
 * Panda 风格权限闸门（精简移植自 panda-code/utils/permissions）
 * - 写文件 / 终端默认需在白名单路径内（项目根 + config.extraRoots）
 * - 危险 shell 命令拒绝（config.sandbox !== false 时）
 */

const fs = require('fs')
const path = require('path')

const DANGEROUS_SHELL = [
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(?!null\b)/i,
  /\bchmod\s+777\b/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+push\s+-f\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i
]

/** @type {Map<string, { mtime: number, roots: string[] }>} */
const extraRootsCache = new Map()

function loadExtraRoots (projectRoot) {
  const cfgPath = path.resolve(projectRoot, '.panda', 'config.json')
  let mtime = 0
  try {
    mtime = fs.statSync(cfgPath).mtimeMs
  } catch (e) {
    return []
  }
  const hit = extraRootsCache.get(projectRoot)
  if (hit && hit.mtime === mtime) return hit.roots
  let roots = []
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    roots = Array.isArray(cfg.extraRoots)
      ? cfg.extraRoots.map(r => path.resolve(String(r))).filter(Boolean)
      : []
  } catch (e) {
    roots = []
  }
  extraRootsCache.set(projectRoot, { mtime, roots })
  return roots
}

function isSandboxEnabled (projectRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(projectRoot, '.panda', 'config.json'), 'utf8'))
    if (cfg.sandbox === false) return false
  } catch (e) { /* default on */ }
  return true
}

function tryResolveInRoot (root, relOrAbs) {
  const base = path.resolve(root)
  const target = path.isAbsolute(relOrAbs)
    ? path.resolve(relOrAbs)
    : path.resolve(base, relOrAbs)
  const rel = path.relative(base, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return { root: base, target, rel: rel.split(path.sep).join('/') }
}

function resolveUnderRoot (projectRoot, relOrAbs) {
  const roots = [path.resolve(projectRoot)].concat(loadExtraRoots(projectRoot))
  let resolved = null
  for (const root of roots) {
    resolved = tryResolveInRoot(root, relOrAbs)
    if (resolved) break
  }
  if (!resolved) {
    return {
      ok: false,
      reason: '路径越界：禁止访问项目根目录（及 /add-dir 附加根）之外的文件',
      target: path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(projectRoot, relOrAbs)
    }
  }
  const { target, rel } = resolved
  const base = path.basename(target)
  if (base === '.env' || base === '.env.local' || base.endsWith('.pem') || base.endsWith('.key')) {
    return { ok: false, reason: '禁止读写密钥/环境变量敏感文件：' + base, target }
  }
  // 密钥文件由 sensitivePathDeny / pathSafety 处理；此处仅越界检查
  return { ok: true, target, rel }
}

function canReadFile (projectRoot, filePath) {
  return resolveUnderRoot(projectRoot, filePath)
}

function canWriteFile (projectRoot, filePath, mode) {
  const r = resolveUnderRoot(projectRoot, filePath)
  if (!r.ok) return r
  // path safety（.git 等）由 permissionRules + pathSafety 以 ask 处理，此处不硬拒
  if ((mode === 'plan' || mode === 'verify') && !String(r.rel).startsWith('.panda/')) {
    return {
      ok: false,
      reason: mode === 'verify'
        ? 'Verify 模式禁止修改项目文件；仅允许 bash 写 /tmp 临时脚本'
        : '当前为 Plan Mode，禁止修改业务代码；请先 ExitPlanMode（`.panda/` 与 scratchpad 除外）',
      target: r.target
    }
  }
  return r
}

/** 是否在项目根或 extraRoots 工作区内（对齐 acceptEdits CWD 闸） */
function isInWorkingDir (projectRoot, filePath) {
  if (!filePath) return true
  const r = resolveUnderRoot(projectRoot, filePath)
  return !!r.ok
}

function canRunBash (command, mode, projectRoot) {
  const cmd = String(command || '').trim()
  if (!cmd) return { ok: false, reason: '空命令' }
  if (mode === 'plan') {
    if (!/^(ls|pwd|cat|head|tail|wc|find|rg|grep|git\s+(status|diff|log|show)|node\s+-v|npm\s+(-v|list))\b/i.test(cmd)) {
      return { ok: false, reason: 'Plan Mode 下仅允许只读命令（ls/cat/git status 等）' }
    }
  }
  if (mode === 'verify') {
    if (/\bgit\s+(add|commit|push|reset|checkout|merge|rebase|tag|branch\s+-D)\b/i.test(cmd)) {
      return { ok: false, reason: 'Verify 模式禁止 git 写操作' }
    }
    if (/\bnpm\s+(i|install|uninstall|ci)\b/i.test(cmd) || /\byarn\s+(add|remove)\b/i.test(cmd) || /\bpnpm\s+(add|remove|i)\b/i.test(cmd)) {
      return { ok: false, reason: 'Verify 模式禁止安装/卸载依赖' }
    }
    if (/\b(rm\s+-rf|mkdir\s+-p)\s+(src|server|public)\b/i.test(cmd)) {
      return { ok: false, reason: 'Verify 模式禁止改动项目目录结构' }
    }
  }
  const sandboxOn = projectRoot == null ? true : isSandboxEnabled(projectRoot)
  if (sandboxOn) {
    for (const re of DANGEROUS_SHELL) {
      if (re.test(cmd)) {
        return { ok: false, reason: '拒绝执行危险命令：' + cmd.slice(0, 80) }
      }
    }
  }
  return { ok: true }
}

module.exports = {
  resolveUnderRoot,
  canReadFile,
  canWriteFile,
  canRunBash,
  isInWorkingDir,
  loadExtraRoots,
  isSandboxEnabled,
  DANGEROUS_SHELL
}
