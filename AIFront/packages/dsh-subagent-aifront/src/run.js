/**
 * One-shot AIFront child lifecycle: spawn `chomircode-agent` via the subprocess
 * seam, publish after spawn, settle on the single stdout JSON result line.
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import { parseAgentStdout } from './protocol.js'

export { parseAgentStdout } from './protocol.js'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/**
 * @param {import('@deepseek-ai/dsh-llm').ContentBlock[]} prompt
 * @returns {string}
 */
export function textTask(prompt) {
  if (!prompt || prompt.length === 0) {
    throw new Error('subagent-aifront: the one-shot task must contain only text blocks')
  }
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-aifront: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-aifront: the one-shot task must not be empty')
  }
  return texts.join('\n\n')
}

/**
 * @param {import('node:stream').Readable | undefined} stream
 * @returns {Promise<string>}
 */
function readAll(stream) {
  if (!stream) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.setEncoding('utf8')
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', () => resolve(chunks.join('')))
    stream.on('error', reject)
  })
}

/**
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} child
 */
export async function disposeAifrontChild(child) {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch {
    // ignore
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * @typedef {object} AifrontRunSpec
 * @property {string} cwd
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {number} disposeGraceMs
 * @property {(spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle} spawn
 * @property {(error: Error, stopReason: string) => void} [onError]
 */

/**
 * @param {import('@deepseek-ai/dsh-subagent').SubagentStartRequest} request
 * @param {AifrontRunSpec} spec
 * @returns {Promise<import('@deepseek-ai/dsh-subagent').SubagentRun>}
 */
export async function startAifrontRun(request, spec) {
  const task = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-aifront: request was aborted before agent startup')
  }

  const argv = [
    spec.command,
    ...spec.args,
    '--cwd',
    spec.cwd,
    '--task',
    task,
  ]

  const child = spec.spawn({
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  const disposeProcess = () => disposeAifrontChild(child)

  /** @type {string} */
  let stdoutBuf = ''
  const stdoutDone = readAll(child.stdout).then((text) => {
    stdoutBuf = text
    return text
  })

  const processFailure = child.done.then(
    (outcome) =>
      Promise.reject(
        new Error(
          'subagent-aifront: agent exited before settle '
            + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
        ),
      ),
    (error) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  )
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-aifront: run cancelled locally'))
    try {
      child.terminate()
    } catch {
      // ignore
    }
  }
  const onAbort = () => {
    requestCancel()
  }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // Publish immediately after spawn (CLI has no handshake). Race exit vs cancel.
  const collectOutput = () => {
    const parsed = parseAgentStdout(stdoutBuf)
    const answer =
      (parsed.finalAnswer && String(parsed.finalAnswer).trim())
      || (parsed.error && String(parsed.error).trim())
      || ''
    return answer ? [{ type: 'text', text: answer }] : []
  }

  const result = settleRunResult({
    attempt: async () => {
      const race = await Promise.race([
        Promise.all([child.done, stdoutDone]).then(([outcome]) => ({ kind: 'done', outcome })),
        new Promise((resolve) => {
          if (runAbort.signal.aborted) {
            resolve({ kind: 'cancelled' })
            return
          }
          runAbort.signal.addEventListener(
            'abort',
            () => resolve({ kind: 'cancelled' }),
            { once: true },
          )
        }),
      ])

      if (race.kind === 'cancelled') {
        return { output: collectOutput(), stopReason: 'aborted' }
      }

      await stdoutDone
      const parsed = parseAgentStdout(stdoutBuf)
      const exitCode = race.outcome?.exitCode

      if (parsed.aborted || exitCode === 130) {
        return { output: collectOutput(), stopReason: 'aborted' }
      }
      if (parsed.ok && parsed.finalAnswer && String(parsed.finalAnswer).trim()) {
        return {
          output: [{ type: 'text', text: String(parsed.finalAnswer) }],
          stopReason: 'completed',
        }
      }
      const errText =
        (parsed.error && String(parsed.error))
        || `chomircode-agent failed (exit ${String(exitCode)})`
      return {
        output: [{ type: 'text', text: errText }],
        stopReason: 'error',
      }
    },
    collectOutput,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
