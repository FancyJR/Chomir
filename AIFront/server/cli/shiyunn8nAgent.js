/**
 * ShiyunN8n headless CLI: n8n Instance-AI assets + ChomirCode executor.
 * stdout: last line JSON { ok, finalAnswer, error, aborted, changed, sessionId }
 *
 * Layouts:
 * - monorepo: AIFront/server/cli → AIFront/shiyunn8n
 * - vendored: vendor/shiyunn8n-runtime/server/cli → vendor/shiyunn8n-runtime
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const HERE = __dirname
const MAX_PROMPT_CHARS = 48_000

function resolveRuntimeRoot () {
  const monorepo = path.resolve(HERE, '..', '..', 'shiyunn8n')
  if (fs.existsSync(path.join(monorepo, 'assets'))) return monorepo
  const vendored = path.resolve(HERE, '..', '..')
  if (fs.existsSync(path.join(vendored, 'assets'))) return vendored
  return monorepo
}

function resolveAifrontRoot (runtimeRoot) {
  // monorepo: runtime is AIFront/shiyunn8n → parent is AIFront
  // vendored: no AIFront parent; chomircode bin via env or sibling search
  const parent = path.resolve(runtimeRoot, '..')
  if (fs.existsSync(path.join(parent, 'bin', 'chomircode-agent.js'))) return parent
  return parent
}

const RUNTIME_ROOT = resolveRuntimeRoot()
const ROOT = resolveAifrontRoot(RUNTIME_ROOT)

const { composeN8nTask } = require(path.join(RUNTIME_ROOT, 'lib', 'compose-n8n-task'))
const { resolveBundledChomirCodeBin } = require(path.join(RUNTIME_ROOT, 'lib', 'resolve-chomircode-bin'))
const {
  parseAgentStdout,
  resolveAgentOutcome,
  discoverDeliverableFiles,
} = require(path.join(RUNTIME_ROOT, 'agent-outcome'))
const { extractTargetDirFromTask, ensureTargetDir } = require(path.join(RUNTIME_ROOT, 'subagent-task-cwd'))

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
    'Usage: shiyunn8n-agent --cwd <dir> --task <text> [--assets-root <dir>] [--max-rounds N]\n' +
    'Env: DEEPSEEK_API_KEY, CHOMIRCODE_AGENT_BIN, AIFRONT_MAX_ROUNDS, N8N_URL, N8N_API_KEY\n'
  )
}

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

function emitResult (payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function statIsDir (p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function resolveTaskCwd (userTask, fallbackCwd) {
  const taskCwd = extractTargetDirFromTask(userTask)
  if (taskCwd) return ensureTargetDir(taskCwd, 'shiyunn8n')
  return path.resolve(fallbackCwd)
}

async function main () {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  const userTask = String(args.task || '').trim()
  if (!userTask) {
    usage()
    emitResult({ ok: false, error: 'ShiyunN8n: --task is required' })
    process.exit(2)
  }

  const cwd = resolveTaskCwd(userTask, String(args.cwd || process.cwd()))
  if (!fs.existsSync(cwd) || !statIsDir(cwd)) {
    emitResult({ ok: false, error: 'cwd is not a directory: ' + cwd })
    process.exit(2)
  }

  const assetsRoot = args.assetsRoot
    ? path.resolve(String(args.assetsRoot))
    : path.join(RUNTIME_ROOT, 'assets')

  let composed
  try {
    composed = composeN8nTask({ assetsRoot, userTask, maxChars: MAX_PROMPT_CHARS })
  } catch (error) {
    emitResult({ ok: false, error: String(error instanceof Error ? error.message : error) })
    process.exit(2)
  }

  let chomirCodeBin
  try {
    chomirCodeBin = resolveBundledChomirCodeBin(RUNTIME_ROOT)
  } catch (error) {
    emitResult({ ok: false, error: String(error instanceof Error ? error.message : error) })
    process.exit(2)
  }

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
      composed,
    ],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  )

  const stdout = await readStream(child.stdout)
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
  })

  const parsed = parseAgentStdout(stdout, 'ShiyunN8n')
  const outcome = resolveAgentOutcome(parsed, exitCode, { cwd, taskText: userTask })

  if (outcome.stopReason === 'aborted') {
    emitResult({ ...parsed, ok: false, aborted: true, finalAnswer: outcome.text, error: undefined })
    process.exit(130)
  }

  if (outcome.stopReason === 'completed') {
    const changed = parsed.changed && parsed.changed.length
      ? parsed.changed
      : discoverDeliverableFiles({ cwd })
    emitResult({ ...parsed, ok: true, finalAnswer: outcome.text, error: undefined, changed })
    process.exit(0)
  }

  emitResult({
    ...parsed,
    ok: false,
    error: outcome.text,
    finalAnswer: parsed.finalAnswer,
    sessionId: parsed.sessionId,
    changed: parsed.changed,
  })
  process.exit(exitCode === 0 ? 1 : exitCode)
}

main().catch((error) => {
  emitResult({ ok: false, error: String(error instanceof Error ? error.message : error) })
  process.exit(1)
})
