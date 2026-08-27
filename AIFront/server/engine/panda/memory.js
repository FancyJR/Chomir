/**
 * 跨会话项目记忆 + 项目约定层级加载
 * 对齐 panda-code/utils/claudemd.ts（getMemoryFiles）：
 *
 * 1. User：~/.claude/CLAUDE.md、~/.panda/Panda.md + rules 递归
 * 2. Project：从 projectRoot 向上到文件系统根
 *    每层：Panda.md/CLAUDE.md/AGENTS.md、.claude 与 .panda 下同名、rules 子树全部 .md
 * 3. Local：同层 Panda.local.md / CLAUDE.local.md（后加载 = 更高优先级）
 * 4. @include：@path / @./rel / @~/home / @/abs（代码块内忽略；环检测；深度上限）
 *
 * 顺序：根目录 → 当前目录；同层 Local 最后。模型对靠后的内容更敏感。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

const MAX_FILE_CHARS = 12000
const MAX_TOTAL_CHARS = 48000
const MAX_INCLUDE_DEPTH = 5

const TEXT_EXTS = new Set([
  '.md', '.txt', '.text', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.sh', '.bash', '.zsh', '.env', '.gitignore', '.editorconfig'
])

const PROJECT_DOC_NAMES = [
  'Panda.md', 'PANDA.md', 'CLAUDE.md', 'AGENTS.md'
]
const LOCAL_DOC_NAMES = [
  'Panda.local.md', 'PANDA.local.md', 'CLAUDE.local.md', 'AGENTS.local.md'
]
const NESTED_PROJECT_RELS = [
  path.join('.panda', 'Panda.md'),
  path.join('.panda', 'PANDA.md'),
  path.join('.claude', 'CLAUDE.md')
]

function memoryPath (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'MEMORY.md')
}

async function ensureDir (projectRoot) {
  await fsp.mkdir(path.resolve(projectRoot, '.panda'), { recursive: true })
}

function normalizePathKey (p) {
  try {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase()
  } catch (e) {
    return String(p || '').toLowerCase()
  }
}

function expandIncludePath (raw, baseDir) {
  let p = String(raw || '').replace(/\\ /g, ' ').trim()
  if (!p) return null
  const hash = p.indexOf('#')
  if (hash !== -1) p = p.slice(0, hash)
  if (!p) return null
  if (p.startsWith('~/')) {
    return path.resolve(os.homedir(), p.slice(2))
  }
  if (path.isAbsolute(p)) return path.resolve(p)
  // @path 与 @./path 均相对 baseDir（含文件所在目录）
  if (p.startsWith('./')) p = p.slice(2)
  return path.resolve(baseDir, p)
}

function isValidIncludeToken (p) {
  if (!p || p === '/') return false
  if (p.startsWith('./') || p.startsWith('~/')) return true
  if (p.startsWith('/') && p.length > 1) return true
  // bare relative: must look like a path token
  return /^[a-zA-Z0-9._-]/.test(p) && !p.startsWith('@')
}

/**
 * 从正文提取 @include（忽略 fenced code / inline code / HTML 注释）
 */
function extractIncludePaths (content, baseFilePath) {
  let text = String(content || '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`[^`\n]+`/g, ' ')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')

  const baseDir = path.dirname(baseFilePath)
  const found = []
  const seen = new Set()
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    let token = m[1]
    if (!token) continue
    if (!isValidIncludeToken(token.replace(/\\ /g, ' ').split('#')[0])) continue
    const abs = expandIncludePath(token, baseDir)
    if (!abs) continue
    const key = normalizePathKey(abs)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(abs)
  }
  return found
}

function stripFrontmatter (raw) {
  const s = String(raw || '')
  if (!s.startsWith('---')) return s
  const end = s.indexOf('\n---', 3)
  if (end === -1) return s
  const after = s.slice(end + 4)
  return after.replace(/^\r?\n/, '')
}

async function readRawFile (filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (ext && !TEXT_EXTS.has(ext)) return null
    const raw = await fsp.readFile(filePath, 'utf8')
    if (!raw || !String(raw).trim()) return null
    return raw
  } catch (e) {
    return null
  }
}

/**
 * @returns {Promise<Array<{ path: string, label: string, content: string, type: string }>>}
 */
async function processMemoryFile (filePath, type, processedPaths, depth, budget) {
  const key = normalizePathKey(filePath)
  if (processedPaths.has(key) || depth > MAX_INCLUDE_DEPTH) return []
  if (budget.used >= MAX_TOTAL_CHARS) return []

  const ext = path.extname(filePath).toLowerCase()
  if (ext && !TEXT_EXTS.has(ext)) return []

  processedPaths.add(key)
  const raw = await readRawFile(filePath)
  if (!raw) return []

  let body = stripFrontmatter(raw).trim()
  if (!body) return []

  const label = type + ': ' + filePath
  const sliceBudget = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - budget.used)
  if (sliceBudget <= 0) return []
  if (body.length > sliceBudget) {
    body = body.slice(0, sliceBudget) + '\n…[截断]'
  }
  budget.used += body.length

  const entries = [{
    path: filePath,
    label,
    content: body,
    type
  }]

  if (depth >= MAX_INCLUDE_DEPTH) return entries

  const includes = extractIncludePaths(body, filePath)
  for (const inc of includes) {
    if (budget.used >= MAX_TOTAL_CHARS) break
    // 仅允许项目树 / home /tmp 类文本；越界仍可读但计入 processed
    const nested = await processMemoryFile(
      inc,
      type + '-include',
      processedPaths,
      depth + 1,
      budget
    )
    entries.push(...nested)
  }
  return entries
}

async function processMdRules (rulesDir, type, processedPaths, budget, visitedDirs) {
  const dirKey = normalizePathKey(rulesDir)
  if (visitedDirs.has(dirKey)) return []
  visitedDirs.add(dirKey)
  if (budget.used >= MAX_TOTAL_CHARS) return []

  let entries
  try {
    entries = await fsp.readdir(rulesDir, { withFileTypes: true })
  } catch (e) {
    return []
  }

  const result = []
  // 稳定顺序：先文件名排序，目录与文件分开处理
  const dirs = []
  const files = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(rulesDir, ent.name)
    let isDir = ent.isDirectory()
    let isFile = ent.isFile()
    if (ent.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch (e) {
        continue
      }
    }
    if (isDir) dirs.push(full)
    else if (isFile && /\.md$/i.test(ent.name)) files.push(full)
  }
  files.sort()
  dirs.sort()

  for (const f of files) {
    if (budget.used >= MAX_TOTAL_CHARS) break
    result.push(...await processMemoryFile(f, type, processedPaths, 0, budget))
  }
  for (const d of dirs) {
    if (budget.used >= MAX_TOTAL_CHARS) break
    result.push(...await processMdRules(d, type, processedPaths, budget, visitedDirs))
  }
  return result
}

/** 从 cwd 向上收集目录：返回 [root..., cwd]（根在前） */
function collectAncestorDirs (startDir) {
  const dirs = []
  let cur = path.resolve(startDir)
  const { root } = path.parse(cur)
  const seen = new Set()
  while (true) {
    const key = normalizePathKey(cur)
    if (seen.has(key)) break
    seen.add(key)
    dirs.push(cur)
    if (cur === root) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs.reverse()
}

async function loadDocsInDir (dir, processedPaths, budget, opts = {}) {
  const result = []
  const { loadProject = true, loadLocal = true, loadRules = true } = opts

  if (loadProject) {
    for (const name of PROJECT_DOC_NAMES) {
      result.push(...await processMemoryFile(
        path.join(dir, name), 'Project', processedPaths, 0, budget
      ))
    }
    for (const rel of NESTED_PROJECT_RELS) {
      result.push(...await processMemoryFile(
        path.join(dir, rel), 'Project', processedPaths, 0, budget
      ))
    }
  }

  if (loadRules) {
    const visited = new Set()
    result.push(...await processMdRules(
      path.join(dir, '.claude', 'rules'), 'ProjectRules', processedPaths, budget, visited
    ))
    result.push(...await processMdRules(
      path.join(dir, '.panda', 'rules'), 'ProjectRules', processedPaths, budget, visited
    ))
  }

  // Local 覆盖：同层最后加载
  if (loadLocal) {
    for (const name of LOCAL_DOC_NAMES) {
      result.push(...await processMemoryFile(
        path.join(dir, name), 'Local', processedPaths, 0, budget
      ))
    }
  }

  return result
}

/**
 * 加载完整约定层级（对标 getMemoryFiles）
 */
async function loadProjectInstructions (projectRoot) {
  const processedPaths = new Set()
  const budget = { used: 0 }
  const chunks = []

  // 1) User
  const home = os.homedir()
  chunks.push(...await processMemoryFile(
    path.join(home, '.claude', 'CLAUDE.md'), 'User', processedPaths, 0, budget
  ))
  chunks.push(...await processMemoryFile(
    path.join(home, '.panda', 'Panda.md'), 'User', processedPaths, 0, budget
  ))
  {
    const visited = new Set()
    chunks.push(...await processMdRules(
      path.join(home, '.claude', 'rules'), 'UserRules', processedPaths, budget, visited
    ))
    chunks.push(...await processMdRules(
      path.join(home, '.panda', 'rules'), 'UserRules', processedPaths, budget, visited
    ))
  }

  // 2) Ancestors: filesystem root → projectRoot（越靠近项目越靠后）
  const ancestors = collectAncestorDirs(projectRoot)
  for (const dir of ancestors) {
    // 跳过 home 本身已作为 User 加载过的重复？仍允许项目在 home 子目录的 Project 文件
    chunks.push(...await loadDocsInDir(dir, processedPaths, budget, {
      loadProject: true,
      loadLocal: true,
      loadRules: true
    }))
  }

  if (!chunks.length) return ''

  const body = chunks.map(c => {
    const rel = tryRelPath(projectRoot, c.path)
    return '### [' + c.type + '] ' + rel + '\n' + c.content
  }).join('\n\n---\n\n')

  return [
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions.',
    'IMPORTANT: These instructions OVERRIDE any default behavior when they conflict.',
    'Load order: User → ancestor Project/rules (root→cwd) → Local. Later files have higher priority.',
    'Supports @include (e.g. @./docs/style.md). This context may or may not be relevant to the current task.',
    '',
    body
  ].join('\n')
}

function tryRelPath (projectRoot, abs) {
  try {
    const rel = path.relative(projectRoot, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  } catch (e) { /* ignore */ }
  // home 缩写
  const home = os.homedir()
  if (abs.startsWith(home)) return '~' + abs.slice(home.length).split(path.sep).join('/')
  return abs.split(path.sep).join('/')
}

function createMemory (projectRoot) {
  const memoryIndex = require('./memoryIndex')
  return {
    async read (topic) {
      await memoryIndex.migrateIfNeeded(projectRoot)
      if (topic) {
        const r = await memoryIndex.readTopic(projectRoot, topic)
        return r.content
      }
      try {
        return await fsp.readFile(memoryPath(projectRoot), 'utf8')
      } catch (e) {
        return ''
      }
    },
    async append (note, topic) {
      await ensureDir(projectRoot)
      const id = await memoryIndex.appendTopic(projectRoot, topic || 'general', note)
      return id
    },
    async loadForPrompt (opts = {}) {
      const parts = []
      const instructions = await loadProjectInstructions(projectRoot)
      if (instructions) parts.push(instructions)

      const workspaceMemory = require('./workspaceMemory')
      const rollup = await workspaceMemory.buildWorkspaceMemorySection(projectRoot, {
        excludeSessionId: opts.excludeSessionId || opts.currentSessionId || ''
      })
      if (rollup.section) {
        parts.push(rollup.section)
      } else {
        await memoryIndex.migrateIfNeeded(projectRoot)
        let indexText = ''
        try {
          indexText = await fsp.readFile(memoryPath(projectRoot), 'utf8')
        } catch (e) {
          indexText = await memoryIndex.writeIndex(projectRoot, [])
        }
        parts.push(
          '【MEMORY 索引 · L1】\n' +
          indexText.trim().slice(0, 2200) +
          '\n\n（详情不在上下文中。需要时调用 memory_read，参数 topic 为上表 id，如 preferences / architecture / auto / general。）'
        )
      }
      return parts.join('\n\n')
    }
  }
}

module.exports = {
  createMemory,
  memoryPath,
  loadProjectInstructions,
  extractIncludePaths,
  collectAncestorDirs,
  processMemoryFile,
  processMdRules,
  memoryIndex: () => require('./memoryIndex')
}
