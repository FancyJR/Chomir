'use strict'

/**
 * Resolve ChomirCode CLI for ShiyunN8n (AIFront monorepo layout).
 */

const fs = require('fs')
const path = require('path')

/** @param {string} p */
function tryScript (p) {
  if (!fs.existsSync(p)) return null
  fs.accessSync(p)
  return p
}

/**
 * @param {string} runtimeRoot AIFront/shiyunn8n
 * @returns {string}
 */
function resolveBundledChomirCodeBin (runtimeRoot) {
  const fromEnv = process.env.CHOMIRCODE_AGENT_BIN || process.env.AIFRONT_AGENT_BIN
  if (fromEnv) {
    const hit = tryScript(path.resolve(fromEnv))
    if (hit) return hit
  }
  const besideRuntime = tryScript(path.resolve(runtimeRoot, '..', 'bin', 'chomircode-agent.js'))
  if (besideRuntime) return besideRuntime
  throw new Error(
    'ShiyunN8n: cannot find chomircode-agent — set CHOMIRCODE_AGENT_BIN or run from AIFront repo'
  )
}

module.exports = { resolveBundledChomirCodeBin }
