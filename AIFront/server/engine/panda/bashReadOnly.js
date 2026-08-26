/**
 * Bash 只读 / acceptEdits 文件系统白名单（对齐 BashTool modeValidation + readOnly 精髓）
 * 复合命令：所有段都必须合格才放行（比上游 modeValidation「首段命中即放」更严、更安全）。
 */

const { splitBashSegments, baseCommand } = require('./bashSplit')

const ACCEPT_EDITS_CMDS = new Set([
  'mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'
])

/** 常见只读命令（精简自 READONLY_COMMANDS + git/rg 只读子命令） */
const READONLY_BASE = new Set([
  'ls', 'pwd', 'echo', 'printf', 'true', 'false', 'sleep', 'which', 'type', 'command',
  'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl',
  'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc', 'hostname', 'date', 'cal', 'uptime',
  'basename', 'dirname', 'realpath', 'readlink',
  'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand', 'fmt', 'comm', 'cmp', 'numfmt',
  'diff', 'test', '[', 'expr', 'seq', 'getconf', 'tsort', 'pr',
  'find', 'file', 'tree',
  'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack',
  'jq', 'yq',
  'node', // 仅 -v / --version / -p 短表达式在 isReadOnlySegment 再收窄；裸 node script 不放
  'npm', 'pnpm', 'yarn', // 仅 list / -v 等
  'python', 'python3', // 仅 -V / --version
  'git',
  'gh',
  'docker',
  'env', 'printenv',
  'whoami', 'groups'
])

const GIT_READONLY_SUB = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'describe', 'branch', 'tag', 'remote', 'stash', 'shortlog',
  'config', 'reflog', 'whatchanged', 'name-rev', 'cat-file', 'count-objects'
])

const NPM_READONLY_SUB = new Set([
  'ls', 'list', 'view', 'info', 'outdated', 'pack', 'explain', 'why', 'docs', 'repo', 'home'
])

const DOCKER_READONLY_SUB = new Set([
  'ps', 'images', 'image', 'inspect', 'logs', 'top', 'stats', 'version', 'info', 'history'
])

const GH_READONLY_SUB = new Set([
  'pr', 'issue', 'repo', 'status', 'api', 'run', 'release', 'gist', 'label', 'project'
])

function stripRedirectNoise (seg) {
  // 去掉尾部 2>/dev/null / >/dev/null / 2>&1（只读探测常见）
  return String(seg || '')
    .replace(/\s+2>&1\s*$/g, '')
    .replace(/\s+2?>\s*\/dev\/null\s*$/g, '')
    .replace(/\s+2?>&\s*1\s*$/g, '')
    .trim()
}

function tokensOf (seg) {
  return stripRedirectNoise(seg).replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '').split(/\s+/).filter(Boolean)
}

/**
 * 单段是否 acceptEdits 文件系统命令
 */
function isAcceptEditsSegment (segment) {
  const base = baseCommand(segment).replace(/^.*\//, '') // /bin/rm → rm
  return ACCEPT_EDITS_CMDS.has(base.toLowerCase())
}

/**
 * 单段是否只读
 */
function isReadOnlySegment (segment) {
  const raw = stripRedirectNoise(segment)
  if (!raw) return false
  // 输出重定向到非 /dev/null → 非只读
  if (/(^|[^2])>\s*(?!\/dev\/null)/.test(raw) || />>/.test(raw)) return false
  if (/\btee\b/i.test(raw)) return false

  const tokens = tokensOf(raw)
  if (!tokens.length) return false
  let base = tokens[0].replace(/^.*\//, '').toLowerCase()
  // `command -v` / `type`
  if (base === 'command' && tokens[1] === '-v') return true

  if (base === 'git') {
    const sub = (tokens[1] || '').toLowerCase()
    if (!GIT_READONLY_SUB.has(sub)) return false
    // git config 写：--unset / --add / 无 --get 且带赋值
    if (sub === 'config') {
      if (/\s--(unset|add|replace-all|remove-section)\b/i.test(raw)) return false
      if (!/\s--get(-all|-regexp)?\b/i.test(raw) && /[^=\s]=\S/.test(raw.replace(/^git\s+config\s+/i, ''))) {
        // git config user.name x 可能是写；保守：仅 --get* / -l / --list
        if (!/\s(-l|--list)\b/i.test(raw)) return false
      }
    }
    if (sub === 'stash') {
      const s2 = (tokens[2] || '').toLowerCase()
      if (s2 !== 'list' && s2 !== 'show') return false
    }
    if (sub === 'branch' && /\s(-d|-D|-m|-M|--delete|--move)\b/.test(raw)) return false
    if (sub === 'tag' && /\s(-d|-f|--delete|--force)\b/.test(raw)) return false
    if (sub === 'remote' && /\s(add|remove|rm|set-url|prune)\b/i.test(raw)) return false
    return true
  }

  if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    if (tokens.length === 1 || /^-v$|^--version$/.test(tokens[1] || '')) return true
    const sub = (tokens[1] || '').toLowerCase()
    return NPM_READONLY_SUB.has(sub)
  }

  if (base === 'docker') {
    const sub = (tokens[1] || '').toLowerCase()
    return DOCKER_READONLY_SUB.has(sub)
  }

  if (base === 'gh') {
    const sub = (tokens[1] || '').toLowerCase()
    if (!GH_READONLY_SUB.has(sub)) return false
    // gh 写操作粗拦
    if (/\b(create|close|merge|edit|delete|comment|ready|reopen)\b/i.test(raw)) return false
    return true
  }

  if (base === 'rg' || base === 'grep' || base === 'egrep' || base === 'fgrep') {
    // 禁止 -l 外的写？rg 本身只读；禁 --pre / -f 执行类由正则另做
    if (/\s--pre(=|\s)/i.test(raw)) return false
    return true
  }

  if (base === 'find') {
    if (/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/i.test(raw)) return false
    return true
  }

  if (base === 'node' || base === 'nodejs') {
    if (tokens.length === 1) return false
    if (/^(-v|--version|-p|-e)$/.test(tokens[1])) {
      // -e/-p 允许短只读表达式；禁 require('fs').write
      const rest = tokens.slice(2).join(' ')
      if (/^(-e|-p)$/.test(tokens[1]) && /\b(writeFile|appendFile|unlink|rmSync|mkdirSync|spawn|exec)\b/.test(rest)) {
        return false
      }
      return true
    }
    return false
  }

  if (base === 'python' || base === 'python3') {
    return tokens.length >= 2 && /^(-V|--version)$/.test(tokens[1])
  }

  if (base === 'ls') {
    // ls 无破坏性
    return true
  }

  if (READONLY_BASE.has(base)) {
    // echo 禁命令替换已在段内；保守允许
    if (base === 'echo' || base === 'printf') {
      if (/\$\(|`/.test(raw)) return false
    }
    return true
  }

  return false
}

/**
 * 整条命令是否 acceptEdits 可自动放行（所有段均为文件系统命令）
 */
function isAcceptEditsBash (command) {
  const segs = splitBashSegments(command)
  if (!segs.length) return false
  return segs.every(isAcceptEditsSegment)
}

/**
 * 整条命令是否只读（所有段只读）
 */
function isReadOnlyBash (command) {
  const segs = splitBashSegments(command)
  if (!segs.length) return false
  return segs.every(isReadOnlySegment)
}

module.exports = {
  ACCEPT_EDITS_CMDS,
  isAcceptEditsBash,
  isReadOnlyBash,
  isAcceptEditsSegment,
  isReadOnlySegment
}
