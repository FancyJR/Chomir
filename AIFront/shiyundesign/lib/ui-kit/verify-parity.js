'use strict'

const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const PARITY_THRESHOLD = 0.85
const STRUCTURAL_TAGS = [
  'div', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main',
  'button', 'input', 'select', 'textarea', 'form', 'a', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'svg', 'label', 'p'
]

function countElements (html) {
  const counts = {}
  for (const tag of STRUCTURAL_TAGS) {
    counts[tag] = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length
  }
  return counts
}

function totalElementCount (counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

function elementParityScore (source, decomposed) {
  const gaps = []
  let totalDelta = 0
  let totalSource = 0
  for (const tag of STRUCTURAL_TAGS) {
    const s = source[tag] || 0
    const d = decomposed[tag] || 0
    const delta = Math.abs(s - d)
    totalDelta += delta
    totalSource += s
    if (s > 0 && delta / Math.max(s, 1) > 0.5) {
      gaps.push({ kind: 'element', message: `${s} <${tag}> in source, ${d} in decomposed (delta ${delta})` })
    }
  }
  if (totalSource === 0) return { score: 1, gaps }
  return { score: Math.max(0, 1 - totalDelta / totalSource), gaps }
}

function stripTags (html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function visibleWords (html) {
  const text = stripTags(html).toLowerCase()
  return new Set(text.match(/[a-z][a-z0-9]{2,}/g) || [])
}

function textCoverage (sourceWords, decomposedWords) {
  if (sourceWords.size === 0) return { score: 1, matched: 0 }
  let matched = 0
  for (const w of sourceWords) {
    if (decomposedWords.has(w)) matched++
  }
  return { score: matched / sourceWords.size, matched }
}

function extractTokenValues (text) {
  const values = new Set()
  for (const m of text.match(/#[0-9a-fA-F]{3,8}\b/g) || []) values.add(m.toLowerCase())
  for (const m of text.match(/rgba?\([^)]+\)/g) || []) values.add(m.replace(/\s+/g, '').toLowerCase())
  for (const m of text.match(/\b\d+(?:\.\d+)?(?:px|rem|em)\b/g) || []) values.add(m.toLowerCase())
  return values
}

function tokenCoverageScore (source, tokensCss) {
  if (source.size === 0) return { score: 1, matched: 0, gaps: [] }
  const tokenValues = extractTokenValues(tokensCss)
  const gaps = []
  let matched = 0
  for (const v of source) {
    if (tokenValues.has(v)) matched++
    else gaps.push({ kind: 'token', message: `value ${v} appears in source but missing from tokens.css` })
  }
  return { score: matched / source.size, matched, gaps: gaps.slice(0, 8) }
}

/**
 * @param {string} cwd
 * @param {{ slug: string, sourcePath?: string }} opts
 */
function verifyUiKitParity (cwd, opts) {
  const slug = opts.slug
  const sourcePath = join(cwd, opts.sourcePath || 'index.html')
  const decomposedPath = join(cwd, 'ui_kits', slug, 'index.html')
  const tokensPath = join(cwd, 'ui_kits', slug, 'tokens.css')

  if (!existsSync(sourcePath) || !existsSync(decomposedPath)) {
    const missing = []
    if (!existsSync(sourcePath)) missing.push(opts.sourcePath || 'index.html')
    if (!existsSync(decomposedPath)) missing.push(`ui_kits/${slug}/index.html`)
    return {
      parityScore: 0,
      status: 'needs_iteration',
      gaps: [{ kind: 'element', message: `missing artifact(s): ${missing.join(', ')}` }]
    }
  }

  const sourceHtml = readFileSync(sourcePath, 'utf8')
  const decomposedHtml = readFileSync(decomposedPath, 'utf8')
  const tokensCss = existsSync(tokensPath) ? readFileSync(tokensPath, 'utf8') : ''

  const sourceCounts = countElements(sourceHtml)
  const decomposedCounts = countElements(decomposedHtml)
  const elementResult = elementParityScore(sourceCounts, decomposedCounts)

  const sourceWords = visibleWords(sourceHtml)
  const decomposedWords = visibleWords(decomposedHtml)
  const textResult = textCoverage(sourceWords, decomposedWords)

  const sourceTokenValues = extractTokenValues(sourceHtml)
  const tokenResult = tokenCoverageScore(sourceTokenValues, tokensCss)

  const parityScore = elementResult.score * 0.4 + textResult.score * 0.3 + tokenResult.score * 0.3
  const status = parityScore >= PARITY_THRESHOLD ? 'ok' : 'needs_iteration'
  const gaps = [...elementResult.gaps, ...tokenResult.gaps]
  if (textResult.score < 0.7) {
    gaps.push({
      kind: 'text',
      message: `only ${textResult.matched}/${sourceWords.size} unique source words present in decomposed index.html`
    })
  }

  return {
    parityScore: Number(parityScore.toFixed(3)),
    status,
    threshold: PARITY_THRESHOLD,
    signals: {
      elementCountParity: Number(elementResult.score.toFixed(3)),
      visibleTextCoverage: Number(textResult.score.toFixed(3)),
      tokenCoverage: Number(tokenResult.score.toFixed(3))
    },
    counts: {
      sourceElements: totalElementCount(sourceCounts),
      decomposedElements: totalElementCount(decomposedCounts),
      sourceWords: sourceWords.size,
      decomposedWordsMatched: textResult.matched,
      sourceTokens: sourceTokenValues.size,
      tokenCssMatched: tokenResult.matched
    },
    gaps
  }
}

module.exports = { verifyUiKitParity, PARITY_THRESHOLD }
