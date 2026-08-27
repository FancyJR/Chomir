'use strict'

/**
 * Shared ShiyunCode-style subagent stdout outcome (ShiyunCode + ShiyunDesign).
 * Success requires a deliverable signal — not blind completion.
 */

const { existsSync, statSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')
const { extractTargetDirsFromTask } = require('./subagent-task-cwd')

const SHIYUNCODE_NO_OUTPUT_PLACEHOLDER = '（无输出）'

const MIN_DELIVERABLE_BYTES = 200

/**
 * @param {string} stdout
 * @param {string} [runtimeName]
 */
function parseAgentStdout(stdout, runtimeName = 'Subagent') {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return { ok: false, error: `${runtimeName} runtime produced no stdout` }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i])
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* try earlier line */ }
  }
  const last = lines[lines.length - 1]
  return {
    ok: false,
    error: `${runtimeName} runtime stdout was not JSON: ${last.slice(0, 200)}`,
    finalAnswer: lines.join('\n'),
  }
}

/** @param {Record<string, unknown>} parsed */
function changedFiles(parsed) {
  if (!Array.isArray(parsed.changed)) return []
  return parsed.changed.map((f) => String(f || '').trim()).filter(Boolean)
}

/** @param {Record<string, unknown>} parsed */
function answerText(parsed) {
  return String(parsed.finalAnswer || '').trim()
}

/** @param {string} absPath */
function isSubstantiveFile(absPath) {
  try {
    const stat = statSync(absPath)
    return stat.isFile() && stat.size >= MIN_DELIVERABLE_BYTES
  } catch {
    return false
  }
}

/**
 * Scan task-mentioned dirs (and cwd) for a likely HTML deliverable on disk.
 * @param {{ cwd?: string, taskText?: string }} [hints]
 * @returns {string[]}
 */
function discoverDeliverableFiles(hints = {}) {
  /** @type {string[]} */
  const found = []
  const seen = new Set()

  const push = (absPath) => {
    const key = resolve(absPath)
    if (seen.has(key)) return
    if (!isSubstantiveFile(key)) return
    seen.add(key)
    found.push(key)
  }

  const dirs = new Set()
  const cwd = hints.cwd ? resolve(String(hints.cwd)) : ''
  if (cwd) dirs.add(cwd)
  for (const dir of extractTargetDirsFromTask(String(hints.taskText || ''))) {
    dirs.add(resolve(dir))
  }

  for (const dir of dirs) {
    for (const name of ['index.html', 'index.htm']) {
      push(join(dir, name))
    }
  }

  const taskText = String(hints.taskText || '')
  const htmlPathRe = /((?:~\/|\/Users\/|\/home\/)[^\s`'"，。；;\n（(]+\.html?)/giu
  for (const m of taskText.matchAll(htmlPathRe)) {
    const token = String(m[1] || '').trim()
    if (!token) continue
    const abs = token.startsWith('~/')
      ? resolve(homedir(), token.slice(2))
      : resolve(token)
    push(abs)
  }

  return found
}

/**
 * Map runtime JSON + exit code to a terminal subagent outcome.
 * @param {Record<string, unknown>} parsed
 * @param {number | null | undefined} exitCode
 * @param {{ cwd?: string, taskText?: string }} [hints]
 * @returns {{ stopReason: 'completed' | 'aborted' | 'error', text: string }}
 */
function resolveAgentOutcome(parsed, exitCode, hints = {}) {
  const exit = exitCode ?? 1
  const answer = answerText(parsed)
  let changed = changedFiles(parsed)
  const hasAnswer = answer.length > 0 && answer !== SHIYUNCODE_NO_OUTPUT_PLACEHOLDER
  const errMsg = parsed.error ? String(parsed.error).trim() : ''

  if (changed.length === 0) {
    changed = discoverDeliverableFiles(hints)
  }

  if (parsed.aborted || exit === 130) {
    return { stopReason: 'aborted', text: answer || errMsg || '已中断' }
  }

  if (parsed.ok === true && (hasAnswer || changed.length > 0)) {
    return {
      stopReason: 'completed',
      text: hasAnswer ? answer : `已写入：${changed.join(', ')}`,
    }
  }

  // Deliverable landed even if the agent later hit tool timeouts / non-zero exit
  // while chasing screenshots — prefer success over a false "error" in the job list.
  if (changed.length > 0) {
    return {
      stopReason: 'completed',
      text: hasAnswer ? answer : `已写入：${changed.join(', ')}`,
    }
  }

  if (exit === 0 && hasAnswer && !errMsg) {
    return { stopReason: 'completed', text: answer }
  }

  return {
    stopReason: 'error',
    text: errMsg || answer || `runtime failed (exit ${String(exit)})`,
  }
}

module.exports = { SHIYUNCODE_NO_OUTPUT_PLACEHOLDER, parseAgentStdout, discoverDeliverableFiles, resolveAgentOutcome }
