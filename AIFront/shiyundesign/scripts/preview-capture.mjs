#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadPlaywright, launchChromium } from '../assets/skills/web-clone/scripts/lib/playwright-loader.mjs'

function usage () {
  console.log(`Usage:
  node preview-capture.mjs --html <index.html> --out <screenshot.png> [--width 1440] [--height 900] [--full-page]

Captures a PNG screenshot of a local HTML file. Uses system Chrome/Edge when available (same loader as web-clone).
`)
}

function parseArgs (argv) {
  const out = { html: '', out: '', width: 1440, height: 900, fullPage: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--html') out.html = argv[++i] || ''
    else if (arg === '--out') out.out = argv[++i] || ''
    else if (arg === '--width') out.width = Number(argv[++i] || '1440')
    else if (arg === '--height') out.height = Number(argv[++i] || '900')
    else if (arg === '--full-page') out.fullPage = true
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.html || !args.out) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const htmlAbs = path.resolve(args.html)
  const outAbs = path.resolve(args.out)
  if (!fs.existsSync(htmlAbs)) throw new Error(`HTML not found: ${htmlAbs}`)

  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  const fileUrl = pathToFileURL(htmlAbs).href
  const pw = loadPlaywright()
  const browser = await launchChromium(pw.chromium)
  try {
    const page = await browser.newPage({ viewport: { width: args.width, height: args.height } })
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.screenshot({ path: outAbs, fullPage: args.fullPage })
  } finally {
    await browser.close()
  }

  process.stdout.write(JSON.stringify({ ok: true, html: htmlAbs, out: outAbs }) + '\n')
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n')
  process.exit(1)
})
