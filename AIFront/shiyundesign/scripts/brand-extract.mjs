#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { extractBrandFromFile, tokensToDesignMdSection, tokensToCssVars } = requireFromHere('../lib/brand/extract-brand.js')

function usage () {
  console.log(`Usage:
  node brand-extract.mjs --file <tailwind.config.js|tokens.css|tokens.json> [--out DESIGN.extracted.md] [--css tokens.extracted.css] [--json tokens.json]
`)
}

function parseArgs (argv) {
  const out = { file: '', outMd: '', outCss: '', outJson: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--file') out.file = argv[++i] || ''
    else if (arg === '--out') out.outMd = argv[++i] || ''
    else if (arg === '--css') out.outCss = argv[++i] || ''
    else if (arg === '--json') out.outJson = argv[++i] || ''
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

function writeOut (filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const abs = resolve(args.file)
  const result = extractBrandFromFile(abs)
  const payload = {
    ok: true,
    source: result.source,
    tokenCount: result.tokens.length,
    unresolved: result.unresolved,
    tokens: result.tokens
  }

  if (args.outMd) writeOut(resolve(args.outMd), tokensToDesignMdSection(result.tokens) + '\n')
  if (args.outCss) writeOut(resolve(args.outCss), tokensToCssVars(result.tokens))
  if (args.outJson) writeOut(resolve(args.outJson), JSON.stringify(payload, null, 2) + '\n')

  process.stdout.write(JSON.stringify(payload) + '\n')
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
