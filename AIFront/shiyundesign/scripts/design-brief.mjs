#!/usr/bin/env node
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { loadDesignBrief, updateDesignBrief, formatBriefForPrompt } = requireFromHere('../lib/design-brief.js')

function usage () {
  console.log(`Usage:
  node design-brief.mjs show --cwd <dir>
  node design-brief.mjs update --cwd <dir> --task "<text>" [--changed file1,file2]
`)
}

function parseArgs (argv) {
  const out = { command: 'show', cwd: process.cwd(), task: '', changed: '' }
  if (argv[0] && !argv[0].startsWith('-')) out.command = argv.shift()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--cwd') out.cwd = resolve(argv[++i] || '')
    else if (arg === '--task') out.task = argv[++i] || ''
    else if (arg === '--changed') out.changed = argv[++i] || ''
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  if (args.command === 'show') {
    const brief = loadDesignBrief(args.cwd)
    if (!brief) {
      process.stdout.write(JSON.stringify({ ok: true, brief: null }) + '\n')
      return
    }
    process.stdout.write(JSON.stringify({ ok: true, brief, text: formatBriefForPrompt(brief) }) + '\n')
    return
  }

  if (args.command === 'update') {
    const changed = args.changed ? args.changed.split(',').map((s) => s.trim()).filter(Boolean) : []
    const brief = updateDesignBrief(args.cwd, { userTask: args.task, changed })
    process.stdout.write(JSON.stringify({ ok: true, brief }) + '\n')
    return
  }

  usage()
  process.exit(1)
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
