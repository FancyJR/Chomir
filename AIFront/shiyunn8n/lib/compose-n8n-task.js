'use strict'

/**
 * Compose n8n Instance-AI guided task text from bundled offline assets.
 * Task-aware: injects relevant skills + distilled workflow-builder prompts only.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const {
  stripFrontmatter,
  readAssetText,
  selectSkillIds,
  selectPromptFiles,
  listSkillCatalog,
} = require('./select-n8n-assets')

/** @param {string} text @param {number} max */
function clip (text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 20)}\n\n…(truncated)`
}

/**
 * @param {{ assetsRoot: string, userTask: string, maxChars?: number }} input
 */
function composeN8nTask (input) {
  const assetsRoot = input.assetsRoot
  const userTask = String(input.userTask || '').trim()
  if (!existsSync(assetsRoot)) {
    throw new Error(`ShiyunN8n assets missing at ${assetsRoot}`)
  }

  const maxChars = input.maxChars ?? 48_000
  const sections = []

  sections.push([
    'You are ShiyunN8n — a headless n8n workflow and AI-agent builder.',
    'You run on ChomirCode (AIFront): write deliverable files under cwd, do not assume a live n8n Instance-AI tool host.',
    'Prefer importable `*.workflow.json` (n8n UI export shape) unless the user asks for Workflow SDK TypeScript.',
    'Also write a short README.md covering import steps and required credentials (placeholders only).',
    'Follow selected n8n skills and guardrails; translate in-product tools (build-workflow / nodes / executions) into file edits + validation notes.',
    'Respond in Chinese when the user writes in Chinese.',
    'Wrap deliverable filenames in backticks.',
  ].join('\n'))

  const delivery = readAssetText(assetsRoot, 'prompts/sections/workflow-html.md')
  if (delivery) sections.push(`## Delivery\n\n${clip(delivery, 2_000)}`)

  const jsonShape = readAssetText(assetsRoot, 'prompts/sections/n8n-json-shape.md')
  if (jsonShape) sections.push(`## Workflow JSON shape\n\n${clip(jsonShape, 2_500)}`)

  const catalog = listSkillCatalog(assetsRoot)
  if (catalog) sections.push(`## Skill catalog\n\n${catalog}`)

  for (const doc of ['architecture.md', 'tools.md']) {
    const body = readAssetText(assetsRoot, join('docs', doc))
    if (body) sections.push(`## Docs: ${doc}\n\n${clip(body, 3_500)}`)
  }

  for (const kb of [
    'reference/workflow-builder-guardrails.md',
    'reference/trigger-input-data-shapes.md',
  ]) {
    const body = readAssetText(assetsRoot, join('knowledge-base', kb))
    if (body) sections.push(`## Knowledge: ${kb}\n\n${clip(body, 2_500)}`)
  }

  for (const skillId of selectSkillIds(userTask)) {
    const body = readAssetText(assetsRoot, join('skills', skillId, 'SKILL.md'))
    if (body) {
      sections.push(`## Skill: ${skillId}\n\n${clip(stripFrontmatter(body), 4_500)}`)
    }
  }

  for (const file of selectPromptFiles(userTask)) {
    const body = readAssetText(assetsRoot, join('prompts', 'workflow-builder', file))
    if (body) sections.push(`## Prompt: ${file}\n\n${clip(body, 3_000)}`)
  }

  const cliSkill = readAssetText(assetsRoot, 'meta/n8n-cli/SKILL.md')
  if (cliSkill && /cli|api|push|deploy|导入|发布/i.test(userTask)) {
    sections.push(`## Meta: n8n-cli\n\n${clip(stripFrontmatter(cliSkill), 2_500)}`)
  }

  sections.push(`## User task\n\n${userTask}`)

  let composed = sections.join('\n\n---\n\n')
  if (composed.length > maxChars) composed = clip(composed, maxChars)
  return composed
}

module.exports = { composeN8nTask }
