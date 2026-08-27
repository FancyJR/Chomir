'use strict'

/**
 * ShiyunN8n stdout outcome helpers (deliverable-aware).
 */

const { existsSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const NO_OUTPUT = '（无输出）'
const MIN_BYTES = 80

/**
 * @param {string} stdout
 * @param {string} [runtimeName]
 */
function parseAgentStdout (stdout, runtimeName = 'ShiyunN8n') {
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
    } catch { /* try earlier */ }
  }
  const last = lines[lines.length - 1]
  return {
    ok: false,
    error: `${runtimeName} runtime stdout was not JSON: ${last.slice(0, 200)}`,
    finalAnswer: lines.join('\n'),
  }
}

/** @param {string} absPath */
function isSubstantiveFile (absPath) {
  try {
    const st = statSync(absPath)
    return st.isFile() && st.size >= MIN_BYTES
  } catch {
    return false
  }
}

/**
 * @param {{ cwd?: string }} [hints]
 * @returns {string[]}
 */
function discoverDeliverableFiles (hints = {}) {
  const cwd = hints.cwd ? resolve(String(hints.cwd)) : ''
  if (!cwd || !existsSync(cwd)) return []
  /** @type {string[]} */
  const found = []
  const push = (p) => {
    if (isSubstantiveFile(p)) found.push(p)
  }
  for (const name of readdirSync(cwd)) {
    if (/\.workflow\.(json|ts)$/i.test(name) || /^workflow\.json$/i.test(name)) {
      push(join(cwd, name))
    }
  }
  // Also accept any .json that looks like n8n workflow if named with workflow
  for (const name of readdirSync(cwd)) {
    if (!/\.json$/i.test(name)) continue
    if (/workflow|n8n/i.test(name)) push(join(cwd, name))
  }
  return [...new Set(found)]
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {number | null | undefined} exitCode
 * @param {{ cwd?: string, taskText?: string }} [hints]
 */
function resolveAgentOutcome (parsed, exitCode, hints = {}) {
  const exit = exitCode ?? 1
  const answer = String(parsed.finalAnswer || '').trim()
  let changed = Array.isArray(parsed.changed)
    ? parsed.changed.map((f) => String(f || '').trim()).filter(Boolean)
    : []
  const hasAnswer = answer.length > 0 && answer !== NO_OUTPUT
  const errMsg = parsed.error ? String(parsed.error).trim() : ''

  if (changed.length === 0) changed = discoverDeliverableFiles(hints)

  if (parsed.aborted || exit === 130) {
    return { stopReason: 'aborted', text: answer || errMsg || '已中断' }
  }
  if (parsed.ok === true && (hasAnswer || changed.length > 0)) {
    return { stopReason: 'completed', text: hasAnswer ? answer : `已写入：${changed.join(', ')}` }
  }
  if (changed.length > 0) {
    return { stopReason: 'completed', text: hasAnswer ? answer : `已写入：${changed.join(', ')}` }
  }
  if (exit === 0 && hasAnswer && !errMsg) {
    return { stopReason: 'completed', text: answer }
  }
  return {
    stopReason: 'error',
    text: errMsg || answer || `runtime failed (exit ${String(exit)})`,
  }
}

module.exports = {
  NO_OUTPUT,
  parseAgentStdout,
  discoverDeliverableFiles,
  resolveAgentOutcome,
}
