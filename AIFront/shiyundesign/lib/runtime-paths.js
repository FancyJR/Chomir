'use strict'

const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

/** @param {string} runtimeRoot AIFront/shiyundesign */
function resolveRuntimeRoot (runtimeRoot) {
  return resolve(runtimeRoot)
}

/** @param {string} runtimeRoot */
function scriptsDir (runtimeRoot) {
  return join(resolveRuntimeRoot(runtimeRoot), 'scripts')
}

/** @param {string} runtimeRoot @param {string} name */
function scriptPath (runtimeRoot, name) {
  return join(scriptsDir(runtimeRoot), name)
}

/** @param {string} runtimeRoot */
function webCloneVisualDiffPath (runtimeRoot) {
  const p = join(resolveRuntimeRoot(runtimeRoot), 'assets', 'skills', 'web-clone', 'scripts', 'visual-diff.mjs')
  return existsSync(p) ? p : ''
}

module.exports = { resolveRuntimeRoot, scriptsDir, scriptPath, webCloneVisualDiffPath }
