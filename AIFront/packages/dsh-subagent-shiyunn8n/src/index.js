/**
 * Fixed ShiyunN8n one-shot subagent provider for DeepSeek Harness / Kylin Desktop.
 * Spawns `shiyunn8n-agent` (n8n Instance-AI assets + chomircode-agent executor).
 *
 * @module @aifront/dsh-subagent-shiyunn8n
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
} from '@deepseek-ai/dsh-subagent'
import { resolveChildEnv } from './child-env.js'
import { resolveShiyunN8nAgentLaunch } from './agent-path.js'
import { ensureTargetDir, extractTargetDirFromTask } from './task-cwd.js'
import { DEFAULT_DISPOSE_GRACE_MS, startShiyunN8nRun } from './run.js'
import { registerShiyunN8nRoutingPrompt } from './shiyunn8n-routing.js'
import { createParentTodoBridge, seedShiyunN8nTodos } from './todo-bridge.js'

export const name = 'subagent-shiyunn8n'
export const inject = ['subagents', 'subprocess', 'credentials', 'systemPrompt']

function resolveProviderConfig(config) {
  const launch = resolveShiyunN8nAgentLaunch()
  return {
    command: launch.command,
    args: launch.args,
    env: config.env ?? {},
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
}

export const Config = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

class ShiyunN8nProvider {
  name = 'shiyunn8n'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {z.infer<typeof Config>} config */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /** @param {import('@deepseek-ai/dsh-subagent').ResolvedSubagentStartRequest} request */
  async start(request) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-shiyunn8n: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const env = await resolveChildEnv(this.ctx, this.config.env)
    if (!env.DEEPSEEK_API_KEY) {
      throw new Error(
        'subagent-shiyunn8n: DEEPSEEK_API_KEY is not configured — add it in DSH Settings',
      )
    }
    const taskText = request.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
    const taskCwd = extractTargetDirFromTask(taskText)
    const childCwd = taskCwd
      ? ensureTargetDir(taskCwd, 'subagent-shiyunn8n')
      : resolveChildCwd('subagent-shiyunn8n', undefined, parentCwd)
    const todoBridge = createParentTodoBridge(request.parent.session)
    seedShiyunN8nTodos(todoBridge, taskText)
    const launch = resolveShiyunN8nAgentLaunch()
    return startShiyunN8nRun(request, {
      cwd: childCwd,
      command: launch.command,
      args: launch.args,
      env,
      disposeGraceMs: this.config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      onTodos: todoBridge,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-shiyunn8n: child run failed (${stopReason}): ${error.message}`,
        )
      },
    })
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {Partial<z.infer<typeof Config>>} config */
export function apply(ctx, config) {
  const resolved = resolveProviderConfig(/** @type {z.infer<typeof Config>} */ (config ?? {}))
  assertPositiveFinite('subagent-shiyunn8n', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-shiyunn8n: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(
    new ShiyunN8nProvider(ctx, /** @type {z.infer<typeof Config>} */ (config ?? {})),
  )
  registerShiyunN8nRoutingPrompt(ctx)
}
