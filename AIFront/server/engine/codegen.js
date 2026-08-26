/**
 * 代码生成器（codegen）
 *
 * 职责：
 * - 根据 planner 规划出的 actions，调用 DeepSeek 生成具体的代码补丁
 * - 支持：
 *   - add_view：新增视图（整页 .vue 单文件组件）
 *   - modify_view：修改现有视图（优先做最小修改 / 样式优化，而不是整页重写）
 * - 内置能力：换描述/副标题 → 相同语义换一种说法，仅改 .page-subtitle；换「指令类型：」→ 仅改工具栏该处文案（见 isChangeInstructionTypeLabel）
 * - 内置多层保护：
 *   - 简单场景走本地字符串替换（如“把标题从 A 改为 B”）
 *   - 样式类请求优先走 tryStyleOnlyModify，只改 <style>，不动 template/script
 *   - checkModifyViewPreserve 保证 template/script/style 三块齐全、样式长度不大幅缩水
 *   - stripVerticalWritingMode / processVueContentStripVerticalWritingMode 防止文字被渲染成竖排
 */

const { callDeepseekJson, callDeepseekText, callDeepseekTextStream } = require('./shared-llm')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')

/**
 * 通用「X 改成 Y」能力：从整段描述中解析出要替换的原文与目标文，若文件中存在原文则替换（只替换第一次出现）。
 * 支持：类型筛选：改成类型选择、把 A 改成 B、将 X 修改为 Y、X 改为 Y 等任意表述，不依赖具体文案枚举。
 * @param {string} textForRule - reason + description
 * @param {string} oldContent - 当前文件内容
 * @returns {string|null} 替换后的内容，无法解析或原文不存在时返回 null
 */
function tryGenericFindReplace (textForRule, oldContent) {
  if (!textForRule || !oldContent) return null
  let fromText = null
  let toText = null
  // 1) "X 改成 Y" / "X 改为 Y"（X、Y 可含句号。，不含换行、全角逗号）
  const m1 = textForRule.match(/([^\n，]+?)\s*改成\s*([^\n，]+?)(?=[，\s]|$)/)
  if (m1) {
    fromText = m1[1].trim()
    toText = m1[2].trim()
  }
  if (!fromText || !toText) {
    const m2 = textForRule.match(/([^\n，]+?)\s*改为\s*([^\n，]+?)(?=[，\s]|$)/)
    if (m2) {
      fromText = m2[1].trim()
      toText = m2[2].trim()
    }
  }
  // 2) 将 "X" 修改为 "Y" / 将「X」修改为「Y」
  if (!fromText || !toText) {
    const m3 = textForRule.match(/将\s*["'""「」]?(.+?)["'""「」]?\s*修改为\s*["'""「」]?(.+?)["'""「」]/)
    if (m3) {
      fromText = m3[1].trim()
      toText = m3[2].trim()
    }
  }
  // 3) 把 "X" 改成 "Y"
  if (!fromText || !toText) {
    const m4 = textForRule.match(/把\s*["'""「」]?(.+?)["'""「」]?\s*改成\s*["'""「」]?(.+?)["'""「」]/)
    if (m4) {
      fromText = m4[1].trim()
      toText = m4[2].trim()
    }
  }
  if (!fromText || !toText) return null
  // 若原文带冒号而目标没有，可补上（与现有 UI 习惯一致）
  if (/[：:]$/.test(fromText) && !/[：:]$/.test(toText)) toText = toText + (fromText.endsWith('：') ? '：' : ':')
  if (!oldContent.includes(fromText)) return null
  return oldContent.replace(fromText, toText)
}

/** 菜单项名 → 图标类名（当前为 Element UI 常用值；非 Element 项目会走 LLM 按文件内已有写法生成） */
const MENU_ITEM_ICON_MAP = {
  '今日股票推荐': 'el-icon-trend-charts',
  '仪表盘': 'el-icon-menu',
  '表格页': 'el-icon-document',
  '指令市场': 'el-icon-s-operation',
  '无代码开发': 'el-icon-magic-stick',
  '足球数据统计': 'el-icon-data-analysis',
  '篮球数据统计': 'el-icon-data-analysis',
  '羽毛球数据统计': 'el-icon-data-analysis',
  '期货预测': 'el-icon-data-analysis',
  '指令详情': 'el-icon-document'
}

/**
 * 菜单项加图标：在菜单项内、标题前插入图标。菜单标签按当前文件识别（el-menu-item / a-menu-item 等），图标写法与同文件已有菜单项一致。
 */
function tryMenuItemAddIcon (oldContent, textForRule, targetFile) {
  if (!oldContent || !targetFile) return null
  const isMenuFile = /App\.vue|Layout\.vue|Sidebar\.vue|layout\/.*\.vue/i.test(targetFile)
  const isMenuIconIntent = /(menu-item|菜单项|左侧菜单|菜单|导航).*?(图标|logo|icon)/.test(textForRule) || /(图标|logo).*?(menu-item|菜单项|菜单)/.test(textForRule)
  if (!isMenuFile || !isMenuIconIntent) return null

  const menuItemTag = /<a-menu-item[\s>]/.test(oldContent) ? 'a-menu-item' : 'el-menu-item'
  for (const [label, iconClass] of Object.entries(MENU_ITEM_ICON_MAP)) {
    if (!oldContent.includes(label)) continue
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(
      '(<' + menuItemTag.replace(/-/g, '\\-') + '[^>]*>)\\s*((?:<i\\s[^>]*>\\s*</i>\\s*)?)(\\s*<span\\s+slot=["\']title["\'][^>]*>\\s*' + escapedLabel + '\\s*</span>)',
      'i'
    )
    const m = oldContent.match(re)
    if (!m) continue
    if (/<i\s|<Icon\s|<a-icon\s/i.test(m[2])) return null
    const insert = `\n            <i class="${iconClass}"></i>\n            `
    const newContent = oldContent.replace(re, m[1] + insert + m[3])
    if (newContent !== oldContent) return newContent
  }
  return null
}

/**
 * 只改数量/数字：在「控制条数」的上下文中把 fromNum 改为 toNum，不碰其他代码
 * 优先匹配：.slice(0, n)、pageSize、limit、:page-size、page-size 等
 */
function tryNumberReplace (fromNum, toNum, oldContent) {
  if (fromNum == null || toNum == null || String(fromNum) === String(toNum) || !oldContent) return null
  const n = String(fromNum)
  const m = String(toNum)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 按优先级尝试替换，只改一处（与「条数」相关的上下文），避免误伤
  const patterns = [
    [new RegExp(`(\\.slice\\s*\\(\\s*0\\s*,\\s*)${esc(n)}(\\s*\\))`, 'g'), `$1${m}$2`],
    [new RegExp(`(slice\\s*\\(\\s*0\\s*,\\s*)${esc(n)}(\\s*\\))`, 'g'), `$1${m}$2`],
    [new RegExp(`(pageSize\\s*[:=]\\s*)${esc(n)}(?=[\\s,}\\])])`, 'g'), `$1${m}`],
    [new RegExp(`(limit\\s*[:=]\\s*)${esc(n)}(?=[\\s,}\\])])`, 'g'), `$1${m}`],
    [new RegExp(`(:page-size|:pageSize)\\s*=\\s*["']${esc(n)}["']`, 'g'), `$1="${m}"`]
  ]
  for (const [re, repl] of patterns) {
    const next = oldContent.replace(re, repl)
    if (next !== oldContent) return next
  }
  return null
}

async function generateForAddView (action, projectInfo) {
  const systemPrompt = [
    '你是一个 Vue 2 + ElementUI 工程的代码生成器。',
    '根据给出的页面描述和项目上下文，生成一个完整的单文件组件 (.vue)。',
    '必须只输出 JSON：{ "vueCode": "<template>...</template><script>...</script><style scoped>...</style>" }，不要附加文字。',
    '',
    '项目上下文：',
    JSON.stringify(projectInfo, null, 2)
  ].join('\n')

  const userPrompt = [
    '需要新增的视图（add_view）：',
    JSON.stringify(action, null, 2),
    '',
    '要求：',
    '1. 使用 Vue 2 Options API。',
    '2. 使用 ElementUI 组件作为主要 UI 元素。',
    '3. <style> 建议加 scoped，保持页面美观、布局合理。',
    '4. 页面逻辑可以使用本地 mock 数据，不必真的调接口。',
    '5. 不要定义路由，本文件只负责视图本身。'
  ].join('\n')

  const data = await callDeepseekJson(systemPrompt, userPrompt)
  if (!data || typeof data.vueCode !== 'string') {
    throw new Error('LLM 未返回 vueCode')
  }
  return data.vueCode
}

async function generateForModifyView (action, projectInfo, opts = {}) {
  const projectRoot = projectInfo.root
  const targetFile = action.file
  const onChunk = opts && typeof opts.onChunk === 'function' ? opts.onChunk : null
  const thought = opts && typeof opts.thought === 'object' ? opts.thought : null
  if (!targetFile) {
    throw new Error('modify_view 缺少 file 字段')
  }
  const absPath = path.resolve(projectRoot, targetFile)
  let oldContent = ''
  try {
    oldContent = await fsp.readFile(absPath, 'utf8')
  } catch (e) {
    throw new Error(`找不到要修改的文件：${targetFile}`)
  }

  const textForRule = `${action.reason || ''} ${action.description || ''}`

  // 只改数量/数字：优先走精准替换，不重写整页
  const numChange = action.numberChange
  if (numChange && typeof numChange.from !== 'undefined' && typeof numChange.to !== 'undefined') {
    const numReplaced = tryNumberReplace(numChange.from, numChange.to, oldContent)
    if (numReplaced) return { file: targetFile, newContent: numReplaced }
  }
  const numMatch = textForRule.match(/(?:从\s*)?(\d+)\s*个?\s*改成\s*(\d+)|(\d+)\s*改成\s*(\d+)/)
  if (numMatch) {
    const fromN = parseInt(numMatch[1] || numMatch[3], 10)
    const toN = parseInt(numMatch[2] || numMatch[4], 10)
    if (!Number.isNaN(fromN) && !Number.isNaN(toN) && fromN !== toN) {
      const numReplaced = tryNumberReplace(fromN, toN, oldContent)
      if (numReplaced) return { file: targetFile, newContent: numReplaced }
    }
  }

  // 菜单项加图标：只改 template 在 el-menu-item 内插入 <i>，不走 CSS/LLM，避免改错
  const menuIconReplaced = tryMenuItemAddIcon(oldContent, textForRule, targetFile)
  if (menuIconReplaced) return { file: targetFile, newContent: menuIconReplaced }

  const genericReplaced = tryGenericFindReplace(textForRule, oldContent)
  if (genericReplaced) return { file: targetFile, newContent: genericReplaced }

  // 兜底：「…改为 Y」且 Y 为完整新文案（可含句号）→ 将 .page-subtitle 整段替换为 Y（即使用户写的 X 与当前页文案不完全一致）
  const mSubtitleNew = textForRule.match(/改为\s*([^\n]+)\s*$/)
  if (mSubtitleNew && mSubtitleNew[1] && targetFile.includes('CommandMarket')) {
    const newSubtitleText = mSubtitleNew[1].trim()
    const subtitleBlock = oldContent.match(/<div\s+class=["']page-subtitle["']>\s*([^<]*)\s*<\/div>/)
    if (subtitleBlock && newSubtitleText) {
      const newContent = oldContent.replace(
        /(<div\s+class=["']page-subtitle["']>\s*)[^<]*(\s*<\/div>)/,
        (_, open, close) => open + newSubtitleText + close
      )
      if (newContent !== oldContent) return { file: targetFile, newContent }
    }
  }

  const isTextChangeIntent = /副标题|仅修改该处文字|更换.*文案|描述.*文案|不好听|换一个|换一句|换个说法|换一种说法|好听一点|改一下说法/.test(textForRule)
  // 兜底规则：reason 里只有「改为 XXX」，则从源码里自动推断原标题，只替换标题文本
  let newTitle = null
  let m = textForRule.match(/改为["'“”「」](.+?)["'“”「」]/)
  if (!m) {
    // 没有引号时，如「把指令市场页面标题改为指令市场777」
    m = textForRule.match(/改为\s*([^\s，。！？!?,]+)/)
  }
  if (m && m[1]) {
    newTitle = m[1].trim()
  }
  // 仅当不是「换描述/副标题」意图时，才用「改为 XXX」去改 page-title，避免误改主标题
  if (newTitle && !isTextChangeIntent) {
    const titleMatch = oldContent.match(/<div\s+class=["']page-title["']>\s*([^<\n]+)\s*<\/div>/)
    if (titleMatch && titleMatch[1]) {
      const oldTitle = titleMatch[1].trim()
      if (oldTitle && oldTitle !== newTitle && oldContent.includes(oldTitle)) {
        const newContent = oldContent.replace(oldTitle, newTitle)
        return { file: targetFile, newContent }
      }
    }
  }

  // 「换指令类型：该处文案」意图：仅改工具栏 .toolbar-label 里的「指令类型：」，不改别处
  const isChangeInstructionTypeLabel = /指令类型.*[换改修]|[换改修].*指令类型|指令类型.*(这几个字|该处|换一种描述|文本内容|其他描述)/.test(textForRule)
  if (isChangeInstructionTypeLabel && targetFile.includes('CommandMarket')) {
    // 匹配 指令类型： 或 指令类型:（中英文冒号均可），避免因字符差异匹配不到
    const labelRegex = /<span\s+class=["']toolbar-label["']>\s*指令类型[：:]\s*<\/span>/
    const labelMatch = oldContent.match(labelRegex)
    if (labelMatch) {
      const oldLabel = labelMatch[0].match(/指令类型[：:]/) ? labelMatch[0] : '指令类型：'
      let newLabel = null
      const mLab = textForRule.match(/改为["'""「」](.+?)["'""「」]/) || textForRule.match(/改成["'""「」](.+?)["'""「」]/) || textForRule.match(/改为\s*([^\s，。！？!?]+)/)
      if (mLab && mLab[1]) newLabel = mLab[1].trim()
      if (!newLabel) {
        const sys = '你只输出一个简短的中文标签（用于筛选项前），与「指令类型：」语义一致，换一种说法，如「类型筛选：」「指令分类：」等，5～8 字内。不要引号、不要代码、不要解释。'
        const user = `原标签：「指令类型：」。用户要求：换一种描述。\n请只输出替换后的标签文案（可带冒号）。`
        const suggested = await callDeepseekText(sys, user, { max_tokens: 60 })
        if (suggested && typeof suggested === 'string') newLabel = suggested.trim().split('\n')[0].trim().replace(/^["'""「」]+|["'""「」]+$/g, '')
      }
      if (newLabel) {
        if (!/：|:/.test(newLabel)) newLabel = newLabel + '：'
        const newContent = oldContent.replace(labelRegex, '<span class="toolbar-label">' + newLabel + '</span>')
        if (newContent !== oldContent) return { file: targetFile, newContent }
      }
    }
  }

  // 「换描述/改副标题/改文案」意图：仅改 .page-subtitle 内文案；若描述的是「指令类型」该处则上面已处理，此处不再改副标题
  if (isTextChangeIntent && !isChangeInstructionTypeLabel && targetFile.includes('CommandMarket')) {
    const subtitleMatch = oldContent.match(/<div\s+class=["']page-subtitle["']>\s*([^<]*)\s*<\/div>/)
    if (subtitleMatch && subtitleMatch[1]) {
      const oldSubtitle = subtitleMatch[1].trim()
      let newSubtitle = null
      const mSub = textForRule.match(/改为["'""「」](.+?)["'""「」]/) || textForRule.match(/改成["'""「」](.+?)["'""「」]/) || textForRule.match(/改为\s*([^\s，。！？!?]+)/)
      if (mSub && mSub[1]) newSubtitle = mSub[1].trim()
      if (!newSubtitle) {
        const sys = '你只输出一句中文，要求：与给定的原句「语义完全一致」，仅换一种说法/表述，不要缩短、不要扩写、不要改变含义。输出长度和原句相当。不要输出引号、不要代码、不要解释。'
        const user = `原句：「${oldSubtitle}」。用户要求：相同语义换一种说法。\n请只输出一句替换后的中文（语义不变、仅换表述）。`
        const suggested = await callDeepseekText(sys, user, { max_tokens: 120 })
        if (suggested && typeof suggested === 'string') newSubtitle = suggested.trim().split('\n')[0].trim().replace(/^["'""「」]+|["'""「」]+$/g, '')
      }
      if (newSubtitle && newSubtitle !== oldSubtitle) {
        // 只替换 .page-subtitle 这一处，避免误改 .page-title 或别处
        const newContent = oldContent.replace(
          /(<div\s+class=["']page-subtitle["']>\s*)[^<]*(\s*<\/div>)/,
          (_, open, close) => open + newSubtitle + close
        )
        if (newContent !== oldContent) return { file: targetFile, newContent }
      }
    }
  }

  // 标签间距：只在 CommandMarket 为标签增加左右/上下间距，避免标签贴在一起
  const isTagSpacingIntent = /(tag|标签).*(距离|间距|挨着|挨在一起)/i.test(textForRule) ||
    /(左右).*(tag|标签).*(距离|间距|挨着)/i.test(textForRule)
  if (isTagSpacingIntent && targetFile.includes('CommandMarket')) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      // 直接在末尾追加覆盖性规则（即便已有 .tags-row/.tag-item，也由最后一条生效）
      inner += '\n.tags-row { display: flex; flex-wrap: wrap; gap: 4px 8px; }\n'
      inner += '\n.tag-item { margin-right: 0; margin-bottom: 4px; }\n'
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 工具栏与卡片间距：缩短筛选工具栏(.toolbar)与卡片网格(.card-grid)之间的垂直距离
  const isToolbarCardSpacingIntent =
    (/(筛选框|筛选|搜索框|工具栏|这一行)/.test(textForRule) &&
      /卡片/.test(textForRule) &&
      /(距离|间距|太远|太近|近一点|靠近)/.test(textForRule))
  if (isToolbarCardSpacingIntent) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      // 在末尾追加覆盖性规则，减小上下 padding
      inner += '\n.toolbar { padding: 16px 0 16px; }\n'
      inner += '\n.card-grid { padding-top: 12px; }\n'
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 卡片高度：用户提到「卡片高度太高/矮一点」之类，统一降低当前页面卡片最小高度
  const isCardHeightAdjust = /(卡片.*高度.*(太高|矮|低|小|短|再矮|再低)|高度.*(太高|矮|低|小|短|再矮|再低).*卡片|卡片高度还是太高|卡片太高|太高.*卡片|卡片.*太高|指令市场卡片高度.*(矮|低|小|短|再矮|再低))/.test(textForRule)
  if (isCardHeightAdjust) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      // 在末尾追加覆盖性规则，减少 min-height
      inner += '\n.command-card { min-height: 240px; }\n'
      inner += '\n.card-grid .command-card { min-height: 240px; }\n'
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 按钮颜色柔和一点：调整当前文件内主按钮（如 .el-button--primary）的颜色为更柔和的蓝色
  const isButtonColorSoftIntent =
    /按钮/.test(textForRule) &&
    /(颜色|太亮|太刺眼|柔和|淡一点|浅一点|不那么亮|不要这么亮)/.test(textForRule)
  if (isButtonColorSoftIntent) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      inner += '\n.el-button--primary { background-color: #3b82f6; border-color: #3b82f6; box-shadow: 0 6px 18px rgba(59, 130, 246, 0.35); }\n'
      inner += '\n.el-button--primary:hover { filter: brightness(1.06); }\n'
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 标题字号调整：根据「大一点/小一点」调节 .page-title 或 h1 的 font-size
  const isTitleFontSizeIntent = /(主标题|页面标题|标题).*(大一点|再大|大一号|字号大|字体大|小一点|再小|小一号|字号小|字体小)/.test(textForRule)
  if (isTitleFontSizeIntent) {
    const bigger = /(大一点|再大|大一号|字号大|字体大)/.test(textForRule)
    const targetSize = bigger ? 26 : 18
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      inner += `\n.page-title, h1 { font-size: ${targetSize}px; }\n`
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 标题居中：将主标题区域水平居中
  const isTitleCenterIntent = /(主标题|页面标题|标题).*(居中|放中间|放到中间)/.test(textForRule)
  if (isTitleCenterIntent) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[1]) {
      let inner = styleMatch[1]
      inner += '\n.page-header { justify-content: center; }\n'
      inner += '\n.page-title, h1 { text-align: center; }\n'
      const newContent = oldContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _old, close) => open + inner + close
      )
      if (newContent !== oldContent) {
        return {
          file: targetFile,
          newContent: processVueContentStripVerticalWritingMode(newContent)
        }
      }
    }
  }

  // 若指令明显只涉及「样式/美观/布局…」，并且思维引擎认为是简单样式优化（fromRule === 'style_only'），
  // 则优先走 style-only 流程；若 fromRule 为 'style_complex' 或用户原话含 hover/省略号/布局等复杂关键词，则必须走 LLM。
  const isStyleRelated = /样式|美观|布局|颜色|字体|间距|style|css|视觉|靠边框|贴边|靠边|贴边框/.test(textForRule)
  const thoughtFromRule = thought && typeof thought.fromRule === 'string' ? thought.fromRule : ''
  const reasonHasComplex = /(hover|悬停|省略号|ellipsis|卡片里面布局|布局乱|动画|渐变|响应式|栅格)/i.test(action.reason || '')
  const preferStyleOnly = thoughtFromRule === 'style_only'
  const templateChangeRules = [
    'hover_show_full', 'text_ellipsis', 'empty_state', 'loading_state', 'table_stripe', 'button_prevent_double', 'confirm_before_danger',
    'image_lazy', 'responsive_grid', 'copy_clipboard', 'back_to_top', 'form_validation', 'pagination', 'search_filter', 'sort',
    'skeleton_screen', 'error_retry', 'refresh', 'disabled_readonly', 'placeholder', 'tooltip_icon', 'tabs', 'modal_drawer',
    'inline_edit', 'select_all', 'clear_reset', 'export', 'breadcrumb', 'sticky_header', 'generic_modify'
  ]
  const forbidStyleOnly = thoughtFromRule === 'style_complex' || templateChangeRules.includes(thoughtFromRule) || reasonHasComplex
  if ((isStyleRelated || preferStyleOnly) && !forbidStyleOnly && !isTextChangeIntent) {
    const styleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
    if (styleMatch && styleMatch[0]) {
      const styleOnlyResult = await tryStyleOnlyModify(action, targetFile, oldContent, styleMatch[0], opts)
      if (styleOnlyResult) {
        return styleOnlyResult
      }
      // 如果 style-only 失败，则返回 skipped，避免继续让 LLM 重写整页
      return {
        file: targetFile,
        skipped: true,
        message: '为保护页面样式，本次样式优化未能安全生成有效的 <style> 补丁，已跳过。建议缩小修改范围，例如只说明要调整哪一块的颜色或间距。'
      }
    }
  }

  const systemPrompt = [
    '你是 Vue 2 + ElementUI 项目的修改助手，只做「最小必要修改」，严禁粗暴重写整页导致页面不可用。',
    '',
    '硬性规则：',
    '1. 不得删除、合并或简化任何现有 template 结构、class 名、HTML 标签，尤其是 el-row / el-col / el-card / el-form / el-dialog 等组件结构必须保留。',
    '2. 若用户希望整体优化布局，优先通过 CSS（margin/padding/gap/flex/grid 等）实现，尽量不要改 template 的嵌套和栅格列数。',
    '3. 不得删除或大幅缩短 <style scoped> 中的样式；必须原样保留全部 CSS 选择器，除非用户明确只改某几条样式。',
    '4. 若用户只说「优化页面」而无具体改动点，只做一处极小改动（如统一某个字号/间距），不要完全重写文件。',
    '5. 输出必须是「完整单文件」：<template>...</template> + <script>...</script> + <style scoped>...</style>，且长度和结构与原文件大致相当（不要短太多）。',
    '6. 直接输出 .vue 文件内容，不要 JSON，不要用 ``` 包裹，不要任何解释。',
    '7. 布局与可读性：禁止使用 writing-mode: vertical-rl/vertical-lr 等竖排；标题、卡片名称、.name-row/.name-zh/.name-en 必须保持横向排列；不得让文字竖着显示，保证页面好看且可用。'
  ].join('\n')

  const doNotLine = (opts.thought && Array.isArray(opts.thought.doNot) && opts.thought.doNot.length)
    ? '\n\n思维引擎约束（必须遵守，不得违反）：不要做——' + opts.thought.doNot.join('；') + '。'
    : ''
  // 通用能力：根据 fromRule 或 description 追加可执行的具体说明，供 LLM 在任意页面上实现（覆盖所有可能）
  const capabilityExtras = {
    hover_show_full: '【hover 时展示全部】在 template 中找出所有被截断的文案区块（含 text-overflow:ellipsis 或 -webkit-line-clamp），为每个外包 <el-tooltip>，:content 绑定对应数据，placement="top"，:open-delay="300"；多行区块用 effect="light"、popper-class 及非 scoped 样式 max-width:360px;white-space:pre-wrap;word-break:break-word；移除原有 title、@mouseenter、@mouseleave。',
    text_ellipsis: '【超出省略号】为需要截断的文案区块添加样式：单行用 overflow:hidden;text-overflow:ellipsis;white-space:nowrap；多行用 display:-webkit-box;-webkit-line-clamp:N;-webkit-box-orient:vertical;overflow:hidden。根据本文件实际 class 修改。',
    empty_state: '【空状态】当列表/表格数据为空时显示占位：用 v-if/v-else 根据 list.length 等展示 el-empty 或「暂无数据」文案，保留有数据时的原有结构。',
    loading_state: '【加载中】在列表/表格或主内容容器上加 v-loading 绑定 loading 变量；在请求前设 loading=true、请求结束或 catch 里设 false。若无 loading 则在 data 中新增。',
    table_stripe: '【表格斑马纹】为 el-table 添加 stripe 属性，或使用 :row-class-name 返回隔行 class 并配对应 background。',
    button_prevent_double: '【防重复点击】为提交/确认按钮添加 :loading 绑定（如 submitLoading），点击时先置 true、请求结束后置 false；或请求中 disabled。',
    confirm_before_danger: '【危险操作前确认】在删除或危险操作执行前调用 this.$confirm（或 MessageBox.confirm）提示用户确认，用户确认后再执行原有逻辑。',
    card_hover_effect: '【卡片/列表 hover 效果】在卡片或列表项对应 class 的 :hover 中增加 box-shadow、background 或 transform 等，仅改 <style>。',
    image_lazy: '【图片懒加载】为 el-image 添加 lazy 属性；若为原生 img 可改为 el-image 并设 lazy，或加 loading="lazy"。',
    responsive_grid: '【响应式栅格】为 el-col 增加 :xs="24"（小屏一排一个）、:sm="12"、:md="8"、:lg="6" 等，按需调整。',
    copy_clipboard: '【点击复制】为指定内容或按钮增加复制：点击时 navigator.clipboard.writeText 或 execCommand("copy")，成功可 this.$message.success("复制成功").',
    back_to_top: '【回到顶部】增加 el-backtop 或固定按钮，点击时 scrollTo(0,0).',
    form_validation: '【表单校验】el-form 绑定 :rules，表单项 prop 对应；提交前 this.$refs.form.validate()，通过后再提交。',
    pagination: '【分页】el-pagination 绑定 current-page、page-size、total，@current-change、@size-change 更新并重新请求或截取数据。',
    search_filter: '【搜索/筛选】列表上方 el-input 或 el-select 绑定条件，请求时带参数或前端 filter。',
    sort: '【排序】el-table 列 sortable 或 sortable="custom"，sort-change 时传 sort 参数或前端 sort。',
    skeleton_screen: '【骨架屏】v-if="loading" 时显示 el-skeleton，否则显示真实内容。',
    error_retry: '【错误/重试】catch 里 this.$message.error；可选重试按钮重新请求。',
    refresh: '【刷新】按钮点击时重新调用拉取数据 method，可选 v-loading。',
    disabled_readonly: '【禁用/只读】为指定表单项或按钮加 :disabled 或 :readonly，可按条件绑定。',
    placeholder: '【占位文案】修改对应输入框/选择器的 placeholder 为指定文案。',
    tooltip_icon: '【图标/按钮提示】为图标或按钮外包 el-tooltip，content 为提示文案。',
    tabs: '【标签页】el-tabs，tab 与内容对应，v-model 或 @tab-click 切换。',
    modal_drawer: '【弹窗/抽屉】el-dialog 或 el-drawer，visible 控制打开关闭，内容按需放置。',
    inline_edit: '【行内编辑】点击行/单元格切 input 等，编辑后保存更新数据或调接口。',
    select_all: '【全选/批量】el-table 加 type="selection" 列，selection-change 获取选中行；或列表前 checkbox 全选。',
    clear_reset: '【清空/重置】按钮点击 resetFields() 或置空筛选条件，可选重请求。',
    export: '【导出】按钮点击时按当前数据或接口生成 Excel/CSV 或调导出接口下载。',
    breadcrumb: '【面包屑】el-breadcrumb 展示路径，可配合路由或 props。',
    sticky_header: '【吸顶/固定表头】position:sticky;top:0;z-index 适当，或 el-table 固定表头。',
    generic_modify: '' // 兜底：不追加固定步骤，完全按 reason/description 由 LLM 理解实现
  }
  const fromRule = (opts.thought && opts.thought.fromRule) ? opts.thought.fromRule : ''
  const desc = (action.description || '') + (action.reason || '')
  let capabilityExtra = ''
  if (fromRule && capabilityExtras[fromRule] !== undefined) {
    if (capabilityExtras[fromRule]) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras[fromRule]
  } else {
    if (/hover.*展示全部|悬停时展示完整|el-tooltip/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.hover_show_full
    else if (/省略(号)?|text_ellipsis|单行省略|多行省略|截断/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.text_ellipsis
    else if (/空状态|空数据|el-empty|暂无数据|无数据/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.empty_state
    else if (/loading|加载中|v-loading|骨架屏/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.loading_state
    else if (/斑马纹|隔行|table_stripe/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.table_stripe
    else if (/防重复|防止重复|button_prevent_double/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.button_prevent_double
    else if (/确认.*删除|二次确认|confirm_before_danger|\$confirm/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.confirm_before_danger
    else if (/卡片.*hover|列表.*悬停|card_hover/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.card_hover_effect
    else if (/懒加载|image_lazy/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.image_lazy
    else if (/小屏|移动端.*一排|响应式.*栅格|responsive_grid/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.responsive_grid
    else if (/复制|clipboard|copy/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.copy_clipboard
    else if (/回到顶部|backtop/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.back_to_top
    else if (/表单.*校验|必填|rules|validate/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.form_validation
    else if (/分页|pagination/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.pagination
    else if (/搜索|筛选|filter/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.search_filter
    else if (/排序|sortable/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.sort
    else if (/骨架屏|skeleton/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.skeleton_screen
    else if (/错误|失败.*提示|重试/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.error_retry
    else if (/刷新|重新加载|reload/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.refresh
    else if (/禁用|只读|disabled|readonly/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.disabled_readonly
    else if (/占位|placeholder/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.placeholder
    else if (/图标.*提示|tooltip/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.tooltip_icon
    else if (/标签页|tab|el-tabs/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.tabs
    else if (/弹窗|抽屉|dialog|drawer|modal/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.modal_drawer
    else if (/行内编辑|可编辑|inline/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.inline_edit
    else if (/全选|批量|多选|selection/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.select_all
    else if (/清空|重置|reset/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.clear_reset
    else if (/导出|export/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.export
    else if (/面包屑|breadcrumb/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.breadcrumb
    else if (/吸顶|固定表头|sticky/.test(desc)) capabilityExtra = '\n\n【用户明确要求（通用能力）】' + capabilityExtras.sticky_header
  }

  const userPrompt = [
    '要修改的文件：',
    targetFile,
    '',
    '修改原因(reason)：',
    action.reason || '',
    '',
    '修改描述(description)：',
    action.description || '',
    doNotLine,
    capabilityExtra,
    '',
    '当前文件完整内容（修改时必须保留其结构、class 和 style，只改用户要求的那一小部分）：',
    '```vue',
    oldContent,
    '```',
    '',
    '请仅根据 reason/description 做最小修改，原样保留其余所有内容（包括整块 <style scoped>）。'
  ].join('\n')

  // 默认 3072 减少生成长度、加快响应；DEEPSEEK_MAX_TOKENS 可覆盖为更大
  const envMax = parseInt(process.env.DEEPSEEK_MAX_TOKENS, 10)
  const maxTokens = Math.min(8192, envMax > 0 ? envMax : 3072)
  let text = ''
  if (onChunk) {
    for await (const chunk of callDeepseekTextStream(systemPrompt, userPrompt, { max_tokens: maxTokens })) {
      onChunk(chunk)
      text += chunk
    }
  } else {
    text = await callDeepseekText(systemPrompt, userPrompt, { max_tokens: maxTokens })
  }
  if (!text || typeof text !== 'string') {
    throw new Error(`LLM 未返回 newContent（modify_view: ${targetFile}）`)
  }
  let newContent = String(text || '').trim()
  if (/^```/.test(newContent)) {
    const m = newContent.match(/^```[a-zA-Z]*\s*([\s\S]*?)```$/)
    if (m && m[1]) {
      newContent = m[1].trim()
    }
  }

  // 样式保护：未通过时先尝试「仅改 style 块」回退（大文件易被 8192 token 截断）
  const preserveCheck = checkModifyViewPreserve(oldContent, newContent, targetFile)
  if (!preserveCheck.ok) {
    return {
      file: targetFile,
      skipped: true,
      message: preserveCheck.message
    }
  }

  return {
    file: targetFile,
    newContent: processVueContentStripVerticalWritingMode(newContent)
  }
}

/**
 * 大文件被截断时的回退：只让模型重写 <style> 块，再拼回原文件；支持 onChunk 流式回传
 */
async function tryStyleOnlyModify (action, targetFile, oldContent, fullStyleTag, opts = {}) {
  const onChunk = opts && typeof opts.onChunk === 'function' ? opts.onChunk : null
  const systemPrompt = [
    '你是 Vue 2 项目的样式与布局优化助手。用户要求整体优化页面的样式（布局、颜色、字体、间距等），但「业务逻辑与模板结构必须保持可用」。',
    '你只输出一个完整的 <style scoped>...</style> 块，不要输出 template 或 script，不要用 ``` 包裹。',
    '规则：',
    '1. 只能在 CSS 层面调整布局（如 margin / padding / gap / flex 布局 / grid 布局 / 对齐方式），禁止依赖修改 template 结构才能生效的样式。',
    '2. 必须保留当前全部 CSS 选择器，不得删除、合并或省略任何一类（包括 .color-purple、.color-green、.color-blue、.color-orange 等修饰类，以及 .meta-left、.meta-right、.pagination-wrapper 等）。不得将页面改为黑白：保留原有配色（如卡片图标背景渐变、按钮渐变、标签与状态色）。',
    '3. 只在现有规则上微调属性值（如间距、圆角、阴影），或少量新增规则；不得大段删除或替换为“简洁”黑白样式。',
    '4. 禁止使用 writing-mode: vertical-rl 或 vertical-lr；标题、卡片名称、.name-row、.name-zh、.name-en 必须保持横向排列，不得竖排。',
    '5. 卡片网格（el-row/el-col）与卡片高度：同一行内卡片高度一致，.command-card 需保留 min-height 或固定高度，避免卡片高矮不一。',
    '6. 若用户提到「卡片底部贴边」「靠边框」「靠边」或「创建者/日期/订阅数/已启用 贴边」：必须为 .command-card-footer 增加与边框的间距，例如 padding: 20px 36px 28px；可加 border-top: 1px solid #f1f5f9、background: #fafbfc；保持 display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; box-sizing: border-box;，使底部信息与卡片四边保持合适留白。',
    '7. 每条 CSS 规则必须独立闭合：每个选择器的 { } 内只能包含该规则的属性，属性末尾要有分号，规则末尾用 } 闭合；不要把注释或下一段规则写进上一个规则的 { } 内。穿透子组件样式请用 >>>，不要用 ::v-deep 或 :deep()。'
  ].join('\n')
  const userPrompt = [
    '修改描述：',
    action.reason || '',
    action.description || '',
    '',
    '当前组件的 <style scoped> 内容（请在此基础上做样式优化，输出完整的新 <style scoped>...</style>）：',
    fullStyleTag
  ].join('\n')
  // 样式优化快速路径：较小 max_tokens 缩短响应（DEEPSEEK_FAST_MODE=1 时用 1536，否则 2048）
  const fastMode = process.env.DEEPSEEK_FAST_MODE === '1' || process.env.DEEPSEEK_FAST_MODE === 'true'
  const defaultStyleMax = fastMode ? 1536 : 2048
  const styleMax = parseInt(process.env.DEEPSEEK_STYLE_MAX_TOKENS, 10) || defaultStyleMax
  const maxTokens = Math.min(4096, styleMax)
  let text = ''
  if (onChunk) {
    for await (const chunk of callDeepseekTextStream(systemPrompt, userPrompt, { max_tokens: maxTokens })) {
      onChunk(chunk)
      text += chunk
    }
  } else {
    text = await callDeepseekText(systemPrompt, userPrompt, { max_tokens: maxTokens })
  }
  if (!text || typeof text !== 'string') return null
  let newStyleBlock = String(text).trim()
  if (/^```/.test(newStyleBlock)) {
    const m = newStyleBlock.match(/^```[a-zA-Z]*\s*([\s\S]*?)```$/)
    if (m && m[1]) newStyleBlock = m[1].trim()
  }
  if (!/<style[\s\S]*?>[\s\S]*<\/style>/i.test(newStyleBlock)) {
    if (!newStyleBlock.includes('</style>')) newStyleBlock = '<style scoped>\n' + newStyleBlock + '\n</style>'
    else if (!newStyleBlock.trimStart().startsWith('<style')) newStyleBlock = '<style scoped>\n' + newStyleBlock
  }
  const innerMatch = newStyleBlock.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
  let inner = innerMatch ? innerMatch[1] : newStyleBlock
  inner = normalizeVue2DeepSelector(inner)
  inner = fixBrokenNameEnBlock(inner)
  inner = stripVerticalWritingMode(inner)
  inner = ensureStyleBlockClosed(inner)
  if (innerMatch) newStyleBlock = newStyleBlock.replace(/(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i, (_, o, __, c) => o + inner + c)
  else newStyleBlock = inner
  const newContent = oldContent.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/i, newStyleBlock)
  if (newContent === oldContent) return null
  return { file: targetFile, newContent }
}

/**
 * 后处理：去掉竖排样式，保证标题/卡片名横向，避免「优化样式」后标题竖着、布局乱
 */
function stripVerticalWritingMode (styleContent) {
  if (!styleContent || typeof styleContent !== 'string') return styleContent
  let out = styleContent
  // 去掉 writing-mode: vertical-rl / vertical-lr（整行或声明）
  out = out.replace(/writing-mode\s*:\s*vertical-rl\s*;?/gi, '')
  out = out.replace(/writing-mode\s*:\s*vertical-lr\s*;?/gi, '')
  out = out.replace(/writing-mode\s*:\s*vertical\s*;?/gi, '')
  if (/\.name-row|\.name-zh|\.name-en|\.command-content/.test(out) && !/\.name-row[\s\S]*?writing-mode\s*:\s*horizontal-tb/.test(out)) {
    const safeguard = '\n/* 引擎保护：保证卡片名称横向 */ .name-row, .name-zh, .name-en { writing-mode: horizontal-tb !important; }'
    if (!out.trimEnd().endsWith('}')) out += '\n'
    out += safeguard
  }
  return out
}

/**
 * 修复 <style> 内未闭合的块和常见截断（避免 LLM 写出 Unclosed block / 半截属性）
 * - 大括号平衡：若 { 多于 }，自动补全 }
 * - 常见截断：如 flex-s 补成 flex-shrink: 0；末尾缺分号则补 ;
 */
function ensureStyleBlockClosed (styleInner) {
  if (!styleInner || typeof styleInner !== 'string') return styleInner
  let s = styleInner.trimEnd()
  // 常见 LLM 截断：属性写一半就断了，补全为合法声明
  const truncations = [
    [/\bflex-s\s*$/i, 'flex-shrink: 0'],
    [/\bdisplay:\s*$/i, 'display: flex'],
    [/\bpadding:\s*$/i, 'padding: 0'],
    [/\bmargin:\s*$/i, 'margin: 0'],
    [/\bmargin-top:\s*$/i, 'margin-top: auto'],
    [/\bwidth:\s*$/i, 'width: 100%'],
    [/\bheight:\s*$/i, 'height: auto'],
    [/\bcolor:\s*$/i, 'color: inherit'],
    [/\bfont-size:\s*$/i, 'font-size: 14px']
  ]
  for (const [re, replacement] of truncations) {
    if (re.test(s)) {
      s = s.replace(re, replacement)
      break
    }
  }
  // 若最后一行是属性值未结束（以字母/数字结尾且没有 ; 和 }），补分号
  if (/[a-zA-Z0-9%]\s*$/.test(s) && !/;\s*$/.test(s) && !/\}\s*$/.test(s)) {
    s = s.replace(/\s+$/, ';\n')
  }
  // 大括号平衡：缺少的 } 补在末尾，最多补 20 个防止异常
  let open = 0
  for (const c of s) {
    if (c === '{') open++
    else if (c === '}') open = Math.max(0, open - 1)
  }
  for (let i = 0; i < open && i < 20; i++) {
    s += '\n}'
  }
  return s
}

/**
 * 去掉重复的 <style 开标签（如 <style scoped>\n<style scoped> 只保留一个）
 */
function dedupeStyleOpenTags (vueContent) {
  if (!vueContent || typeof vueContent !== 'string') return vueContent
  return vueContent.replace(/(<style\s[^>]*>)\s*\n\s*\1/, '$1')
}

/** Vue2 兼容：将 :deep(...) / ::v-deep 转为 >>>，避免 stylePostLoader 报错 Expected a pseudo-class or pseudo-element */
function normalizeVue2DeepSelector (styleInner) {
  if (!styleInner || typeof styleInner !== 'string') return styleInner
  let out = styleInner
  out = out.replace(/:deep\s*\(\s*([^)]+)\s*\)/g, '>>> $1')
  out = out.replace(/::v-deep\s+/g, '>>> ')
  return out
}

/**
 * 修复 LLM 常写坏的 .name-en 块：未闭合、缺分号、引擎保护被塞进同一条规则导致 parser 报错
 * 匹配 .name-en { ... color: #64748b 后直接跟 /* 引擎保护 的情况，先闭合 .name-en 再保留保护行
 * 支持 font-size: 16px 或 17px，以及无分号、多空行等情况
 */
function fixBrokenNameEnBlock (styleInner) {
  if (!styleInner || typeof styleInner !== 'string') return styleInner
  let out = styleInner
  // 原特定 pattern：17px
  out = out.replace(
    /(\.name-en\s*\{\s*font-size:\s*17px;\s*color:\s*#64748b)\s*;?\s*(\n\s*)*(\/\*[^*]*引擎保护[^*]*\*\/\s*\.name-row[\s\S]*?\!\important;\s*\})\s*\n\s*\}/g,
    '$1;\n}\n\n$3'
  )
  // 通用：.name-en { ... color: #64748b 后紧跟（可选空白+）/* 引擎保护，先闭合 .name-en 再保留保护行（[\s\S]*? 跨行）
  out = out.replace(
    /(\.name-en\s*\{[\s\S]*?color:\s*#64748b)\s*;?\s*(\n\s*)*(\/\*[^*]*引擎保护[^*]*\*\/\s*\.name-row[\s\S]*?\!\important;\s*\}\s*)(\n\s*\})?/g,
    '$1;\n}\n\n$3'
  )
  return out
}

/**
 * 针对完整 .vue 内容的兜底处理：
 * - 找出 <style>...</style> 块，做竖排清理 + 未闭合/截断修复 + Vue2 深度选择器兼容
 * - 去掉重复的 <style> 开标签
 */
function processVueContentStripVerticalWritingMode (vueContent) {
  if (!vueContent || typeof vueContent !== 'string') return vueContent
  let finalContent = dedupeStyleOpenTags(vueContent)
  const styleBlockMatch = finalContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
  if (styleBlockMatch && styleBlockMatch[1]) {
    let inner = styleBlockMatch[1]
    inner = normalizeVue2DeepSelector(inner)
    inner = ensureStyleBlockClosed(inner)
    inner = stripVerticalWritingMode(inner)
    inner = fixBrokenNameEnBlock(inner)
    inner = ensureStyleBlockClosed(inner)
    if (inner !== styleBlockMatch[1]) {
      finalContent = finalContent.replace(
        /(<style[\s\S]*?>)([\s\S]*?)(<\/style>)/i,
        (_, open, _inner, close) => open + inner + close
      )
    }
  }
  return finalContent
}

/**
 * 检查 modify_view 的 LLM 输出是否保留了原文件的关键结构和样式，避免「优化」导致整页样式丢失
 */
function checkModifyViewPreserve (oldContent, newContent, targetFile) {
  const oldLen = oldContent.length
  const newLen = newContent.length
  // 新内容不能比原文短太多（例如少于 70%），否则认为样式被大幅删减
  if (newLen < oldLen * 0.7) {
    return {
      ok: false,
      message: '为保护页面样式，本次模型返回内容过短，已拒绝应用。请具体说明要改的文字或功能（例如：只改标题、只改某按钮文案）后再试。'
    }
  }

  // 只做最宽松的闭合标签存在性检查（子串即可），避免因格式/编码导致误判
  const lower = newContent.toLowerCase()
  const hasTemplate = lower.includes('</template>')
  const hasScript = lower.includes('</script>')
  const hasStyle = lower.includes('</style>')
  if (!hasTemplate || !hasScript || !hasStyle) {
    return {
      ok: false,
      message: '为保护页面样式，模型返回内容缺少 template/script/style 任一完整块，已拒绝应用。请具体说明要改的部分后再试。'
    }
  }

  // 原文件中的 <style 块长度；新文件的 style 块不能明显更短（例如少于原来的 50%）
  const oldStyleMatch = oldContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/)
  const newStyleMatch = newContent.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/)
  const oldStyleLen = (oldStyleMatch && oldStyleMatch[1]) ? oldStyleMatch[1].length : 0
  const newStyleLen = (newStyleMatch && newStyleMatch[1]) ? newStyleMatch[1].length : 0
  if (oldStyleLen > 200 && newStyleLen < oldStyleLen * 0.5) {
    return {
      ok: false,
      message: '为保护页面样式，模型返回的样式部分过少，已拒绝应用。请具体说明要改的功能或文案，不要使用「优化页面」等笼统描述。'
    }
  }

  return { ok: true }
}

async function generate (plan, projectInfo) {
  const files = []
  const skipped = []
  if (!plan || !Array.isArray(plan.actions)) return { files, skipped }

  for (const action of plan.actions) {
    if (action.type === 'add_view') {
      const vueCode = await generateForAddView(action, projectInfo)
      files.push({
        type: 'view',
        viewName: action.viewName,
        routePath: action.routePath,
        routeTitle: action.routeTitle || action.description || action.viewName,
        vueCode
      })
    } else if (action.type === 'modify_view') {
      const mod = await generateForModifyView(action, projectInfo)
      if (mod.skipped) {
        skipped.push({ file: mod.file, message: mod.message })
      } else {
        files.push({
          type: 'modify',
          file: mod.file,
          newContent: mod.newContent
        })
      }
    }
  }
  return { files, skipped }
}

module.exports = {
  generate,
  generateForAddView,
  generateForModifyView,
  processVueContentStripVerticalWritingMode
}

