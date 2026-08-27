#!/usr/bin/env node
/**
 * Refresh OpenDesign assets under AIFront/shiyundesign/assets from the Kylin bank overlay.
 * Usage: node scripts/sync-shiyundesign-assets.mjs
 */
import { cpSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const dest = resolve(root, 'shiyundesign', 'assets')

const candidates = [
  resolve(root, '..', 'bank', 'deepseek-harness-kylin-desktop', 'overlays', 'kylin', 'plugins', 'dsh-plugin-kylin-shiyundesign-subagent', 'vendor', 'shiyundesign-runtime', 'assets'),
  resolve(process.env.SHIYUNDESIGN_ASSETS_SRC || '', 'assets'),
  resolve(process.env.HOME || '', 'workspace', 'bank', 'deepseek-harness-kylin-desktop', 'overlays', 'kylin', 'plugins', 'dsh-plugin-kylin-shiyundesign-subagent', 'vendor', 'shiyundesign-runtime', 'assets'),
]

const src = candidates.find((p) => p && existsSync(p))
if (!src) {
  console.error('sync-shiyundesign-assets: no source found. Set SHIYUNDESIGN_ASSETS_SRC to assets dir.')
  process.exit(1)
}

cpSync(src, dest, { recursive: true })
console.log('synced', src, '->', dest)
