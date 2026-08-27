/**
 * Shared optional cwd hints for Kylin coding subagents (ShiyunCode + OpenCode + ShiyunDesign).
 * Does not limit where files may be written — only suggests a child working directory
 * when the task text names one.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

/** Keep aligned with dsh-plugin-kylin-builtin-provider/network-mode.js (vendored in dropins). */
function shouldUseIntranetProvider(env = process.env, platform = process.platform) {
  if (env.KYLIN_SKIP_INTRANET_AK === '1') return false
  if (env.KYLIN_FORCE_INTRANET_AK === '1') return true
  return platform === 'linux'
}

/** Kylin intranet desktop DSH install root (E2B / bank Linux image). */
export const INTRANET_DSH_HOME = '/home/user'

/** Default session workspace on intranet DSH. */
export const INTRANET_WORKSPACE = '/home/user/workspace'

const DO_NOT_TOUCH_RE = /(?:do not|not modify|not touch|older attempts|不要|勿|别碰|不要修改|勿改|勿动|勿删)/i

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveIntranetHome(env = process.env) {
  return env.DSH_INTRANET_HOME || INTRANET_DSH_HOME
}

/** @param {string} raw */
function expandHome(raw) {
  let p = sanitizePathToken(raw)
  if (!p) return ''
  if (p.startsWith('~/')) p = resolve(homedir(), p.slice(2))
  return resolve(p)
}

/**
 * Trim prose glued to paths in task prompts, e.g.
 * `/Users/me/Desktop/app/index.html（单文件、内联 CSS）` → `/Users/me/Desktop/app/index.html`
 * @param {string} raw
 */
export function sanitizePathToken(raw) {
  let p = String(raw || '').trim().replace(/^[`'"]|[`'"]$/g, '')
  if (!p) return ''

  const paren = p.search(/[（(]/)
  if (paren > 0) p = p.slice(0, paren).trim()

  p = p.replace(/[、，].*$/, '').trim()
  p = p.replace(/[：:]\s*$/u, '').trim()

  const htmlIdx = p.toLowerCase().indexOf('/index.html')
  if (htmlIdx >= 0) {
    const upto = p.slice(0, htmlIdx + '/index.html'.length)
    if (/^[\w./~-]+$/.test(upto) || upto.startsWith('/')) p = upto
  }

  return p
}

/** @param {string} raw */
function looksLikePath(raw) {
  const p = sanitizePathToken(raw)
  if (!p) return false
  if (p.startsWith('~/') || p.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  return false
}

/** True when basename looks like a deliverable file, not a project folder. */
function looksLikeFileName(base) {
  return /\.(html?|xhtml|css|js|mjs|cjs|tsx?|jsx|vue|svg|md|json|png|jpe?g|webp|txt)$/i.test(base)
}

/**
 * Map a path token to a working directory.
 * File-like basenames (e.g. `AI助手.html`) always resolve to their parent dir —
 * even if a directory with that name already exists from a previous bad run.
 * @param {string} raw
 */
function normalizeCandidate(raw) {
  const p = expandHome(raw)
  if (!p) return undefined
  if (p.endsWith('/index.html') || p.endsWith('\\index.html')) return dirname(p)
  const base = basename(p)
  // Never use `Foo.html` / `bar.js` as cwd — write the file inside the parent.
  if (looksLikeFileName(base)) return dirname(p)
  if (existsSync(p)) {
    return statSync(p).isDirectory() ? p : dirname(p)
  }
  if (base.includes('.') && base !== '.' && base !== '..') return dirname(p)
  return p
}

/** @param {string} text @param {number} index */
function isBlockedPathContext(text, index) {
  const window = text.slice(Math.max(0, index - 120), index + 60)
  return DO_NOT_TOUCH_RE.test(window)
}

/**
 * Collect absolute path tokens from task text, skipping "do not touch" sections.
 * @param {string} text
 * @returns {Array<{ dir: string, index: number }>}
 */
function collectAbsolutePathHits(text) {
  /** @type {Array<{ dir: string, index: number }>} */
  const hits = []
  const re = /(?:~\/|\/Users\/|\/home\/)[^\s`'"，。；;\n（(]+/gu
  for (const m of text.matchAll(re)) {
    const token = sanitizePathToken(m[0])
    if (!token || !looksLikePath(token)) continue
    const index = m.index ?? 0
    if (isBlockedPathContext(text, index)) continue
    const dir = normalizeCandidate(token)
    if (dir) hits.push({ dir, index })
  }
  return hits
}

function desktopRoots() {
  const home = homedir()
  const roots = [resolve(home, 'Desktop'), resolve(home, '桌面')]
  if (shouldUseIntranetProvider()) {
    roots.push(INTRANET_WORKSPACE, resolve(resolveIntranetHome(), 'Desktop'))
  }
  return roots
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function extractDesktopFolder(text) {
  const patterns = [
    /(?:输出到|写到|放在|保存到|交付到)\s*(?:macOS\s*)?(?:桌面|Desktop)(?:[上的]?)?(?:文件夹)?\s*[：:/]?\s*([^\s`'"，。；;\n/]+)/i,
    /(?:在)?(?:桌面|Desktop)\s+([a-zA-Z0-9_.\u4e00-\u9fff-]+)(?:\s*文件夹)?/u,
    /(?:桌面|Desktop)\s*(?:的?\s*)?([a-zA-Z0-9_.\u4e00-\u9fff-]+)(?:\s*文件夹)?/u,
    /(?:桌面|Desktop)[^\n]*?(SuperMarioGame\d*)/i,
    /(?:桌面|Desktop)\/([^\s`'"，。；;\n/]+)/u,
  ]
  for (const desktop of desktopRoots()) {
    for (const re of patterns) {
      const m = text.match(re)
      if (!m?.[1]) continue
      const hit = normalizeCandidate(resolve(desktop, sanitizePathToken(m[1])))
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * Prefer explicit deliverable paths (written to / 输出到) over incidental mentions.
 * @param {string} text
 * @returns {string | undefined}
 */
function extractDeliverableDir(text) {
  const patterns = [
    /(?:written to|write to|deliverable|deliver to|output to|save to)\s*:?\s*((?:~\/|\/Users\/|\/home\/)[^\s`'"，。；;\n（(]+)/gi,
    /(?:输出到|写到|放在|保存到|交付到)\s*:?\s*((?:~\/|\/Users\/|\/home\/)[^\s`'"，。；;\n（(]+)/gi,
  ]
  for (const re of patterns) {
    let last
    for (const m of text.matchAll(re)) {
      const hit = normalizeCandidate(m[1])
      if (hit) last = hit
    }
    if (last) return last
  }
  return undefined
}

/**
 * Intranet DSH lives under /home/user; tasks often say `workspace/game` without
 * the full prefix.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function extractIntranetWorkspacePath(text) {
  if (!shouldUseIntranetProvider()) return undefined
  const home = resolveIntranetHome()
  const workspace = resolve(home, 'workspace')

  const homePrefix = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const homePath = text.match(new RegExp(`(${homePrefix}/[^\\s\`'"，。；;\\n（(]+)`))
  if (homePath?.[1]) return normalizeCandidate(homePath[1])

  const wsRel = text.match(/(?:^|\s)\/?(workspace\/[a-zA-Z0-9_./\u4e00-\u9fff-]+)/iu)
  if (wsRel?.[1]) return normalizeCandidate(resolve(home, wsRel[1]))

  if (!/(?:桌面|Desktop)/i.test(text)) {
    const folder = text.match(/(?:在|到)\s*([a-zA-Z0-9_.\u4e00-\u9fff-]+)\s*(?:文件夹|目录|folder)/iu)
    if (folder?.[1] && !/^(workspace|user)$/i.test(folder[1])) {
      return normalizeCandidate(resolve(workspace, folder[1]))
    }
  }
  return undefined
}

/**
 * All candidate working directories mentioned in a task (deduped, in source order).
 * @param {string} task
 * @returns {string[]}
 */
export function extractTargetDirsFromTask(task) {
  const text = String(task || '')
  /** @type {string[]} */
  const out = []
  const seen = new Set()

  const push = (dir) => {
    const key = resolve(dir)
    if (seen.has(key)) return
    seen.add(key)
    out.push(key)
  }

  const deliverable = extractDeliverableDir(text)
  if (deliverable) push(deliverable)

  const desktopHit = extractDesktopFolder(text)
  if (desktopHit) push(desktopHit)

  const intranetHit = extractIntranetWorkspacePath(text)
  if (intranetHit) push(intranetHit)

  for (const hit of collectAbsolutePathHits(text)) push(hit.dir)

  const loosePatterns = [
    /(?:文件夹|目录|folder|directory|cwd)\s*[:：]\s*([^\s`'"，。；;\n（(]+)/gi,
  ]
  for (const re of loosePatterns) {
    for (const m of text.matchAll(re)) {
      if (!looksLikePath(m[1])) continue
      const hit = normalizeCandidate(m[1])
      if (hit) push(hit)
    }
  }

  return out
}

/** @param {string} task */
export function extractTargetDirFromTask(task) {
  const text = String(task || '')

  const deliverable = extractDeliverableDir(text)
  if (deliverable) return deliverable

  const desktopHit = extractDesktopFolder(text)
  if (desktopHit) return desktopHit

  const intranetHit = extractIntranetWorkspacePath(text)
  if (intranetHit) return intranetHit

  const absoluteHits = collectAbsolutePathHits(text)
  if (absoluteHits.length > 0) {
    return absoluteHits[absoluteHits.length - 1].dir
  }

  const patterns = [
    /(?:文件夹|目录|folder|directory|cwd)\s*[:：]\s*([^\s`'"，。；;\n（(]+)/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m?.[1]) continue
    if (!looksLikePath(m[1])) continue
    const hit = normalizeCandidate(m[1])
    if (hit) return hit
  }
  return undefined
}

/** @param {string} dir @param {string} label */
export function ensureTargetDir(dir, label = 'subagent') {
  const target = expandHome(dir)
  if (!target) {
    throw new Error(`${label}: target directory is empty`)
  }
  mkdirSync(target, { recursive: true })
  if (!statSync(target).isDirectory()) {
    throw new Error(`${label}: target is not a directory: ${target}`)
  }
  return target
}
