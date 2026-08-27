'use strict'

const { readFileSync, existsSync } = require('node:fs')
const { extname, basename } = require('node:path')
const { extractFromCssVarsText } = require('./css-var-extractor')
const { extractFromTailwindText } = require('./tailwind-extractor')
const { importDtcgJson } = require('./dtcg-importer')

/** @param {string} filePath */
function extractBrandFromFile (filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`brand extract: file not found: ${filePath}`)
  }
  const source = readFileSync(filePath, 'utf8')
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') {
    const parsed = JSON.parse(source)
    const { tokens, unresolved } = importDtcgJson(parsed)
    return { source: basename(filePath), tokens, unresolved }
  }
  if (/tailwind/i.test(basename(filePath)) || ext === '.js' || ext === '.cjs' || ext === '.mjs' || ext === '.ts') {
    return { source: basename(filePath), tokens: extractFromTailwindText(source), unresolved: [] }
  }
  return { source: basename(filePath), tokens: extractFromCssVarsText(source), unresolved: [] }
}

/** @param {Array<{ type: string, name: string, value: string }>} tokens */
function tokensToDesignMdSection (tokens) {
  if (!tokens.length) return ''
  const byType = {}
  for (const t of tokens) {
    const bucket = byType[t.type] || []
    bucket.push(t)
    byType[t.type] = bucket
  }
  const lines = [
    '# Extracted brand tokens',
    '',
    '_Auto-extracted by ShiyunDesign brand-extract. Merge into DESIGN.md; do not treat as authoritative without review._',
    ''
  ]
  for (const [type, items] of Object.entries(byType)) {
    lines.push(`## ${type}`, '')
    for (const item of items.slice(0, 40)) {
      lines.push(`- \`${item.name}\`: ${item.value}`)
    }
    if (items.length > 40) lines.push(`- …and ${items.length - 40} more`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** @param {Array<{ type: string, name: string, value: string }>} tokens */
function tokensToCssVars (tokens) {
  const lines = [':root {']
  for (const t of tokens) {
    const name = t.name.startsWith('--') ? t.name : `--${t.name.replace(/\./g, '-')}`
    lines.push(`  ${name}: ${t.value};`)
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

module.exports = { extractBrandFromFile, tokensToDesignMdSection, tokensToCssVars }
