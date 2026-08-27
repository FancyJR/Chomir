'use strict'

/**
 * Open the primary HTML deliverable in the system default browser after design runs.
 */

const spawn = require('node:child_process').spawn
const existsSync = require('node:fs').existsSync
const resolve = require('node:path').resolve
const pathToFileURL = require('node:url').pathToFileURL

/** @param {unknown} changed */
function normalizeChangedPaths(changed) {
  if (!Array.isArray(changed)) return []
  return changed
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object' && 'file' in item) return String(item.file || '').trim()
      return ''
    })
    .filter(Boolean)
}

/** @param {string[]} paths */
function pickHtmlPreviewPath(paths) {
  const html = paths.filter((p) => /\.x?html?$/i.test(p))
  if (html.length === 0) return null
  return html.find((p) => /(^|\/)index\.x?html?$/i.test(p)) || html[0]
}

/**
 * @param {string} cwd
 * @param {unknown} changed
 * @returns {string | null}
 */
function resolveHtmlPreviewPath(cwd, changed) {
  const rel = pickHtmlPreviewPath(normalizeChangedPaths(changed))
  if (!rel) return null
  const abs = resolve(cwd, rel)
  return existsSync(abs) ? abs : null
}

/**
 * Spawn a detached opener; ignore exit status (best-effort preview).
 * @param {string} command
 * @param {string[]} args
 * @param {{ shell?: boolean }} [opts]
 */
function spawnDetached(command, args, opts = {}) {
  try {
    spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: opts.shell === true,
    }).unref()
    return true
  } catch {
    return false
  }
}

/** @param {string} absPath */
function openPathInBrowser(absPath) {
  const platform = process.platform
  if (platform === 'darwin') {
    spawnDetached('open', [absPath])
    return
  }
  if (platform === 'win32') {
    spawnDetached('cmd', ['/c', 'start', '', absPath], { shell: true })
    return
  }

  // Linux: file:// + common browsers; plain xdg-open(path) often no-ops under AppImage.
  const fileUrl = pathToFileURL(absPath).href
  if (spawnDetached('xdg-open', [fileUrl])) return
  if (spawnDetached('xdg-open', [absPath])) return
  for (const browser of ['firefox', 'chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable']) {
    if (spawnDetached(browser, [fileUrl])) return
  }
}

/**
 * @param {string} cwd
 * @param {unknown} changed
 * @returns {string | null} absolute path opened
 */
function openHtmlPreviewIfPresent(cwd, changed) {
  const abs = resolveHtmlPreviewPath(cwd, changed)
  if (!abs) return null
  openPathInBrowser(abs)
  return abs
}

module.exports = { normalizeChangedPaths, pickHtmlPreviewPath, resolveHtmlPreviewPath, openPathInBrowser, openHtmlPreviewIfPresent }
