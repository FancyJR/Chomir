'use strict'

/**
 * Compose OpenDesign + open-codesign-guided task text from bundled offline assets.
 * Task-aware: only injects method skills, brand refs, JSX patterns, and optional runtime extensions.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const {
  stripFrontmatter,
  loadBrandManifest,
  matchBrands,
  selectMethodSkillIds,
  shouldUseWebClone,
  selectDesignSkillFiles,
  formatBrandIndex,
  readAssetText,
  selectRuntimeCapabilities,
  shouldAllowBundledPreviewScripts,
  shouldUseRuntimeExtensions,
  formatRuntimeSkill,
} = require('./select-design-assets')
const { loadDesignBrief, formatBriefForPrompt } = require('./design-brief')

/** @param {string} text @param {number} max */
function clip (text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 20)}\n\n…(truncated)`
}

/**
 * @param {{ assetsRoot: string, userTask: string, cwd?: string, runtimeRoot?: string, maxChars?: number }} input
 */
function composeDesignTask (input) {
  const assetsRoot = input.assetsRoot
  const userTask = String(input.userTask || '').trim()
  if (!existsSync(assetsRoot)) {
    throw new Error(`ShiyunDesign assets missing at ${assetsRoot}`)
  }

  const cwd = input.cwd ? String(input.cwd) : ''
  const runtimeRoot = input.runtimeRoot || join(assetsRoot, '..')
  const maxChars = input.maxChars ?? 48_000
  const runtimeCaps = selectRuntimeCapabilities(userTask)
  const useRuntime = shouldUseRuntimeExtensions(userTask)
  const allowPreviewScripts = shouldAllowBundledPreviewScripts(userTask)
  const sections = []

  const baseLines = [
    'You are ShiyunDesign — a headless OpenDesign design-and-build agent.',
    'Follow bundled craft rules, the default design system, task-selected method skills, and any matched brand reference.',
    'Deliver polished, production-ready artifacts (HTML/CSS/JS in the target cwd).',
    'Prefer self-contained index.html when building web prototypes unless the user asks otherwise.',
    'Use real typography, spacing, and color discipline; avoid generic AI-slop aesthetics.',
    'Write all deliverable files under the task working directory (cwd).',
    'Respond in Chinese when the user writes in Chinese.',
    'When naming deliverable files, wrap each filename in backticks (e.g. `index.html`).',
  ]

  if (allowPreviewScripts) {
    baseLines.push(
      'For this task you MAY run bundled ShiyunDesign runtime scripts (under the runtime scripts/ dir) or existing web-clone scripts when explicitly needed for brand extract, UI kit, preview capture, or site clone.',
      'Do not install puppeteer/playwright/npm packages; do not start local HTTP servers.',
    )
    if (runtimeCaps.previewIterate) {
      baseLines.push(
        'For pixel-level iteration: capture with preview-capture.mjs, compare with preview-compare.mjs, fix HTML, repeat until acceptable.',
      )
    } else {
      baseLines.push('After the primary HTML deliverable is written, stop unless preview iteration is required.')
    }
  } else {
    baseLines.push(
      'After writing the HTML deliverable, stop. The runtime opens the primary page in the browser automatically.',
      'Do NOT install puppeteer/playwright, start local HTTP servers, or chase screenshot/DOM verification loops.',
    )
  }

  sections.push(baseLines.join('\n'))

  if (cwd) {
    const brief = loadDesignBrief(cwd)
    const briefText = formatBriefForPrompt(brief)
    if (briefText) sections.push(`## Session brief\n\n${clip(briefText, 1_800)}`)
  }

  const workflow = readAssetText(assetsRoot, 'prompts/sections/workflow-html.md')
  if (workflow) sections.push(`## Workflow\n\n${clip(workflow, 1_200)}`)

  for (const name of ['design-methodology.md', 'brand-acquisition-html.md', 'multi-screen-baton.md']) {
    const body = readAssetText(assetsRoot, join('prompts', 'sections', name))
    if (body) sections.push(`## ${name.replace(/\.md$/, '')}\n\n${clip(body, 1_500)}`)
  }

  const brands = loadBrandManifest(assetsRoot)
  const brandIndex = formatBrandIndex(brands)
  if (brandIndex) sections.push(`## Brand catalog\n\n${clip(brandIndex, 3_000)}`)

  for (const brand of matchBrands(userTask, brands)) {
    const body = readAssetText(assetsRoot, join('brand-refs', brand.path))
    if (body) {
      sections.push(`## Brand ref: ${brand.name}\n\n${clip(stripFrontmatter(body), 4_000)}`)
    }
  }

  const designMd = readAssetText(assetsRoot, 'design-systems/default/DESIGN.md')
  if (designMd) sections.push(`## Design system (DESIGN.md)\n\n${clip(designMd, 10_000)}`)

  const tokensCss = readAssetText(assetsRoot, 'design-systems/default/tokens.css')
  if (tokensCss) {
    sections.push(`## Design tokens (tokens.css)\n\n\`\`\`css\n${clip(tokensCss, 3_500)}\n\`\`\``)
  }

  for (const name of [
    'anti-ai-slop.md',
    'color.md',
    'typography.md',
    'laws-of-ux.md',
    'accessibility-baseline.md',
    'animation-discipline.md',
  ]) {
    const body = readAssetText(assetsRoot, join('craft', name))
    if (body) sections.push(`## Craft: ${name}\n\n${clip(body, 2_200)}`)
  }

  for (const skillId of selectMethodSkillIds(userTask)) {
    const body = readAssetText(assetsRoot, join('skills', 'method', `${skillId}.md`))
    if (body) sections.push(`## Method: ${skillId}\n\n${clip(stripFrontmatter(body), 2_800)}`)
  }

  const artifactsSkill = readAssetText(assetsRoot, 'skills/artifacts-builder/SKILL.md')
  if (artifactsSkill) {
    sections.push(`## Skill: artifacts-builder\n\n${clip(artifactsSkill, 2_500)}`)
  }

  if (shouldUseWebClone(userTask)) {
    const webCloneSkill = readAssetText(assetsRoot, 'skills/web-clone/SKILL.md')
    if (webCloneSkill) sections.push(`## Skill: web-clone\n\n${clip(webCloneSkill, 7_000)}`)
  }

  if (useRuntime) {
    const runtimeSkill = formatRuntimeSkill(runtimeRoot, runtimeCaps)
    if (runtimeSkill) sections.push(`## Skill: runtime extensions\n\n${clip(runtimeSkill, 5_500)}`)
  }

  for (const file of selectDesignSkillFiles(userTask)) {
    const body = readAssetText(assetsRoot, join('design-skills', file))
    if (body) {
      sections.push(`## Pattern reference: ${file}\n\n${clip(body, 3_500)}`)
    }
  }

  sections.push(`## User task\n\n${userTask}`)

  let composed = sections.join('\n\n---\n\n')
  if (composed.length > maxChars) composed = clip(composed, maxChars)
  return composed
}

module.exports = { composeDesignTask }
