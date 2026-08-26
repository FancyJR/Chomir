/**
 * 样式保留能力（style-preserve）
 *
 * 用途：引擎在「优化样式」或修改 .vue 时，可能删掉关键选择器或配色，导致页面变黑白、卡片高度不一。
 * 本模块按「视图文件」配置「必须保留的样式片段」：写入前检查，若新 style 里缺少某段则自动追加，
 * 从而把「保留配色与布局」做成项目能力，而不是依赖每次手改页面。
 *
 * 使用方式：
 * - 在 PRESERVE_REGISTRY 里为某视图（如 CommandMarket.vue）配置 fragments。
 * - 每项：{ id, selector, css }。selector 用于检测「新 style 是否已包含」；若不包含则追加 css。
 * - 新增页面或新关键样式时，往对应视图的 fragments 里加一条即可。
 */

const path = require('path')

/**
 * 按视图文件配置的「必须保留」样式片段
 * key: 视图文件名（如 CommandMarket.vue），或 src/views/CommandMarket.vue
 * value: Array<{ id: string, selector: string, css: string }>
 *   - selector: 若新 style 内容已包含该选择器（含在规则里），则不再追加
 *   - css: 否则追加的完整 CSS 块（可多行）
 */
const PRESERVE_REGISTRY = {
  'CommandMarket.vue': [
    {
      id: 'icon-colors',
      selector: '.command-icon.color-purple',
      css: [
        '/* 保留：卡片图标按类型配色，避免优化后变黑白 */',
        '.command-icon.color-purple { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); }',
        '.command-icon.color-green { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }',
        '.command-icon.color-blue { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }',
        '.command-icon.color-indigo { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); }',
        '.command-icon.color-orange { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }',
        '.command-icon.color-cyan { background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); }',
        '.command-icon.color-red { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }'
      ].join('\n')
    },
    {
      id: 'card-footer-spacing',
      selector: '.command-card-footer',
      css: [
        '/* 保留：卡片底部（创建者/日期/订阅数/已启用）与边框保持间距，避免贴边 */',
        '.command-card-footer {',
        '  padding: 20px 36px 28px;',
        '  border-top: 1px solid #f1f5f9;',
        '  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;',
        '  background: #fafbfc;',
        '  box-sizing: border-box;',
        '}'
      ].join('\n')
    },
    {
      id: 'meta-footer',
      selector: '.meta-left',
      css: [
        '.meta-left { font-size: 14px; color: #64748b; }',
        '.meta-left .creator { margin-right: 8px; }',
        '.meta-left .created-at { color: #94a3b8; }',
        '.meta-right { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #64748b; }',
        '.meta-right .subscribe .number { margin-left: 4px; }',
        '.meta-right .status.enabled { padding: 2px 10px; border-radius: 12px; background: #d1fae5; color: #065f46; font-size: 12px; font-weight: 600; }'
      ].join('\n')
    },
    {
      id: 'pagination-empty',
      selector: '.pagination-wrapper',
      css: [
        '.pagination-wrapper { display: flex; align-items: center; justify-content: flex-end; padding: 24px 0; gap: 16px; }',
        '.pagination-wrapper .total-text { font-size: 14px; color: #64748b; }',
        '.empty-block { padding: 48px 0; }'
      ].join('\n')
    },
    {
      id: 'card-height-uniform',
      selector: '.card-grid .command-card',
      css: [
        '/* 保留：同一行卡片高度一致（Vue2 用 >>> 穿透） */',
        '.card-grid >>> .el-row { display: flex; flex-wrap: wrap; }',
        '.card-grid >>> .el-col { display: flex; margin-bottom: 24px; }',
        '.card-grid .command-card { width: 100%; min-height: 420px; }'
      ].join('\n')
    }
  ]
}

/**
 * 根据相对路径或文件名取视图的 basename（如 src/views/CommandMarket.vue -> CommandMarket.vue）
 */
function getViewBasename (filePath) {
  if (!filePath || typeof filePath !== 'string') return ''
  const base = path.basename(filePath)
  return base.toLowerCase().endsWith('.vue') ? base : ''
}

/**
 * 取某视图配置的保留片段列表；若未配置则返回空数组
 */
function getPreserveFragmentsForFile (filePath) {
  const name = getViewBasename(filePath)
  if (!name) return []
  return PRESERVE_REGISTRY[name] || []
}

/**
 * 对 style 内容应用保留规则：若某片段的 selector 在新 style 中未出现，则将该片段的 css 追加到末尾
 * @param {string} styleInner - <style> 标签内的 CSS 字符串
 * @param {string} filePath - 当前写入的 .vue 路径（如 src/views/CommandMarket.vue）
 * @returns {string} 可能已追加片段的 style 内容
 */
function applyPreserveFragments (styleInner, filePath) {
  if (!styleInner || typeof styleInner !== 'string') return styleInner
  const fragments = getPreserveFragmentsForFile(filePath)
  if (!fragments.length) return styleInner

  let out = styleInner.trimEnd()
  const toAppend = []

  for (const { id, selector, css } of fragments) {
    if (!selector || !css) continue
    // 检测新 style 里是否已包含该选择器（选择器可能在规则中出现，如 .command-icon.color-purple { ... }）
    const selectorEscaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(selectorEscaped.replace(/\s+/g, '\\s+'))
    if (!re.test(out)) {
      toAppend.push(css)
    }
  }

  if (toAppend.length) {
    const sep = out.endsWith('}') ? '\n\n' : '\n'
    out += sep + '/* 引擎保留：自动补全关键样式 */\n' + toAppend.join('\n\n')
  }

  return out
}

/**
 * 对完整 .vue 内容应用保留规则：取出 <style> 内层，applyPreserveFragments 后再拼回
 * @param {string} vueContent - 完整 .vue 文件内容
 * @param {string} filePath - 如 src/views/CommandMarket.vue
 * @returns {string} 应用保留后的 .vue 内容
 */
function applyPreserveToVueContent (vueContent, filePath) {
  if (!vueContent || typeof vueContent !== 'string') return vueContent
  if (!getPreserveFragmentsForFile(filePath).length) return vueContent

  const match = vueContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
  if (!match || !match[1]) return vueContent

  const inner = applyPreserveFragments(match[1], filePath)
  if (inner === match[1]) return vueContent

  return vueContent.replace(
    /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
    (_, open, _inner, close) => open + inner + close
  )
}

module.exports = {
  PRESERVE_REGISTRY,
  getViewBasename,
  getPreserveFragmentsForFile,
  applyPreserveFragments,
  applyPreserveToVueContent
}
