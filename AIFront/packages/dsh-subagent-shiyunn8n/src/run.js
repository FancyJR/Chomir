/**
 * Spawn vendored shiyunn8n-agent and settle one-shot subagent result.
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import { parseAgentStdout, resolveAgentOutcome } from './protocol.js'
import { createStderrEventParser } from './stderr-events.js'

export { parseAgentStdout } from './protocol.js'

export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export const STDERR_COLLECT = {
  maxBytes: 512_000,
  spill: { maxBytes: 4 * 1024 * 1024 },
}

/**
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} child
 * @param {{ onTodos?: (raw: unknown) => void }} spec
 */
export function attachStderrTodoBridge(child, spec) {
  const feedStderr = createStderrEventParser(
    (event) => {
      if (event.event === 'panda_todos' && spec.onTodos) {
        spec.onTodos(event.data.todos)
      }
    },
    {
      forward: (line) => {
        try { process.stderr.write(`${line}\n`) } catch { /* ignore */ }
      },
    },
  )

  child.stderr?.on('data', feedStderr)

  let offset = 0
  const drainCollected = () => {
    const reader = child.collected?.stderr
    if (!reader) return
    const chunk = reader.readFrom(offset)
    offset = chunk.nextOffset
    if (chunk.text) feedStderr(chunk.text)
  }

  const timer = setInterval(drainCollected, 150)
  child.done.finally(() => {
    clearInterval(timer)
    drainCollected()
  }).catch(() => {})
}

/** @param {import('@deepseek-ai/dsh-llm').ContentBlock[]} prompt */
export function textTask(prompt) {
  if (!prompt || prompt.length === 0) {
    throw new Error('subagent-shiyunn8n: the one-shot task must contain only text blocks')
  }
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-shiyunn8n: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-shiyunn8n: the one-shot task must not be empty')
  }
  return texts.join('\n\n')
}

/** @param {import('node:stream').Readable | undefined} stream */
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

/** @param {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} child */
export async function disposeShiyunN8nChild(child) {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch { /* ignore */ }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * @param {import('@deepseek-ai/dsh-subagent').SubagentStartRequest} request
 * @param {import('./index.js').ShiyunN8nRunSpec} spec
 */
export async function startShiyunN8nRun(request, spec) {
  const task = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-shiyunn8n: request was aborted before agent startup')
  }

  const argv = [
    spec.command,
    ...spec.args,
    '--cwd',
    spec.cwd,
    '--max-rounds',
    String(spec.maxRounds ?? process.env.AIFRONT_MAX_ROUNDS ?? '1024'),
    '--permission-mode',
    'bypassPermissions',
    '--task',
    task,
  ]

  const child = spec.spawn({
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: STDERR_COLLECT },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  attachStderrTodoBridge(child, spec)

  const disposeProcess = () => disposeShiyunN8nChild(child)

  let stdoutBuf = ''
  const stdoutDone = readAll(child.stdout).then((text) => {
    stdoutBuf = text
    return text
  })

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-shiyunn8n: run cancelled locally'))
    try { child.terminate() } catch { /* ignore */ }
  }
  const onAbort = () => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

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
          runAbort.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true })
        }),
      ])

      if (race.kind === 'cancelled') {
        return { output: collectOutput(), stopReason: 'aborted' }
      }

      await stdoutDone
      const parsed = parseAgentStdout(stdoutBuf)
      const exitCode = race.outcome?.exitCode
      const outcome = resolveAgentOutcome(parsed, exitCode, {
        cwd: spec.cwd,
        taskText: task,
      })

      try { spec.onTodos?.([]) } catch { /* ignore */ }

      if (outcome.stopReason === 'aborted') {
        return { output: collectOutput(), stopReason: 'aborted' }
      }
      return {
        output: [{ type: 'text', text: outcome.text }],
        stopReason: outcome.stopReason,
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
