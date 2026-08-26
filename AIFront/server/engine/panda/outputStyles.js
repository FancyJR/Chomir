/**
 * Output styles（对标 panda-code constants/outputStyles）
 * 内置 default / Explanatory / Learning；可在 .panda/output-styles/*.md 扩展
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULT_OUTPUT_STYLE_NAME = 'default'

const BUILTIN = {
  default: null,
  Explanatory: {
    name: 'Explanatory',
    description: '解释实现选择与代码库模式',
    prompt: [
      '在完成工程任务的同时，提供简洁的教育性说明。',
      '',
      '# Explanatory Style Active',
      '## Insights',
      '写代码前后，用简短 Insight 块说明 2–3 个与本仓库相关的关键点（放在对话里，不要写进源码）：',
      '```',
      '✦ Insight ─────────────────────────────────────',
      '[要点]',
      '─────────────────────────────────────────────────',
      '```',
      '保持任务导向；Insight 要具体，避免空泛编程常识。'
    ].join('\n')
  },
  Learning: {
    name: 'Learning',
    description: '协作式学习：请用户写小段代码',
    prompt: [
      '在完成工程任务的同时，通过动手练习帮助用户学习代码库。',
      '',
      '# Learning Style Active',
      '## Requesting Human Contributions',
      '当一次要生成 20+ 行且涉及设计决策 / 业务逻辑 / 关键算法时，请用户贡献 2–10 行代码。',
      '例：`请实现这段校验函数的核心分支，我再接上其余样板。`',
      '日常样板仍由你完成；用 ask_user 收集贡献。'
    ].join('\n')
  }
}

async function loadCustomStyles (projectRoot) {
  const dir = path.resolve(projectRoot, '.panda', 'output-styles')
  const out = {}
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.replace(/\.md$/, '')
    try {
      const text = await fsp.readFile(path.join(dir, name), 'utf8')
      const title = (text.match(/^#\s+(.+)$/m) || [, id])[1]
      out[id] = {
        name: title.trim(),
        description: 'custom',
        prompt: text.slice(0, 6000),
        source: 'custom'
      }
    } catch (e) { /* ignore */ }
  }
  return out
}

async function listStyles (projectRoot) {
  const custom = await loadCustomStyles(projectRoot)
  return {
    builtin: Object.keys(BUILTIN),
    custom: Object.keys(custom)
  }
}

async function resolveOutputStyle (projectRoot, name) {
  const key = String(name || DEFAULT_OUTPUT_STYLE_NAME).trim() || DEFAULT_OUTPUT_STYLE_NAME
  if (key === 'default' || key === DEFAULT_OUTPUT_STYLE_NAME) return null
  if (BUILTIN[key]) return BUILTIN[key]
  // case-insensitive builtin
  const hit = Object.keys(BUILTIN).find(k => k.toLowerCase() === key.toLowerCase())
  if (hit && BUILTIN[hit]) return BUILTIN[hit]
  const custom = await loadCustomStyles(projectRoot)
  if (custom[key]) return custom[key]
  return null
}

function getOutputStyleSection (styleConfig) {
  if (!styleConfig) return ''
  return '# Output Style: ' + styleConfig.name + '\n' + styleConfig.prompt
}

function getLanguageSection (languagePreference) {
  if (!languagePreference) return ''
  const lang = String(languagePreference).trim()
  if (!lang || /^zh|chinese|简体|中文/i.test(lang)) {
    // 默认中文由 Tone 段覆盖；显式 zh 仍可强化
    if (/^zh(-CN)?$|chinese|简体|中文/i.test(lang)) {
      return '# Language\nAlways respond in 简体中文. Code, paths, identifiers, and commands stay in their original form.'
    }
  }
  return [
    '# Language',
    'Always respond in ' + lang + '.',
    'Use ' + lang + ' for all explanations, comments, and communications with the user.',
    'Technical terms and code identifiers should remain in their original form.'
  ].join('\n')
}

module.exports = {
  DEFAULT_OUTPUT_STYLE_NAME,
  BUILTIN,
  listStyles,
  resolveOutputStyle,
  getOutputStyleSection,
  getLanguageSection,
  loadCustomStyles
}
