'use strict'

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

function inferType (prop, value) {
  const p = prop.toLowerCase()
  if (/font-size|text-size/.test(p)) return 'fontSize'
  if (/font-family|font-sans|font-mono|font-serif|typeface/.test(p)) return 'fontFamily'
  if (/line-height|leading/.test(p)) return 'lineHeight'
  if (/radius|rounded|border-radius/.test(p)) return 'radius'
  if (/shadow|elevation/.test(p)) return 'shadow'
  if (/spacing|space|gap|padding|margin|indent|offset/.test(p)) return 'spacing'
  if (/^text-/.test(p)) {
    if (looksLikeColor(value)) return 'color'
    if (looksLikeLength(value)) return 'fontSize'
    if (/^text-(xs|sm|base|lg|xl|\d+xl)$/.test(p)) return 'fontSize'
    return 'color'
  }
  if (/color|palette|brand|accent|fg|bg|foreground|background|fill|stroke|ring|border-color/.test(p)) {
    return 'color'
  }
  if (looksLikeColor(value)) return 'color'
  return null
}

function extractDeclarations (source) {
  const results = []
  const blockRe = /(?::root|\[data-theme[^\]]*\])\s*\{([^}]*)\}/g
  for (const blockMatch of source.matchAll(blockRe)) {
    const body = blockMatch[1]
    if (!body) continue
    for (const dm of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const prop = dm[1]?.trim()
      const value = dm[2]?.trim()
      if (prop && value) results.push({ prop, value })
    }
  }
  return results
}

/** @param {string} source */
function extractFromCssVarsText (source) {
  const tokens = []
  for (const { prop, value } of extractDeclarations(source)) {
    const tokenType = inferType(prop, value)
    if (!tokenType) continue
    tokens.push({
      type: tokenType,
      name: prop,
      value,
      origin: 'css-vars',
      group: prop.split('-').slice(0, 3).join('-')
    })
  }
  return tokens
}

module.exports = { extractFromCssVarsText }
