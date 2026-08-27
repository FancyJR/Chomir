'use strict'

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const BRIEF_DIR = '.shiyundesign'
const BRIEF_FILE = 'brief.json'
const MAX_LIST = 12
const MAX_TEXT = 500

function briefPath (cwd) {
  return join(cwd, BRIEF_DIR, BRIEF_FILE)
}

function emptyBrief () {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    goal: '',
    artifactType: 'html',
    visualDirection: '',
    stableDecisions: [],
    openTasks: [],
    currentFiles: [],
    lastUserIntent: ''
  }
}

/** @param {string} cwd */
function loadDesignBrief (cwd) {
  const p = briefPath(cwd)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function clipText (text, max = MAX_TEXT) {
  const s = String(text || '').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function uniqPush (list, item, max = MAX_LIST) {
  const next = list.filter((x) => x !== item)
  next.unshift(item)
  return next.slice(0, max)
}

/**
 * @param {string} cwd
 * @param {{ userTask?: string, changed?: string[], finalAnswer?: string }} update
 */
function updateDesignBrief (cwd, update) {
  const prev = loadDesignBrief(cwd) || emptyBrief()
  const brief = { ...prev, updatedAt: new Date().toISOString() }

  if (update.userTask) {
    brief.lastUserIntent = clipText(update.userTask)
    if (!brief.goal) brief.goal = clipText(update.userTask, 240)
  }

  if (Array.isArray(update.changed)) {
    for (const file of update.changed) {
      if (file) brief.currentFiles = uniqPush(brief.currentFiles, String(file))
    }
  }

  if (update.finalAnswer) {
    const hint = clipText(update.finalAnswer, 180)
    if (hint && !brief.stableDecisions.includes(hint)) {
      brief.stableDecisions = uniqPush(brief.stableDecisions, hint, 8)
    }
  }

  mkdirSync(join(cwd, BRIEF_DIR), { recursive: true })
  writeFileSync(briefPath(cwd), JSON.stringify(brief, null, 2) + '\n', 'utf8')
  return brief
}

/** @param {ReturnType<typeof loadDesignBrief>} brief */
function formatBriefForPrompt (brief) {
  if (!brief) return ''
  const lines = [
    'Prior session brief (continue coherently; update DESIGN.md when visual decisions change):',
    `- Goal: ${brief.goal || '(unset)'}`,
    `- Last intent: ${brief.lastUserIntent || '(unset)'}`,
    `- Artifact type: ${brief.artifactType || 'html'}`
  ]
  if (brief.visualDirection) lines.push(`- Visual direction: ${brief.visualDirection}`)
  if (brief.stableDecisions?.length) {
    lines.push('- Stable decisions:')
    for (const d of brief.stableDecisions.slice(0, 6)) lines.push(`  - ${d}`)
  }
  if (brief.currentFiles?.length) {
    lines.push(`- Recent files: ${brief.currentFiles.slice(0, 8).join(', ')}`)
  }
  if (brief.openTasks?.length) {
    lines.push('- Open tasks:')
    for (const t of brief.openTasks.slice(0, 4)) lines.push(`  - ${t}`)
  }
  return lines.join('\n')
}

module.exports = {
  loadDesignBrief,
  updateDesignBrief,
  formatBriefForPrompt,
  briefPath
}
