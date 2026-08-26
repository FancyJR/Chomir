/**
 * Fixed AIFront one-shot subagent provider. Each start() spawns a fresh
 * `chomircode-agent` process in the parent Session workspace and returns only
 * the final answer JSON line from stdout.
 *
 * @module @aifront/dsh-subagent-aifront
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startAifrontRun,
} from './run.js'
import { resolveChildEnv } from './child-env.js'

export const name = 'subagent-aifront'
export const inject = ['subagents', 'subprocess', 'credentials']

const require = createRequire(import.meta.url)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve ChomirCode CLI script path (env override → monorepo bin → PATH binary). */
function resolveAgentScript() {
  if (process.env.CHOMIRCODE_AGENT_BIN || process.env.AIFRONT_AGENT_BIN) {
    return path.resolve(process.env.CHOMIRCODE_AGENT_BIN || process.env.AIFRONT_AGENT_BIN)
  }
  // packages/dsh-subagent-aifront → AIFront root → bin/chomircode-agent.js
  const candidate = path.resolve(packageRoot, '..', '..', 'bin', 'chomircode-agent.js')
  try {
    require('fs').accessSync(candidate)
    return candidate
  } catch {
    return ''
  }
}

function defaultCommand() {
  return resolveAgentScript() ? process.execPath : 'chomircode-agent'
}

function defaultArgs() {
  const script = resolveAgentScript()
  return script ? [script] : []
}

/** @typedef {{ command?: string, args?: string[], env?: Record<string, string>, disposeGraceMs?: number }} Config */

export const Config = z.object({
  /**
   * Executable to spawn. Defaults to `node` when the AIFront bin script is
   * found next to this package; otherwise `chomircode-agent` from PATH.
   */
  command: z.string().default(defaultCommand()),
  /** Arguments before `--cwd` / `--task` (defaults to the bin script path when using node). */
  args: z.array(z.string()).default(defaultArgs()),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

class AifrontProvider {
  name = 'aifront'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Required<Config>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /**
   * @param {import('@deepseek-ai/dsh-subagent').ResolvedSubagentStartRequest} request
   */
  async start(request) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-aifront: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const env = await resolveChildEnv(this.ctx, this.config.env)
    return startAifrontRun(request, {
      cwd: resolveChildCwd('subagent-aifront', undefined, parentCwd),
      command: this.config.command,
      args: this.config.args,
      env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-aifront: child run failed (${stopReason}): ${error.message}`,
        )
      },
    })
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  const resolved = /** @type {Required<Config>} */ (config)
  assertPositiveFinite('subagent-aifront', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-aifront: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new AifrontProvider(ctx, resolved))
}
