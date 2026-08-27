#!/usr/bin/env node
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { generateImageAsset } = requireFromHere('../lib/generate-image.js')

function usage () {
  console.log(`Usage:
  node generate-image.mjs --cwd <dir> --prompt "<text>" [--purpose hero|product|poster|background|illustration|logo|other] [--filename hero-bg] [--aspect-ratio 16:9|1:1|9:16] [--alt "..."]

Env: SHIYUNDESIGN_IMAGE_API_KEY or OPENAI_API_KEY; optional SHIYUNDESIGN_IMAGE_API_URL, SHIYUNDESIGN_IMAGE_MODEL
`)
}

function parseArgs (argv) {
  const out = { cwd: process.cwd(), prompt: '', purpose: 'other', filenameHint: '', aspectRatio: '16:9', alt: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--cwd') out.cwd = resolve(argv[++i] || '')
    else if (arg === '--prompt') out.prompt = argv[++i] || ''
    else if (arg === '--purpose') out.purpose = argv[++i] || 'other'
    else if (arg === '--filename') out.filenameHint = argv[++i] || ''
    else if (arg === '--aspect-ratio') out.aspectRatio = argv[++i] || '16:9'
    else if (arg === '--alt') out.alt = argv[++i] || ''
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.prompt) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const asset = await generateImageAsset(args.cwd, {
    prompt: args.prompt,
    purpose: args.purpose,
    filenameHint: args.filenameHint,
    aspectRatio: args.aspectRatio,
    alt: args.alt
  })
  process.stdout.write(JSON.stringify({ ok: true, ...asset }) + '\n')
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
