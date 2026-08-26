/**
 * ChomirCode headless one-shot coding agent for DSH / VS Code Chat integration.
 * stdout: one JSON result line only.
 * With --events-jsonl: progress events on stderr as "CHOMIRCODE_EVENT {json}" lines.
 * Other diagnostics go to stderr without that prefix.
 */
'use strict'

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')

function loadEnv () {
  try {
    require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true })
  } catch (e) { /* optional */ }
  try {
    require('dotenv').config({ path: path.join(process.cwd(), '.env.local'), quiet: true })
  } catch (e) { /* optional */ }
}

function parseArgs (argv) {
  const out = {
    cwd: process.cwd(),
    task: '',
    model: '',
    permissionMode: process.env.CHOMIRCODE_PERMISSION_MODE || process.env.AIFRONT_PERMISSION_MODE || 'bypassPermissions',
    maxRounds: parseInt(process.env.CHOMIRCODE_MAX_ROUNDS || process.env.AIFRONT_MAX_ROUNDS || '40', 10) || 40,
    sessionId: '',
    activeFile: '',
    eventsJsonl: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cwd' && argv[i + 1]) { out.cwd = path.resolve(argv[++i]); continue }
    if (a === '--task' && argv[i + 1]) { out.task = argv[++i]; continue }
    if (a === '--model' && argv[i + 1]) { out.model = argv[++i]; continue }
    if (a === '--permission-mode' && argv[i + 1]) { out.permissionMode = argv[++i]; continue }
    if (a === '--max-rounds' && argv[i + 1]) { out.maxRounds = parseInt(argv[++i], 10) || out.maxRounds; continue }
    if (a === '--session-id' && argv[i + 1]) { out.sessionId = argv[++i]; continue }
    if (a === '--active-file' && argv[i + 1]) { out.activeFile = String(argv[++i]); continue }
    if (a === '--events-jsonl') { out.eventsJsonl = true; continue }
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--' && argv[i + 1]) {
      out.task = argv.slice(i + 1).join(' ')
      break
    }
  }
  return out
}

function usage () {
  process.stderr.write(
    'Usage: chomircode-agent --cwd <dir> --task <text> [--active-file <rel>] [--events-jsonl]\n' +
    '       echo task | chomircode-agent --cwd <dir> --task -\n' +
    'Env: DEEPSEEK_API_KEY, AIFRONT_PERMISSION_MODE, AIFRONT_MAX_ROUNDS\n'
  )
}

function readStdin () {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(chunks.join('')))
    process.stdin.on('error', reject)
  })
}

function emitResult (payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function createSendEvent (eventsJsonl) {
  return (event, data) => {
    try {
      const line = JSON.stringify({ event, data: data || {} })
      if (eventsJsonl) {
        // Keep under pipe-friendly size; VS Code extension parses these lines.
        const clipped = line.length > 32000 ? line.slice(0, 32000) + '…"}' : line
        process.stderr.write('CHOMIRCODE_EVENT ' + clipped + '\n')
      } else {
        process.stderr.write('[chomircode-agent] ' + line.slice(0, 4000) + '\n')
      }
    } catch (e) { /* ignore */ }
  }
}

async function main () {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  let task = (args.task || '').trim()
  if (task === '-') {
    task = (await readStdin()).trim()
  } else if (!task) {
    const fromStdin = (await readStdin()).trim()
    if (fromStdin) task = fromStdin
  }

  if (!task) {
    usage()
    emitResult({ ok: false, error: 'missing --task' })
    process.exit(2)
  }

  const cwd = path.resolve(args.cwd)
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    emitResult({ ok: false, error: 'cwd is not a directory: ' + cwd })
    process.exit(2)
  }

  const sessionId = args.sessionId || ('chomircode_sub_' + Date.now().toString(16))
  const abortRegistry = require('../engine/panda/abortRegistry')

  const onSignal = () => {
    try { abortRegistry.abortRun(sessionId) } catch (e) { /* ignore */ }
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const { runPandaAgent } = require('../engine/panda')
  const sendEvent = createSendEvent(!!args.eventsJsonl)

  const context = {
    sessionId,
    model: args.model || process.env.DEEPSEEK_MODEL || '',
    permissionMode: args.permissionMode,
    planMode: false
  }
  if (args.activeFile) {
    context.activeFile = args.activeFile
    context.preferredFile = args.activeFile
  }

  try {
    const result = await runPandaAgent({
      message: task,
      projectInfo: { root: cwd, name: path.basename(cwd) },
      context,
      maxRounds: args.maxRounds,
      sendEvent
    })

    const text = (result && result.text) ? String(result.text) : ''
    if (result && result.aborted) {
      emitResult({
        ok: false,
        aborted: true,
        finalAnswer: text || '已中断',
        sessionId,
        changed: (result.changed || []).map((c) => c.file).filter(Boolean)
      })
      process.exit(130)
    }

    emitResult({
      ok: true,
      finalAnswer: text || '（无输出）',
      sessionId,
      changed: (result && result.changed || []).map((c) => c.file).filter(Boolean)
    })
    process.exit(0)
  } catch (err) {
    const msg = (err && err.message) ? String(err.message) : String(err)
    process.stderr.write('[chomircode-agent] fatal: ' + msg + '\n')
    emitResult({ ok: false, error: msg, sessionId })
    process.exit(1)
  }
}

main()
