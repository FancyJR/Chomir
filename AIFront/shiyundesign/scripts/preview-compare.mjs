#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function usage () {
  console.log(`Usage:
  node preview-compare.mjs --original <png> --clone <png> [--out visual-diff.json] [--diff visual-diff.png] [--threshold 0.08]

Wraps web-clone visual-diff.mjs for pixel-level comparison after preview-capture.
`)
}

function parseArgs (argv) {
  const out = { original: '', clone: '', out: 'visual-diff.json', diff: '', threshold: 0.08 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--original') out.original = argv[++i] || ''
    else if (arg === '--clone') out.clone = argv[++i] || ''
    else if (arg === '--out') out.out = argv[++i] || 'visual-diff.json'
    else if (arg === '--diff') out.diff = argv[++i] || ''
    else if (arg === '--threshold') out.threshold = Number(argv[++i] || '0.08')
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.original || !args.clone) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const visualDiff = path.resolve(scriptDir, '../assets/skills/web-clone/scripts/visual-diff.mjs')
  const cmdArgs = [
    visualDiff,
    '--original', path.resolve(args.original),
    '--clone', path.resolve(args.clone),
    '--out', path.resolve(args.out),
    '--threshold', String(args.threshold)
  ]
  if (args.diff) cmdArgs.push('--diff', path.resolve(args.diff))

  const result = spawnSync(process.execPath, cmdArgs, { encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
