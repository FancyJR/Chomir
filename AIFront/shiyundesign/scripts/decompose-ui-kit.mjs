#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { decomposeUiKit } = requireFromHere('../lib/ui-kit/decompose.js')

function usage () {
  console.log(`Usage:
  node decompose-ui-kit.mjs --cwd <dir> --plan <plan.json>
`)
}

function parseArgs (argv) {
  const out = { cwd: process.cwd(), plan: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--cwd') out.cwd = resolve(argv[++i] || '')
    else if (arg === '--plan') out.plan = argv[++i] || ''
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.plan) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'))
  const result = decomposeUiKit(args.cwd, plan)
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
