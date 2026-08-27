/**
 * Resolve shiyundesign-agent CLI in the AIFront monorepo (or via env override).
 */

import { accessSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} p */
function tryScript(p) {
  if (!existsSync(p)) return null
  accessSync(p)
  return p
}

/** @returns {{ command: string, args: string[] }} */
export function resolveShiyunDesignAgentLaunch() {
  const fromEnv = process.env.SHIYUNDESIGN_AGENT_BIN
    ? tryScript(resolve(process.env.SHIYUNDESIGN_AGENT_BIN))
    : null
  if (fromEnv) return { command: process.execPath, args: [fromEnv] }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fromVendor = tryScript(resolve(packageRoot, 'vendor', 'shiyundesign-runtime', 'bin', 'shiyundesign-agent.js'))
  if (fromVendor) return { command: process.execPath, args: [fromVendor] }

  // packages/dsh-subagent-shiyundesign → AIFront/bin/shiyundesign-agent.js
  const fromMonorepo = tryScript(resolve(packageRoot, '..', '..', 'bin', 'shiyundesign-agent.js'))
  if (fromMonorepo) return { command: process.execPath, args: [fromMonorepo] }

  throw new Error(
    'subagent-shiyundesign: cannot find shiyundesign-agent — set SHIYUNDESIGN_AGENT_BIN or install AIFront bin',
  )
}
