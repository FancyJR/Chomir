'use strict'

const { mkdirSync, writeFileSync } = require('node:fs')
const { join, dirname, extname } = require('node:path')

const PURPOSE_HINTS = {
  hero: 'Wide hero photograph or illustration, editorial lighting, no text overlay.',
  product: 'Clean product render on neutral background, studio lighting.',
  poster: 'Bold poster composition, strong focal point, print-ready feel.',
  background: 'Seamless background texture or gradient, subtle, tile-friendly.',
  illustration: 'Flat or semi-flat illustration, cohesive palette, no watermark.',
  logo: 'Simple iconic mark on transparent-friendly background.',
  other: 'High-quality bitmap asset suitable for a modern web design.'
}

function enrichPrompt (prompt, purpose) {
  const hint = PURPOSE_HINTS[purpose] || PURPOSE_HINTS.other
  return `${prompt.trim()}. ${hint}`
}

function mimeToExt (mime) {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  return '.png'
}

function sanitizeFilename (hint) {
  return String(hint || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'asset'
}

/**
 * @param {string} cwd
 * @param {{ prompt: string, purpose?: string, filenameHint?: string, aspectRatio?: string, alt?: string }} req
 */
async function generateImageAsset (cwd, req) {
  const apiKey = process.env.SHIYUNDESIGN_IMAGE_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('generate-image: set SHIYUNDESIGN_IMAGE_API_KEY or OPENAI_API_KEY')
  }

  const apiUrl = (process.env.SHIYUNDESIGN_IMAGE_API_URL || 'https://api.openai.com/v1/images/generations').replace(/\/$/, '')
  const model = process.env.SHIYUNDESIGN_IMAGE_MODEL || 'dall-e-3'
  const purpose = req.purpose || 'other'
  const prompt = enrichPrompt(req.prompt, purpose)

  const sizeMap = {
    '1:1': '1024x1024',
    '16:9': '1792x1024',
    '9:16': '1024x1792',
    '4:3': '1024x1024',
    '3:4': '1024x1024'
  }
  const size = sizeMap[req.aspectRatio || '16:9'] || '1024x1024'

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'b64_json' })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`generate-image: API ${res.status} ${body.slice(0, 300)}`)
  }

  const data = await res.json()
  const b64 = data?.data?.[0]?.b64_json
  if (!b64) throw new Error('generate-image: API returned no image data')

  const buf = Buffer.from(b64, 'base64')
  const ext = extname(req.filenameHint || '') || '.png'
  const base = sanitizeFilename(req.filenameHint || purpose)
  const rel = join('assets', 'images', `${base}${ext.startsWith('.') ? ext : '.png'}`)
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)

  return {
    path: rel.replace(/\\/g, '/'),
    mimeType: 'image/png',
    model,
    provider: 'openai-compatible',
    alt: req.alt || `${purpose} image`,
    bytes: buf.length
  }
}

module.exports = { generateImageAsset }
