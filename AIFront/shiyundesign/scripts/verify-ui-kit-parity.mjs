#!/usr/bin/env node
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { verifyUiKitParity } = requireFromHere('../lib/ui-kit/verify-parity.js')

function usage () {
  console.log(`Usage:
  node verify-ui-kit-parity.mjs --cwd <dir> --slug <slug> [--source index.html]
`)
}

function parseArgs (argv) {
  const out = { cwd: process.cwd(), slug: '', sourcePath: 'index.html' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--cwd') out.cwd = resolve(argv[++i] || '')
    else if (arg === '--slug') out.slug = argv[++i] || ''
    else if (arg === '--source') out.sourcePath = argv[++i] || 'index.html'
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.slug) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const report = verifyUiKitParity(args.cwd, { slug: args.slug, sourcePath: args.sourcePath })
  process.stdout.write(JSON.stringify({ ok: report.status === 'ok', ...report }) + '\n')
  process.exit(report.status === 'ok' ? 0 : 2)
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
