#!/usr/bin/env node
/**
 * Sync curated n8n Instance-AI skills/docs/prompts into AIFront/shiyunn8n/assets.
 * Source: set N8N_MASTER_ROOT to an n8n checkout (skills already vendored in shiyunn8n/assets).
 * Enforces ≤3 MB on shiyunn8n/.
 * Usage: node scripts/sync-n8n-into-shiyunn8n.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const destRoot = resolve(root, 'shiyunn8n')
const destAssets = resolve(destRoot, 'assets')
const MAX_BYTES = 3 * 1024 * 1024

const candidates = [
  resolve(process.env.N8N_MASTER_ROOT || ''),
].filter(Boolean)

const n8nRoot = candidates.find((p) => p && existsSync(join(p, 'packages', '@n8n')))
if (!n8nRoot) {
  console.error(
    'sync-n8n: set N8N_MASTER_ROOT to an n8n monorepo checkout.\n' +
      'Curated assets already live under AIFront/shiyunn8n/assets — re-sync only when refreshing upstream.',
  )
  process.exit(1)
}

const instanceAi = join(n8nRoot, 'packages', '@n8n', 'instance-ai')
const promptsSrc = join(n8nRoot, 'packages', '@n8n', 'ai-workflow-builder.ee', 'src', 'prompts')
const cliSkill = join(n8nRoot, 'packages', '@n8n', 'cli', 'skills', 'n8n-cli')

function dirSizeBytes(dir) {
  let total = 0
  if (!existsSync(dir)) return 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) total += dirSizeBytes(p)
    else total += st.size
  }
  return total
}

function copyTree(src, dest) {
  if (!existsSync(src)) {
    console.warn('skip missing', src)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
  console.log('copied', src, '->', dest)
}

/**
 * Extract template-literal prompt bodies from *.prompt.ts into markdown.
 * Best-effort: keeps readable text for the coding agent, drops TS machinery.
 */
function distillPromptTs(filePath, outPath) {
  const raw = readFileSync(filePath, 'utf8')
  const chunks = []
  const re = /`([\s\S]*?)`/g
  let m
  while ((m = re.exec(raw))) {
    const body = m[1]
      .replace(/\$\{[^}]+\}/g, '…')
      .replace(/\\n/g, '\n')
      .replace(/\\`/g, '`')
      .trim()
    if (body.length > 80) chunks.push(body)
  }
  if (chunks.length === 0) return false
  const name = filePath.split('/').pop().replace(/\.ts$/, '')
  const md = `# ${name}\n\n> Distilled from n8n ai-workflow-builder (headless reference).\n\n${chunks.join('\n\n---\n\n')}\n`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, md)
  return true
}

function distillPrompts() {
  const dest = join(destAssets, 'prompts', 'workflow-builder')
  mkdirSync(dest, { recursive: true })
  let n = 0
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (name === 'test' || name === 'examples') continue
        walk(p)
        continue
      }
      if (!name.endsWith('.prompt.ts') || name.includes('.test.')) continue
      const rel = p.slice(promptsSrc.length + 1).replace(/\.ts$/, '.md')
      if (distillPromptTs(p, join(dest, rel))) n++
    }
  }
  walk(promptsSrc)
  // Also keep the prompts README if present
  const readme = join(promptsSrc, 'README.md')
  if (existsSync(readme)) cpSync(readme, join(dest, 'README.md'))
  console.log(`distilled prompts: ${n} files -> ${dest}`)
}

function writeDeliveryGuide() {
  const dest = join(destAssets, 'prompts', 'sections')
  mkdirSync(dest, { recursive: true })
  writeFileSync(
    join(dest, 'workflow-html.md'),
    `# ShiyunN8n delivery workflow

You are ShiyunN8n — a headless n8n workflow / AI-agent builder powered by ChomirCode (AIFront).

## Deliverables (write under cwd)

Prefer one of:

1. **n8n workflow JSON** — importable in n8n UI (\`*.workflow.json\` or \`workflow.json\`)
2. **Workflow SDK TypeScript** — \`*.workflow.ts\` using \`@n8n/workflow-sdk\` style when the task asks for code
3. **Short README.md** — how to import / activate / required credentials

## Headless constraints

- You do **not** have live n8n Instance-AI tools (\`build-workflow\`, \`nodes\`, \`executions\`).
- Translate those skill steps into **file writes + validation notes**.
- Do not install the full n8n monorepo. Prefer self-contained JSON/TS artifacts.
- If \`N8N_URL\` / \`N8N_API_KEY\` appear in the environment, you may document a \`n8n-cli\` push command; do not invent credentials.
- Respond in Chinese when the user writes in Chinese.
- Wrap deliverable filenames in backticks (e.g. \`webhook-to-slack.workflow.json\`).
`,
  )
  writeFileSync(
    join(dest, 'n8n-json-shape.md'),
    `# Minimal n8n workflow JSON shape

\`\`\`json
{
  "name": "Example",
  "nodes": [
    {
      "id": "1",
      "name": "Manual Trigger",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0],
      "parameters": {}
    }
  ],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "meta": { "templateCredsSetupCompleted": true }
}
\`\`\`

Rules:

- Every node needs unique \`id\`, \`name\`, \`type\`, \`typeVersion\`, \`position\`, \`parameters\`.
- \`connections\` maps source node name → outputs → target \`{ node, type, index }\`.
- Prefer well-known nodes: \`manualTrigger\`, \`webhook\`, \`scheduleTrigger\`, \`httpRequest\`, \`code\`, \`if\`, \`set\`, \`slack\`, \`gmail\`, LangChain agent nodes when building AI agents.
- Never put real secrets in the JSON; use credential placeholders and document required creds in README.
`,
  )
  console.log('wrote delivery guides ->', dest)
}

function writeSkillIndex() {
  const skillsDir = join(destAssets, 'skills')
  const ids = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, 'SKILL.md')))
    : []
  writeFileSync(
    join(destAssets, 'skills', 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        skills: ids.map((id) => ({ id, path: `${id}/SKILL.md` })),
      },
      null,
      2,
    ),
  )
  console.log(`skill manifest: ${ids.length} skills`)
}

// --- run ---
mkdirSync(destAssets, { recursive: true })

copyTree(join(instanceAi, 'skills'), join(destAssets, 'skills'))
copyTree(join(instanceAi, 'knowledge-base'), join(destAssets, 'knowledge-base'))

const docsKeep = ['architecture.md', 'tools.md', 'configuration.md']
mkdirSync(join(destAssets, 'docs'), { recursive: true })
for (const f of docsKeep) {
  const src = join(instanceAi, 'docs', f)
  if (existsSync(src)) cpSync(src, join(destAssets, 'docs', f))
}
console.log('docs: architecture/tools/configuration')

if (existsSync(cliSkill)) {
  copyTree(cliSkill, join(destAssets, 'meta', 'n8n-cli'))
}

const agentsMd = join(n8nRoot, 'AGENTS.md')
if (existsSync(agentsMd)) {
  mkdirSync(join(destAssets, 'meta'), { recursive: true })
  // Clip AGENTS.md — full file can be large; keep first ~12KB of architecture guidance
  const body = readFileSync(agentsMd, 'utf8')
  writeFileSync(join(destAssets, 'meta', 'AGENTS.excerpt.md'), body.slice(0, 12_000))
}

distillPrompts()
writeDeliveryGuide()
writeSkillIndex()

const bytes = dirSizeBytes(destRoot)
const mb = (bytes / (1024 * 1024)).toFixed(2)
console.log(`shiyunn8n total: ${mb} MB (${bytes} bytes)`)
if (bytes > MAX_BYTES) {
  console.error(`ERROR: shiyunn8n exceeds 3MB cap (${mb} MB)`)
  process.exit(1)
}
console.log('sync-n8n: OK (under 3MB cap)')
