'use strict'

/**
 * Task-aware asset selection for ShiyunDesign prompt composition.
 * open-codesign capabilities merged here; existing craft/web-clone/artifacts stay in compose-design-task.
 */

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const SKIP_METHOD = new Set(['frontend-design-anti-slop', 'craft-polish'])

/** @type {Array<{ id: string, test: (task: string) => boolean, exclude?: (task: string) => boolean }>} */
const METHOD_RULES = [
  { id: 'cjk-typography', test: (t) => /[\u4e00-\u9fff]/.test(t) || /中文|简体|繁体|日文|韩文|cjk|汉字/i.test(t) },
  { id: 'pitch-deck', test: (t) => /pitch|deck|slide|演示|幻灯|路演/i.test(t) },
  { id: 'chart-rendering', test: (t) => /chart|graph|图表|曲线|柱状/i.test(t) },
  { id: 'data-viz-recharts', test: (t) => /recharts|dashboard|仪表|数据面板|analytics/i.test(t) },
  { id: 'form-layout', test: (t) => /form|表单|login|sign.?in|sign.?up|登录|注册|输入框/i.test(t) },
  { id: 'mobile-mock', test: (t) => /mobile|phone|手机|ios|android|app mock/i.test(t) },
  { id: 'app-shell-navigation', test: (t) => /sidebar|navigation|nav bar|菜单|导航|侧边栏/i.test(t) },
  { id: 'loading-skeleton', test: (t) => /skeleton|loading|加载|骨架屏/i.test(t) },
  { id: 'empty-states', test: (t) => /empty state|空状态|暂无数据|no results/i.test(t) },
  { id: 'responsive-layout', test: (t) => /responsive|breakpoint|自适应|移动端适配|media query/i.test(t) },
  { id: 'surface-elevation', test: (t) => /elevation|shadow|card|层级|阴影|浮层/i.test(t) },
  { id: 'accessibility-states', test: (t) => /a11y|accessibility|focus|keyboard|无障碍|焦点/i.test(t) },
  { id: 'artifact-composition', test: (t) => /artifact|section|block|模块组合|页面区块/i.test(t) },
  {
    id: 'design-system-baton',
    test: (t) => /DESIGN\.md|design system|设计系统|多页|multi.?screen|多屏/i.test(t),
  },
  {
    id: 'design-reference-to-html',
    test: (t) => /screenshot|mockup|figma|截图|参照图|视觉参考|还原设计|设计稿/i.test(t),
    exclude: (t) => /clone|克隆|mirror|爬|复刻网站|https?:\/\//i.test(t),
  },
]

/** @type {Array<{ file: string, test: (task: string) => boolean }>} */
const DESIGN_SKILL_RULES = [
  { file: 'landing-page.jsx', test: (t) => /landing|首页|营销页|官网/i.test(t) },
  { file: 'heroes.jsx', test: (t) => /hero|头图|banner|主视觉/i.test(t) },
  { file: 'dashboard.jsx', test: (t) => /dashboard|后台|控制台|admin/i.test(t) },
  { file: 'pricing.jsx', test: (t) => /pricing|价格|套餐|订阅/i.test(t) },
  { file: 'slide-deck.jsx', test: (t) => /slide|deck|演示|幻灯/i.test(t) },
  { file: 'chat-ui.jsx', test: (t) => /chat|对话|assistant|助手界面/i.test(t) },
  { file: 'data-table.jsx', test: (t) => /table|表格|grid|列表页/i.test(t) },
  { file: 'calendar.jsx', test: (t) => /calendar|日历|日程/i.test(t) },
  { file: 'footers.jsx', test: (t) => /footer|页脚/i.test(t) },
  { file: 'glassmorphism.jsx', test: (t) => /glass|毛玻璃|blur/i.test(t) },
  { file: 'editorial-typography.jsx', test: (t) => /editorial|杂志|长文|排版/i.test(t) },
  { file: 'chart-svg.jsx', test: (t) => /chart|svg|图表/i.test(t) },
]

/** @param {string} text */
function stripFrontmatter (text) {
  const s = String(text || '')
  if (!s.startsWith('---')) return s.trim()
  const end = s.indexOf('\n---', 3)
  if (end < 0) return s.trim()
  return s.slice(end + 4).trim()
}

/**
 * @param {string} assetsRoot
 * @returns {Array<{ slug: string, name: string, category?: string, path: string }>}
 */
function loadBrandManifest (assetsRoot) {
  const manifestPath = join(assetsRoot, 'brand-refs', 'manifest.json')
  if (!existsSync(manifestPath)) return []
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return Array.isArray(data.brands) ? data.brands : []
  } catch {
    return []
  }
}

/**
 * @param {string} task
 * @param {ReturnType<typeof loadBrandManifest>} brands
 */
function matchBrands (task, brands) {
  const lower = String(task || '').toLowerCase()
  /** @type {typeof brands} */
  const hits = []
  for (const b of brands) {
    const slug = String(b.slug || '').toLowerCase()
    const name = String(b.name || '').toLowerCase()
    if (!slug) continue
    if (lower.includes(slug) || (name && lower.includes(name))) hits.push(b)
  }
  return hits.slice(0, 2)
}

/** @param {string} task */
function selectMethodSkillIds (task) {
  const t = String(task || '')
  /** @type {string[]} */
  const out = []
  for (const rule of METHOD_RULES) {
    if (SKIP_METHOD.has(rule.id)) continue
    if (rule.exclude && rule.exclude(t)) continue
    if (rule.test(t)) out.push(rule.id)
  }
  return out
}

/** @param {string} task */
function shouldUseWebClone (task) {
  const t = String(task || '')
  if (/screenshot|mockup|截图|设计稿/i.test(t) && !/https?:\/\//i.test(t)) return false
  return /clone|克隆|mirror|爬|复刻|website|站点|https?:\/\//i.test(t)
}

/** @param {string} task */
function selectDesignSkillFiles (task) {
  const t = String(task || '')
  return DESIGN_SKILL_RULES.filter((r) => r.test(t)).map((r) => r.file).slice(0, 2)
}

/**
 * Compact brand index for prompt (always-on when manifest exists).
 * @param {ReturnType<typeof loadBrandManifest>} brands
 */
function formatBrandIndex (brands) {
  if (!brands.length) return ''
  const lines = brands.map((b) => `- \`${b.slug}\` — ${b.name}${b.category ? ` (${b.category})` : ''}`)
  return [
    'Bundled brand references (load matching DESIGN.md when the user names a brand):',
    ...lines,
  ].join('\n')
}

/** @param {string} assetsRoot @param {string} rel */
function readAssetText (assetsRoot, rel) {
  const p = join(assetsRoot, rel)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8').trim()
}

/**
 * Optional open-codesign-style runtime extensions (CLI scripts under shiyundesign/scripts/).
 * @param {string} task
 */
function selectRuntimeCapabilities (task) {
  const t = String(task || '')
  return {
    imageGen: /generate.?image|ai.?image|出图|生成图|hero.?image|bitmap|插图|背景图|dall[- ]?e/i.test(t),
    uiKit: /ui.?kit|decompose|拆解|交接|handoff|component.?bundle|coding.?agent|ui_kits/i.test(t),
    brandExtract: /tailwind|dtcg|css.?var|design.?token|抽品牌|提取品牌|token.?json|tokens\.css/i.test(t),
    previewIterate: (
      /pixel|像素|screenshot|截图对比|visual.?diff|preview.?loop|还原设计|设计稿|mockup|figma/i.test(t) &&
      !shouldUseWebClone(t)
    ),
    designBrief: /continue|续作|follow.?up|多轮|previous|继续|接着|上次/i.test(t) ||
      /DESIGN\.md|多页|multi.?screen|多屏/i.test(t),
  }
}

/** @param {string} task */
function shouldAllowBundledPreviewScripts (task) {
  const caps = selectRuntimeCapabilities(task)
  return shouldUseWebClone(task) || caps.previewIterate || caps.uiKit || caps.brandExtract
}

/** @param {string} task */
function shouldUseRuntimeExtensions (task) {
  const caps = selectRuntimeCapabilities(task)
  return caps.imageGen || caps.uiKit || caps.brandExtract || caps.previewIterate || caps.designBrief
}

/**
 * @param {string} runtimeRoot
 * @param {ReturnType<typeof selectRuntimeCapabilities>} caps
 */
function formatRuntimeSkill (runtimeRoot, caps) {
  const { scriptPath } = require('./runtime-paths')
  const scripts = scriptPath(runtimeRoot, '')
  let body = readAssetText(join(runtimeRoot, 'assets'), 'skills/runtime/SKILL.md')
  if (!body) return ''
  body = body
    .replace(/\{\{RUNTIME_ROOT\}\}/g, runtimeRoot)
    .replace(/\{\{SCRIPTS\}\}/g, scripts.replace(/\/$/, ''))

  const focus = []
  if (caps.brandExtract) focus.push('brand-extract')
  if (caps.imageGen) focus.push('generate-image')
  if (caps.uiKit) focus.push('decompose-ui-kit + verify-ui-kit-parity')
  if (caps.previewIterate) focus.push('preview-capture + preview-compare')
  if (caps.designBrief) focus.push('design-brief')
  if (!focus.length) return body
  return `${body}\n\n## Focus for this task\n\nEnable: ${focus.join(', ')}. Ignore unrelated runtime tools.`
}

module.exports = {
  stripFrontmatter,
  loadBrandManifest,
  matchBrands,
  selectMethodSkillIds,
  shouldUseWebClone,
  selectDesignSkillFiles,
  formatBrandIndex,
  readAssetText,
  selectRuntimeCapabilities,
  shouldAllowBundledPreviewScripts,
  shouldUseRuntimeExtensions,
  formatRuntimeSkill,
}
