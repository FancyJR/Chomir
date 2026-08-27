#!/usr/bin/env node
/**
 * Merge open-codesign template assets into AIFront/shiyundesign/assets.
 * Skips craft/, design-systems/, skills/web-clone/, skills/artifacts-builder/ (already present).
 * Usage: node scripts/sync-opencodesign-into-shiyundesign.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const destAssets = resolve(root, 'shiyundesign', 'assets')
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

const ocCandidates = [
  resolve(root, '..', 'open-codesign', 'apps', 'desktop', 'resources', 'templates'),
  resolve(process.env.OPENCODESIGN_TEMPLATES || ''),
  resolve(process.env.HOME || '', 'workspace', 'Chomir', 'open-codesign', 'apps', 'desktop', 'resources', 'templates'),
]

const ocRoot = ocCandidates.find((p) => p && existsSync(p))
if (!ocRoot) {
  console.error('sync-opencodesign: open-codesign templates not found. Set OPENCODESIGN_TEMPLATES.')
  process.exit(1)
}

const ocPrompts = resolve(root, '..', 'open-codesign', 'packages', 'core', 'src', 'prompts', 'sections')
const skipMethodSkills = new Set(['frontend-design-anti-slop.md', 'craft-polish.md'])

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
}

function copyMethodSkills() {
  const srcDir = join(ocRoot, 'skills')
  const destDir = join(destAssets, 'skills', 'method')
  mkdirSync(destDir, { recursive: true })
  let n = 0
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.md') || skipMethodSkills.has(file)) continue
    cpSync(join(srcDir, file), join(destDir, file))
    n++
  }
  console.log(`method skills: ${n} files -> ${destDir}`)
}

function copyTree(rel) {
  const src = join(ocRoot, rel)
  if (!existsSync(src)) {
    console.warn('skip missing', src)
    return
  }
  const dest = join(destAssets, rel)
  copyDir(src, dest)
  console.log(`${rel}: -> ${dest}`)
}

function copyPromptSections() {
  const destDir = join(destAssets, 'prompts', 'sections')
  mkdirSync(destDir, { recursive: true })
  const keep = [
    'design-methodology.md',
    'brand-acquisition.md',
    'multi-screen-baton.md',
  ]
  if (!existsSync(ocPrompts)) {
    console.warn('skip prompts: missing', ocPrompts)
    return
  }
  for (const file of keep) {
    const src = join(ocPrompts, file)
    if (existsSync(src)) cpSync(src, join(destDir, file))
  }
  // HTML-in-cwd adapted workflow (not the React-host workflow.md from open-codesign)
  const workflow = `# ShiyunDesign delivery workflow

- Start from context: user task, default design system, optional brand-ref, task-selected method skills.
- Write self-contained HTML/CSS/JS deliverables under cwd; prefer \`index.html\` unless the user names a file.
- After the primary HTML file is written, stop — the runtime opens it in the browser.
- Do not start local HTTP servers or install puppeteer/playwright for verification loops.
- For multi-screen work, maintain \`DESIGN.md\` in cwd as the cross-page baton (colors, type, spacing, radius).
- Respond in Chinese when the user writes in Chinese.
`
  writeAdaptedBrandAcquisition(destDir)
  writeFile(join(destDir, 'workflow-html.md'), workflow)
  console.log(`prompts/sections: -> ${destDir}`)
}

function writeFile(p, content) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function writeAdaptedBrandAcquisition(destDir) {
  const adapted = `# Brand acquisition (HTML deliverables)

Brand values are data, not memory.

- If the task names a brand listed in the bundled brand-ref manifest, read that brand's \`DESIGN.md\` tokens before writing.
- Never invent brand hex colors or fonts from memory.
- If no brand ref matches, say the result is brand-inspired rather than brand-accurate.
- When a brand ref is used, codify adopted choices into cwd \`DESIGN.md\` for follow-up screens.
- Workspace \`DESIGN.md\` overrides bundled brand refs when both exist.
`
  writeFile(join(destDir, 'brand-acquisition-html.md'), adapted)
}

function dirSizeBytes(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) total += dirSizeBytes(p)
    else total += st.size
  }
  return total
}

// --- run ---
mkdirSync(destAssets, { recursive: true })
copyMethodSkills()
copyTree('brand-refs')
copyTree('design-skills')
copyTree('scaffolds')
copyTree('frames')
copyPromptSections()

const bytes = dirSizeBytes(join(root, 'shiyundesign'))
const mb = (bytes / (1024 * 1024)).toFixed(2)
console.log(`shiyundesign total: ${mb} MB (${bytes} bytes)`)
if (bytes > MAX_BUNDLE_BYTES) {
  console.error(`ERROR: shiyundesign exceeds ${MAX_BUNDLE_BYTES} bytes (${mb} MB). Trim assets before pack.`)
  process.exit(1)
}
console.log('sync-opencodesign: OK (under 5MB cap)')
