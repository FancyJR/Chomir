'use strict'

/**
 * Task-aware asset selection for ShiyunN8n prompt composition.
 */

const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

/** @type {Array<{ id: string, test: (task: string) => boolean }>} */
const SKILL_RULES = [
  { id: 'workflow-builder', test: (t) => /workflow|工作流|自动化|webhook|cron|schedule|触发/i.test(t) },
  { id: 'agent-builder', test: (t) => /agent|智能体|langchain|tool.?calling|AI 代理|ai agent/i.test(t) },
  { id: 'planning', test: (t) => /plan|多工作流|协调|dependency|规划|任务图/i.test(t) },
  { id: 'data-table-manager', test: (t) => /data.?table|数据表|表格存储/i.test(t) },
  { id: 'debugging-executions', test: (t) => /debug|执行失败|execution|报错|失败排查/i.test(t) },
  { id: 'credential-recipe-research', test: (t) => /credential|凭据|oauth|api.?key|鉴权/i.test(t) },
  { id: 'post-build-flow', test: (t) => /verify|验证|激活|activate|发布|deploy/i.test(t) },
  { id: 'intent-recognition', test: (t) => /意图|分类|intent|路由/i.test(t) },
  { id: 'one-off-operations', test: (t) => /一次性|one.?off|批量操作|cleanup/i.test(t) },
  { id: 'n8n-docs-assistant', test: (t) => /文档|怎么用|how to|docs|帮助/i.test(t) },
  { id: 'planned-task-runtime', test: (t) => /scheduled|定时|cron|计划任务/i.test(t) },
]

/** @type {Array<{ file: string, test: (task: string) => boolean }>} */
const PROMPT_RULES = [
  { file: 'agents/supervisor.prompt.md', test: (t) => /supervisor|编排|orchestrat/i.test(t) },
  { file: 'agents/discovery.prompt.md', test: (t) => /discover|节点发现|找节点|which node/i.test(t) },
  { file: 'agents/planner.prompt.md', test: (t) => /plan|规划|步骤/i.test(t) },
  { file: 'agents/responder.prompt.md', test: () => false },
  { file: 'chains/categorization.prompt.md', test: (t) => /分类|categor/i.test(t) },
  { file: 'chains/workflow-name.prompt.md', test: (t) => /命名|rename|workflow name/i.test(t) },
]

/** @param {string} text */
function stripFrontmatter (text) {
  const s = String(text || '')
  if (!s.startsWith('---')) return s.trim()
  const end = s.indexOf('\n---', 3)
  if (end < 0) return s.trim()
  return s.slice(end + 4).trim()
}

/** @param {string} assetsRoot @param {string} rel */
function readAssetText (assetsRoot, rel) {
  const p = join(assetsRoot, rel)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8').trim()
}

/** @param {string} task */
function selectSkillIds (task) {
  const t = String(task || '')
  const hits = SKILL_RULES.filter((r) => r.test(t)).map((r) => r.id)
  // Always include workflow-builder as default for automation tasks
  if (!hits.includes('workflow-builder') && /n8n|workflow|工作流|自动化|webhook|slack|gmail|http/i.test(t)) {
    hits.unshift('workflow-builder')
  }
  if (hits.length === 0) hits.push('workflow-builder', 'intent-recognition')
  // Cap to keep prompt budget
  return [...new Set(hits)].slice(0, 4)
}

/** @param {string} task */
function selectPromptFiles (task) {
  const t = String(task || '')
  const hits = PROMPT_RULES.filter((r) => r.test(t)).map((r) => r.file)
  if (hits.length === 0) hits.push('agents/planner.prompt.md')
  return [...new Set(hits)].slice(0, 2)
}

/** @param {string} assetsRoot */
function listSkillCatalog (assetsRoot) {
  const manifestPath = join(assetsRoot, 'skills', 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const data = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (Array.isArray(data.skills)) {
        return data.skills.map((s) => `- \`${s.id}\``).join('\n')
      }
    } catch { /* fall through */ }
  }
  const dir = join(assetsRoot, 'skills')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'SKILL.md')))
    .map((d) => `- \`${d}\``)
    .join('\n')
}

module.exports = {
  stripFrontmatter,
  readAssetText,
  selectSkillIds,
  selectPromptFiles,
  listSkillCatalog,
}
