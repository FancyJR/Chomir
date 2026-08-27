/**
 * Resolve shiyunn8n-agent CLI in the AIFront monorepo (or via env / vendored runtime).
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
export function resolveShiyunN8nAgentLaunch() {
  const fromEnv = process.env.SHIYUNN8N_AGENT_BIN
    ? tryScript(resolve(process.env.SHIYUNN8N_AGENT_BIN))
    : null
  if (fromEnv) return { command: process.execPath, args: [fromEnv] }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fromVendor = tryScript(resolve(packageRoot, 'vendor', 'shiyunn8n-runtime', 'bin', 'shiyunn8n-agent.js'))
  if (fromVendor) return { command: process.execPath, args: [fromVendor] }

  const fromMonorepo = tryScript(resolve(packageRoot, '..', '..', 'bin', 'shiyunn8n-agent.js'))
  if (fromMonorepo) return { command: process.execPath, args: [fromMonorepo] }

  throw new Error(
    'subagent-shiyunn8n: cannot find shiyunn8n-agent — set SHIYUNN8N_AGENT_BIN or install AIFront bin',
  )
}
