'use strict'

const THEME_SECTIONS = [
  { key: 'colors', tokenType: 'color' },
  { key: 'color', tokenType: 'color' },
  { key: 'backgroundColor', tokenType: 'color' },
  { key: 'textColor', tokenType: 'color' },
  { key: 'borderColor', tokenType: 'color' },
  { key: 'fontSize', tokenType: 'fontSize' },
  { key: 'fontFamily', tokenType: 'fontFamily' },
  { key: 'spacing', tokenType: 'spacing' },
  { key: 'borderRadius', tokenType: 'radius' },
  { key: 'boxShadow', tokenType: 'shadow' },
  { key: 'lineHeight', tokenType: 'lineHeight' }
]

function looksLikeColor (value) {
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(value) ||
    /^rgba?\s*\(/.test(value) ||
    /^hsla?\s*\(/.test(value) ||
    /^oklch\s*\(/.test(value) ||
    /^color\s*\(/.test(value)
  )
}

function looksLikeLength (value) {
  return /^-?\d*\.?\d+(px|rem|em|%|vh|vw|ch|ex|pt|cm|mm|in)\b/i.test(String(value).trim())
}

function extractBodyAt (text, bracePos) {
  if (text[bracePos] !== '{') return null
  let depth = 0
  let quote = null
  let escaped = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = bracePos; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(bracePos + 1, i)
    }
  }
  return null
}

function extractAllSectionBodies (source, sectionKey) {
  const bodies = []
  const sectionRe = new RegExp(`\\b${sectionKey}\\s*:\\s*\\{`, 'g')
  for (const match of source.matchAll(sectionRe)) {
    const startBrace = (match.index ?? 0) + match[0].length - 1
    const body = extractBodyAt(source, startBrace)
    if (body !== null) bodies.push(body)
  }
  return bodies
}

function stripNestedBlocks (body) {
  let result = ''
  let depth = 0
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') { if (depth > 0) depth-- }
    else if (depth === 0) result += ch
  }
  return result
}

function leafValueFromMatch (m) {
  const strValue = m[2] ?? m[3]
  if (strValue !== undefined) return strValue
  const arrRaw = m[4]
  if (arrRaw === undefined) return undefined
  const firstEl = arrRaw.match(/['"]?([^'",]+)['"]?/)
  return firstEl?.[1]?.trim()
}

function collectLeafPairs (body, prefix) {
  const results = []
  const flat = stripNestedBlocks(body)
  const leafRe = /['"]?([\w-]+)['"]?\s*:\s*(?:'([^']+)'|"([^"]+)"|\[(['"]?[^[\]]+['"]?)\])/g
  for (const m of flat.matchAll(leafRe)) {
    const key = m[1]
    if (!key || ['DEFAULT', 'screens', 'container'].includes(key)) continue
    const value = leafValueFromMatch(m)
    if (!value) continue
    results.push({ name: prefix ? `${prefix}.${key}` : key, value })
  }
  const nestedRe = /['"]?([\w-]+)['"]?\s*:\s*\{/g
  for (const nm of body.matchAll(nestedRe)) {
    const subKey = nm[1]
    if (!subKey) continue
    const subStart = (nm.index ?? 0) + nm[0].length - 1
    const subBody = extractBodyAt(body, subStart)
    if (subBody !== null) {
      const subPrefix = prefix ? `${prefix}.${subKey}` : subKey
      results.push(...collectLeafPairs(subBody, subPrefix))
    }
  }
  return results
}

function inferTypeFromCssProp (prop, value) {
  if (/font-size|text-size/.test(prop)) return 'fontSize'
  if (/font-family/.test(prop)) return 'fontFamily'
  if (/line-height|leading/.test(prop)) return 'lineHeight'
  if (/radius|rounded/.test(prop)) return 'radius'
  if (/shadow/.test(prop)) return 'shadow'
  if (/spacing|gap|padding|margin|space/.test(prop)) return 'spacing'
  if (/^text-/.test(prop)) {
    if (looksLikeColor(value)) return 'color'
    if (looksLikeLength(value)) return 'fontSize'
    if (/^text-(xs|sm|base|lg|xl|\d+xl)$/.test(prop)) return 'fontSize'
    return 'color'
  }
  if (/color|bg|border|fill|stroke|ring/.test(prop)) return 'color'
  if (looksLikeColor(value)) return 'color'
  return null
}

function collectV4Declarations (body, seen) {
  const out = []
  for (const dm of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const prop = dm[1]
    const rawValue = dm[2]?.trim()
    if (!prop || !rawValue || seen.has(prop)) continue
    const tokenType = inferTypeFromCssProp(prop, rawValue)
    if (!tokenType) continue
    seen.add(prop)
    out.push({
      type: tokenType,
      name: prop,
      value: rawValue,
      origin: 'tailwind-config',
      group: prop.split('-').slice(0, 2).join('.')
    })
  }
  return out
}

function extractFromV4Theme (source) {
  const results = []
  const seen = new Set()
  for (const m of source.matchAll(/@theme\b[^{]*\{/g)) {
    const blockStart = (m.index ?? 0) + m[0].length - 1
    const body = extractBodyAt(source, blockStart)
    if (!body) continue
    results.push(...collectV4Declarations(body, seen))
  }
  return results
}

function extractFromV3Config (source) {
  const results = []
  for (const section of THEME_SECTIONS) {
    for (const body of extractAllSectionBodies(source, section.key)) {
      for (const { name, value } of collectLeafPairs(body, section.key)) {
        if (!value) continue
        if (value.includes('(') && !looksLikeColor(value)) continue
        results.push({
          type: section.tokenType,
          name,
          value,
          origin: 'tailwind-config',
          group: name.split('.').slice(0, 2).join('.')
        })
      }
    }
  }
  const seen = new Set()
  const deduped = []
  for (const token of results) {
    if (!seen.has(token.name)) {
      seen.add(token.name)
      deduped.push(token)
    }
  }
  return deduped
}

/** @param {string} source */
function extractFromTailwindText (source) {
  if (/@theme\b[^{]*\{/.test(source)) return extractFromV4Theme(source)
  return extractFromV3Config(source)
}

module.exports = { extractFromTailwindText }
