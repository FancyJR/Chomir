/**
 * SessionMemory（对齐 panda-code SessionMemory 结构厚度）
 * compact 后把结构化摘要写入会话长期区，下一轮注入 system
 */

const fsp = require('fs').promises
const path = require('path')

const DEFAULT_TEMPLATE = [
  '# Session Title',
  '_A short and distinctive 5-10 word descriptive title for the session._',
  '',
  '# Current State',
  '_What is actively being worked on right now? Pending tasks. Immediate next steps._',
  '',
  '# Task specification',
  '_What did the user ask to build? Design decisions and constraints._',
  '',
  '# Files and Functions',
  '_Important files, what they contain, why relevant._',
  '',
  '# Workflow',
  '_Common commands and how to interpret output._',
  '',
  '# Errors & Corrections',
  '_Errors fixed; approaches that failed and should not be retried._',
  '',
  '# Codebase and System Documentation',
  '_Important components and how they fit together._',
  '',
  '# Learnings',
  '_What worked / did not / avoid. Do not duplicate other sections._',
  '',
  '# Key results',
  '_Exact outputs the user asked for (tables, answers, decisions)._',
  '',
  '# Worklog',
  '_Terse step-by-step of what was attempted and done._',
  ''
].join('\n')

function sessionMemoryPath (projectRoot, sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.resolve(projectRoot, '.panda', 'sessions', sid, 'session-memory', 'summary.md')
}

function legacySessionMemoryPath (projectRoot, sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.resolve(projectRoot, '.panda', 'sessions', sid, 'memory.md')
}

function isTemplateOnly (text) {
  const t = String(text || '').trim()
  if (!t) return true
  // 去掉 italic 说明与标题后若几乎无正文，视为空模板
  const body = t
    .replace(/^#.+$/gm, '')
    .replace(/^_.+_$/gm, '')
    .replace(/>.*$/gm, '')
    .trim()
  return body.length < 40
}

/**
 * 把自由摘要填入模板各节（轻量启发式，非 LLM 分节）
 */
function mergeSummaryIntoTemplate (existing, summary) {
  const base = (existing && !isTemplateOnly(existing)) ? existing : DEFAULT_TEMPLATE
  const sum = String(summary || '').trim()
  if (!sum) return base

  const stamp = new Date().toISOString()
  // 若已有结构化内容：追加 Worklog + 刷新 Current State
  if (!isTemplateOnly(base) && /# Current State/.test(base)) {
    let out = base
    // Current State：替换该节正文（保留 header + italic）
    out = out.replace(
      /(# Current State\n_[^\n]*_\n)([\s\S]*?)(?=\n# |\n*$)/,
      function (_m, head) {
        return head + '\n' + sum.slice(0, 1800) + '\n'
      }
    )
    if (/# Worklog/.test(out)) {
      out = out.replace(
        /(# Worklog\n_[^\n]*_\n)([\s\S]*?)(?=\n# |\n*$)/,
        function (_m, head, body) {
          const prev = String(body || '').trim()
          const line = '- [' + stamp + '] ' + sum.slice(0, 400).replace(/\n+/g, ' ')
          return head + '\n' + (prev ? prev + '\n' : '') + line + '\n'
        }
      )
    }
    return out.slice(0, 14000)
  }

  // 全新：把摘要塞进 Current State / Task / Worklog
  return [
    '# Session Title',
    '_A short and distinctive 5-10 word descriptive title for the session._',
    '',
    'Compact update · ' + stamp.slice(0, 10),
    '',
    '# Current State',
    '_What is actively being worked on right now? Pending tasks. Immediate next steps._',
    '',
    sum.slice(0, 2000),
    '',
    '# Task specification',
    '_What did the user ask to build? Design decisions and constraints._',
    '',
    sum.slice(0, 1200),
    '',
    '# Files and Functions',
    '_Important files, what they contain, why relevant._',
    '',
    '',
    '# Workflow',
    '_Common commands and how to interpret output._',
    '',
    '',
    '# Errors & Corrections',
    '_Errors fixed; approaches that failed and should not be retried._',
    '',
    '',
    '# Codebase and System Documentation',
    '_Important components and how they fit together._',
    '',
    '',
    '# Learnings',
    '_What worked / did not / avoid. Do not duplicate other sections._',
    '',
    '',
    '# Key results',
    '_Exact outputs the user asked for (tables, answers, decisions)._',
    '',
    '',
    '# Worklog',
    '_Terse step-by-step of what was attempted and done._',
    '',
    '- [' + stamp + '] ' + sum.slice(0, 500).replace(/\n+/g, ' '),
    ''
  ].join('\n').slice(0, 14000)
}

async function writeSessionMemory (projectRoot, sessionId, summary) {
  const p = sessionMemoryPath(projectRoot, sessionId)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  let existing = ''
  try {
    existing = await fsp.readFile(p, 'utf8')
  } catch (e) {
    try {
      existing = await fsp.readFile(legacySessionMemoryPath(projectRoot, sessionId), 'utf8')
    } catch (e2) { /* empty */ }
  }
  const body = mergeSummaryIntoTemplate(existing, summary)
  await fsp.writeFile(p, body, 'utf8')
  return p
}

async function readSessionMemory (projectRoot, sessionId, maxChars) {
  const lim = maxChars || 4000
  const paths = [
    sessionMemoryPath(projectRoot, sessionId),
    legacySessionMemoryPath(projectRoot, sessionId)
  ]
  for (const p of paths) {
    try {
      const text = await fsp.readFile(p, 'utf8')
      if (text && text.trim()) return text.trim().slice(0, lim)
    } catch (e) { /* try next */ }
  }
  return ''
}

function getSessionMemorySection (text) {
  if (!text || !String(text).trim()) return ''
  return [
    '# Session long-term notes (session-memory)',
    '以下为会话结构化记忆（Current State / Files / Errors / Worklog 等）。保持目标一致；细节不确定时重新 read_file / grep。',
    '',
    String(text).trim()
  ].join('\n')
}

module.exports = {
  sessionMemoryPath,
  writeSessionMemory,
  readSessionMemory,
  getSessionMemorySection,
  DEFAULT_TEMPLATE,
  mergeSummaryIntoTemplate
}
