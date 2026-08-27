'use strict'

const DTCG_TYPE_MAP = {
  color: 'color',
  fontFamily: 'fontFamily',
  fontSize: 'fontSize',
  shadow: 'shadow',
  lineHeight: 'lineHeight'
}

function resolveTypeFromPath (pathStr) {
  const p = pathStr.toLowerCase()
  if (/color|palette|fill|bg|background|foreground/.test(p)) return 'color'
  if (/font-family|fontfamily|typeface/.test(p)) return 'fontFamily'
  if (/font-size|fontsize|text-size/.test(p)) return 'fontSize'
  if (/line-height|lineheight|leading/.test(p)) return 'lineHeight'
  if (/radius|rounded/.test(p)) return 'radius'
  if (/shadow|elevation/.test(p)) return 'shadow'
  if (/spacing|space|gap|padding|margin/.test(p)) return 'spacing'
  return null
}

function resolveType (dtcgType, pathStr) {
  if (dtcgType === 'dimension' || dtcgType === 'number') return resolveTypeFromPath(pathStr)
  if (dtcgType && DTCG_TYPE_MAP[dtcgType]) return DTCG_TYPE_MAP[dtcgType]
  return resolveTypeFromPath(pathStr)
}

function serializeValue (rawValue) {
  if (typeof rawValue === 'string') return rawValue
  if (typeof rawValue === 'number') return String(rawValue)
  return JSON.stringify(rawValue)
}

function walk (node, pathSegments, inheritedType, into, unresolved) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  const record = node
  if ('$value' in record) {
    const rawValue = record.$value
    const $type = typeof record.$type === 'string' ? record.$type : inheritedType
    const value = serializeValue(rawValue)
    const name = pathSegments.join('.')
    const resolved = resolveType($type, name)
    if (resolved === null) unresolved.push(name)
    into.push({
      type: resolved || 'unknown',
      name,
      value,
      origin: 'dtcg-json',
      group: pathSegments.length > 1 ? pathSegments.slice(0, -1).join('.') : undefined
    })
    return
  }
  const groupType = typeof record.$type === 'string' ? record.$type : inheritedType
  for (const key of Object.keys(record)) {
    if (key.startsWith('$')) continue
    walk(record[key], [...pathSegments, key], groupType, into, unresolved)
  }
}

/** @param {unknown} json */
function importDtcgJson (json) {
  const tokens = []
  const unresolved = []
  walk(json, [], undefined, tokens, unresolved)
  return { tokens, unresolved }
}

module.exports = { importDtcgJson }
