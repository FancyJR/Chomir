/**
 * ShiyunDesign headless CLI: OpenDesign prompt/assets + ChomirCode executor.
 * stdout: last line JSON { ok, finalAnswer, error, aborted, changed, sessionId }
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const RUNTIME_ROOT = path.join(ROOT, 'shiyundesign')
const MAX_PROMPT_CHARS = 48_000

const { composeDesignTask } = require('../../shiyundesign/lib/compose-design-task')
const { updateDesignBrief } = require('../../shiyundesign/lib/design-brief')
const { openHtmlPreviewIfPresent } = require('../../shiyundesign/lib/open-html-preview')
const { resolveBundledChomirCodeBin } = require('../../shiyundesign/lib/resolve-chomircode-bin')
const {
  parseAgentStdout,
  resolveAgentOutcome,
  discoverDeliverableFiles
} = require('../../shiyundesign/agent-outcome')
const { extractTargetDirFromTask, ensureTargetDir } = require('../../shiyundesign/subagent-task-cwd')

function loadEnv () {
  try {
    require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true })
  } catch (e) { /* optional */ }
  try {
    require('dotenv').config({ path: path.join(process.cwd(), '.env.local'), quiet: true })
  } catch (e) { /* optional */ }
}

/** @param {string[]} argv */
function parseArgs (argv) {
  const out = { task: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--cwd') { out.cwd = argv[++i] ?? ''; continue }
    if (arg === '--task') { out.task = argv[++i] ?? ''; continue }
    if (arg === '--max-rounds') { out.maxRounds = argv[++i] ?? '1024'; continue }
    if (arg === '--permission-mode') { out.permissionMode = argv[++i] ?? 'bypassPermissions'; continue }
    if (arg === '--assets-root') { out.assetsRoot = argv[++i] ?? ''; continue }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
  }
  return out
}

function usage () {
  process.stderr.write(
    'Usage: shiyundesign-agent --cwd <dir> --task <text> [--assets-root <dir>] [--max-rounds N]\n' +
    'Env: DEEPSEEK_API_KEY, CHOMIRCODE_AGENT_BIN, AIFRONT_MAX_ROUNDS\n'
  )
}

/** @param {import('child_process').ReadableStream | null | undefined} stream */
function readStream (stream) {
  if (!stream) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.setEncoding('utf8')
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', () => resolve(chunks.join('')))
    stream.on('error', reject)
  })
}

/** @param {Record<string, unknown>} payload */
function emitResult (payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

/** @param {string} p */
function statIsDir (p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function resolveTaskCwd (userTask, fallbackCwd) {
  const taskCwd = extractTargetDirFromTask(userTask)
  if (taskCwd) return ensureTargetDir(taskCwd, 'shiyundesign')
  return path.resolve(fallbackCwd)
}

async function main () {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  const cwd = resolveTaskCwd(String(args.task || ''), String(args.cwd || process.cwd()))
  if (!fs.existsSync(cwd) || !statIsDir(cwd)) {
    emitResult({ ok: false, error: 'cwd is not a directory: ' + cwd })
    process.exit(2)
  }

  const userTask = String(args.task || '').trim()
  if (!userTask) {
    usage()
    emitResult({ ok: false, error: 'ShiyunDesign: --task is required' })
    process.exit(2)
  }

  const assetsRoot = args.assetsRoot
    ? path.resolve(String(args.assetsRoot))
    : path.join(RUNTIME_ROOT, 'assets')

  let composed
  try {
    composed = composeDesignTask({
      assetsRoot,
      userTask,
      cwd,
      runtimeRoot: RUNTIME_ROOT,
      maxChars: MAX_PROMPT_CHARS
    })
  } catch (error) {
    emitResult({ ok: false, error: String(error instanceof Error ? error.message : error) })
    process.exit(2)
  }

  const chomirCodeBin = resolveBundledChomirCodeBin(RUNTIME_ROOT)
  const child = spawn(
    process.execPath,
    [
      chomirCodeBin,
      '--cwd',
      cwd,
      '--max-rounds',
      String(args.maxRounds ?? process.env.AIFRONT_MAX_ROUNDS ?? '1024'),
      '--permission-mode',
      String(args.permissionMode ?? 'bypassPermissions'),
      '--task',
      composed
    ],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )

  const stdout = await readStream(child.stdout)
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
  })

  const parsed = parseAgentStdout(stdout, 'ShiyunDesign')
  const outcome = resolveAgentOutcome(parsed, exitCode, {
    cwd,
    taskText: userTask
  })

  if (outcome.stopReason === 'aborted') {
    emitResult({
      ...parsed,
      ok: false,
      aborted: true,
      finalAnswer: outcome.text,
      error: undefined
    })
    process.exit(130)
  }

  if (outcome.stopReason === 'completed') {
    const changed = parsed.changed && parsed.changed.length
      ? parsed.changed
      : discoverDeliverableFiles({ cwd, taskText: userTask })
    try {
      updateDesignBrief(cwd, { userTask, changed, finalAnswer: outcome.text })
    } catch { /* optional */ }

    const opened = openHtmlPreviewIfPresent(cwd, changed)
    const finalAnswer = opened
      ? outcome.text + '\n\n已在浏览器打开预览：`' + path.basename(opened) + '`'
      : outcome.text
    emitResult({
      ...parsed,
      ok: true,
      finalAnswer,
      error: undefined,
      changed
    })
    process.exit(0)
  }

  emitResult({
    ...parsed,
    ok: false,
    error: outcome.text,
    finalAnswer: parsed.finalAnswer,
    sessionId: parsed.sessionId,
    changed: parsed.changed
  })
  process.exit(exitCode === 0 ? 1 : exitCode)
}

main().catch((error) => {
  emitResult({ ok: false, error: String(error instanceof Error ? error.message : error) })
  process.exit(1)
})
