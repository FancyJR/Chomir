/**
 * Path safety（对齐 panda-code/utils/permissions/filesystem.ts）
 * 危险路径 → ask + safetyCheck（bypass-immune），不是硬 deny。
 * classifierApprovable:true → auto 模式可交给 LLM 分类器；false → 始终人工确认。
 */

const path = require('path')

const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude']

const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json'
]

function normalizeCase (s) {
  return String(s || '').toLowerCase()
}

/**
 * 可疑 Windows 路径模式（对齐 hasSuspiciousWindowsPathPattern）
 * classifierApprovable: false
 */
function hasSuspiciousWindowsPathPattern (raw) {
  const p = String(raw || '')
  if (!p) return false

  // NTFS ADS：盘符后的冒号（简版：非盘符位置的 :）
  // 在 darwin/linux 上也做检测（NTFS 可挂载）；盘符形如 C:\ 跳过前两位
  const colonIdx = p.indexOf(':', 2)
  if (colonIdx !== -1 && /::\$DATA\b/i.test(p)) return true
  if (colonIdx !== -1 && process.platform === 'win32') return true

  // 8.3 short names
  if (/~\d/.test(p)) return true

  // Long path prefixes
  if (
    p.startsWith('\\\\?\\') ||
    p.startsWith('\\\\.\\') ||
    p.startsWith('//?/') ||
    p.startsWith('//./')
  ) {
    return true
  }

  // Trailing dots/spaces（Windows 会剥离）
  if (/[.\s]+$/.test(p)) return true

  // DOS device names
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(p)) return true

  // Three+ consecutive dots as path component
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true

  // UNC
  if (p.startsWith('\\\\') || p.startsWith('//')) return true

  return false
}

/**
 * 危险目录/文件（对齐 isDangerousFilePathToAutoEdit）
 */
function isDangerousFilePathToAutoEdit (filePath) {
  const raw = String(filePath || '')
  if (!raw) return false

  if (raw.startsWith('\\\\') || raw.startsWith('//')) return true

  const abs = path.resolve(raw)
  const segments = abs.split(/[/\\]/)

  for (let i = 0; i < segments.length; i++) {
    const n = normalizeCase(segments[i])
    for (const dir of DANGEROUS_DIRECTORIES) {
      if (n !== normalizeCase(dir)) continue
      if (dir === '.claude') {
        const next = segments[i + 1]
        if (next && normalizeCase(next) === 'worktrees') break
      }
      return true
    }
  }

  const base = segments[segments.length - 1] || ''
  const nb = normalizeCase(base)
  if (DANGEROUS_FILES.some(f => normalizeCase(f) === nb)) return true

  return false
}

/**
 * Claude/Panda 配置路径（对齐 isClaudeConfigFilePath 精髓）
 */
function isClaudeConfigFilePath (filePath) {
  const abs = path.resolve(String(filePath || ''))
  return /(^|[/\\])\.claude[/\\](settings|commands|agents|skills)([/\\.]|$)/i.test(abs) ||
    /(^|[/\\])\.panda[/\\](config|permissions|hooks|mcp)\.json$/i.test(abs)
}

/**
 * @returns {{ safe: true } | { safe: false, message: string, classifierApprovable: boolean }}
 */
function checkPathSafetyForAutoEdit (filePath) {
  const raw = String(filePath || '')
  if (!raw) return { safe: true }

  const pathsToCheck = [raw]
  try {
    const resolved = path.resolve(raw)
    if (resolved !== raw) pathsToCheck.push(resolved)
  } catch (e) { /* ignore */ }

  for (const p of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(p)) {
      return {
        safe: false,
        message: '可疑 Windows/UNC 路径模式，需人工确认：' + raw.slice(0, 160),
        classifierApprovable: false
      }
    }
  }

  for (const p of pathsToCheck) {
    if (isClaudeConfigFilePath(p)) {
      return {
        safe: false,
        message: 'Claude/Panda 配置路径需确认：' + path.resolve(p),
        classifierApprovable: true
      }
    }
  }

  for (const p of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(p)) {
      return {
        safe: false,
        message: '敏感文件/目录写操作需确认：' + path.resolve(p),
        classifierApprovable: true
      }
    }
  }

  return { safe: true }
}

function isWriteTool (toolName) {
  return /^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(String(toolName || ''))
}

module.exports = {
  DANGEROUS_DIRECTORIES,
  DANGEROUS_FILES,
  checkPathSafetyForAutoEdit,
  hasSuspiciousWindowsPathPattern,
  isDangerousFilePathToAutoEdit,
  isWriteTool
}
