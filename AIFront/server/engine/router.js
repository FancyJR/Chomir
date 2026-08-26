/**
 * 消息路由器（router）
 *
 * 职责：
 * - 对「无代码聊天输入」做“意图识别”：生成新页面 / 修改现有代码 / 仅问答
 * - 优先用本地规则（ruleBasedRoute）处理高频场景，避免每次都请求大模型
 * - 若规则未命中，再调用 DeepSeek（callDeepseekJson）做细粒度路由
 *
 * 路由结果会被 /api/engine/execute 使用，用来决定后续是走 planner/codegen/apply 还是 QA。
 * - 内置「先听懂再动手」：换个说法/好听一点/改文案 → 传原话给 planner，只改副标题，不生成页面（见 isOnlyChangeCopy）
 */

const { callDeepseekJson } = require('./shared-llm')

/**
 * 规则引擎：对一些高频、非常明确的场景直接返回路由结果
 * 这样可以：
 * - 减少不必要的大模型调用
 * - 降低幻觉概率（例如明确“优化指令市场样式”时直接指定文件）
 */
function ruleBasedRoute (message) {
  const text = (message || '').trim()
  if (!text) return null

  // 页面/界面空白/白屏/右侧什么都没有 → 直接走「修改现有页面」链路，让 planner/codegen 排查 Bug，而不是问答
  const isPageBlankBugRoute =
    /((页面|页|界面|画面|右侧|右边).*(空白|白屏|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的))|((空白|白屏|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的).*(页面|界面|画面|右侧|右边))/.test(text) ||
    /(点击|点开).*(菜单|导航).*(右侧|右边).*(空白|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的)/.test(text)
  if (isPageBlankBugRoute) {
    return {
      kind: 'modify_existing',
      engineInstruction: text,
      qaHint: '',
      notes: '规则：页面/右侧空白/白屏 → 修复当前页面显示问题'
    }
  }

  // 通用：任意「X改成Y」/「X改为Y」（可有可无空格）→ 透传原话，由 codegen 做全文查找替换
  if (/.+\s*改成\s*.+/.test(text) || /.+\s*改为\s*.+/.test(text)) {
    return {
      kind: 'modify_existing',
      engineInstruction: text,
      qaHint: '',
      notes: '规则：X 改成 Y → 透传，codegen 通用替换'
    }
  }

  // 优先识别「只改文案/换说法」：用户是在说某段话/某几个字换个说法，不是要生成页面，直接传原话给规划器
  const isOnlyChangeCopy = (
    /换个?说法|换一种说法|好听一点|好听些|顺口一点|改一下说法|改下文案|这段(话|文案|描述|说明)|上面那句|这句(话)?\s*(换|改)|指令类型.*[换改]|[换改].*指令类型|指令类型.*(这几个字|这段|换一种描述)/.test(text) ||
    (/(描述|文案|副标题|说明|句子|话)\s*(换|改)|(换|改)\s*(描述|文案|说法)/.test(text) && !/生成|写一个|新建|加一个|做一[个张]|整[个页]|整个页面/.test(text))
  )
  if (isOnlyChangeCopy) {
    return {
      kind: 'modify_existing',
      engineInstruction: text,
      qaHint: '',
      notes: '规则：只改文案/换说法 → 传原话给 planner，做仅改 .page-subtitle，不生成页面'
    }
  }

  // 明确「优化…样式/颜色/布局/卡片高度/间距」→ 走改代码；目标页面由 planner 根据用户本句提到的页面名或当前打开页决定，不写死任一页
  const hasOptimize = text.includes('优化') || text.includes('美化')
  const veryShort = text.length <= 20 && /^[\s\S]*优化[\s\S]*$/.test(text) || /^[\s\S]*美化[\s\S]*$/.test(text)
  const hasTarget = text.includes('指令市场') || text.includes('CommandMarket') || text.includes('页面') || text.includes('仪表盘') || text.length < 35 || veryShort
  const styleLike = (
    text.includes('样式') || text.includes('颜色') || text.includes('布局') || text.includes('美观') ||
    text.includes('卡片') || text.includes('高度') || text.includes('间距') || text.includes('视觉') || text.includes('统一') || veryShort
  )
  if (hasOptimize && (hasTarget || styleLike) && (styleLike || veryShort)) {
    const hasComplexStyleKeyword = /(hover|悬停|省略号|ellipsis|卡片里面布局|布局乱|动画|渐变|响应式|栅格)/i.test(text)
    return {
      kind: 'modify_existing',
      engineInstruction: hasComplexStyleKeyword
        ? text
        : [
            '优化【用户本句所提到的页面或当前打开页】的整体视觉和卡片高度，包括布局、颜色、字体、间距等，使其更美观统一；',
            '业务逻辑必须完全不变（筛选、分页、弹窗、新建/编辑等行为保持原样）；',
            '整体布局调整应优先通过 CSS（margin/padding/gap/flex/grid 等）完成，',
            '严禁大幅改动 template 结构，尤其是 el-row/el-col 栅格、卡片循环、表单字段、class 名称，保证每行卡片高度一致且可用。'
          ].join(''),
      qaHint: '',
      notes: hasComplexStyleKeyword ? '规则：优化+复杂样式 -> 透传原话' : '规则：优化+样式/视觉 -> 目标页由 planner 按用户意图解析'
    }
  }

  // 卡片高度调节：目标页由 planner 按用户本句（如「指令市场卡片」「仪表盘卡片」）或当前打开页决定
  const isCardHeightAdjust = /(指令市场|CommandMarket|仪表盘|dashboard|卡片).*高度.*(太高|矮|低|小|短|再矮|再低)/.test(text) ||
    /(高度).*(太高|矮|低|小|短|再矮|再低).*(卡片)/.test(text) ||
    /卡片高度还是太高|卡片太高|卡片.*太高/.test(text)
  if (isCardHeightAdjust) {
    return {
      kind: 'modify_existing',
      engineInstruction: text,
      qaHint: '',
      notes: '规则：卡片高度调节 → 目标页由 planner 按用户意图解析'
    }
  }

  // 工具栏与卡片间距：目标页由 planner 按用户本句或当前打开页决定
  const isToolbarCardSpacing = (
    (/(筛选框|筛选|搜索框|工具栏|这一行)/.test(text) &&
      /卡片/.test(text) &&
      /(距离|间距|太远|太近|近一点|靠近)/.test(text))
  )
  if (isToolbarCardSpacing) {
    return {
      kind: 'modify_existing',
      engineInstruction: text,
      qaHint: '',
      notes: '规则：工具栏与卡片间距调节 → 目标页由 planner 按用户意图解析'
    }
  }

  // 笼统「优化页面/指令市场」易触发整页重写、样式丢失 → 走问答并引导用户具体说明要改哪一块
  if (text.includes('优化') && (text.includes('指令市场') || text.includes('页面') || /优化\s*(一下)?\s*$/.test(text))) {
    const hasSpecific = /改|加|把|标题|按钮|样式|颜色|布局|增加|删除|替换|改成|改为|文案|文字/.test(text)
    if (!hasSpecific) {
      return {
        kind: 'qa',
        engineInstruction: '',
        qaHint: '用户说想优化指令市场或页面，但没有说明具体要改什么。请用一两句话建议：请具体说明要优化哪一块（例如：只改标题、只改某个按钮文字、只加一个筛选条件），这样可以在保留现有样式的前提下精准修改。',
        notes: '规则：笼统优化引导用户具体化'
      }
    }
  }

  // 典型场景：列表/卡片 点击跳转详情 → 目标列表页由 planner 按用户本句或当前打开页决定
  const hasList = text.includes('列表')
  const hasCard = text.includes('卡片')
  const hasDetail = text.includes('详情')
  const hasCommand = text.includes('指令') || text.includes('自定义指令')

  if (hasDetail && (hasList || hasCard || hasCommand)) {
    const engineInstruction = [
      '请在【用户本句所提到的列表页或当前打开页】中，',
      '为卡片或列表项添加跳转到详情页的逻辑，详情页路由统一使用 /generated/latest。',
      '',
      '要求：',
      '1. 在合适的点击入口（例如卡片点击或「编辑/查看详情」按钮）中调用 this.$router.push。',
      '2. 可以使用 this.$router.push({ path: \'/generated/latest\', query: { id: command.id } })，其中 command.id 来源于当前循环项。',
      '3. 保持该页原有的筛选、分页、mock 数据等逻辑不变，只添加点击跳转行为，不要删除或重构其它逻辑。',
      '4. 路由 /generated/latest 视为最新生成的详情页，无需在本次修改中生成新视图。'
    ].join('\n')

    return {
      kind: 'modify_existing',
      engineInstruction,
      qaHint: '',
      notes: '规则：列表/卡片跳转详情 → 目标页由 planner 按用户意图解析'
    }
  }

  return null
}

/**
 * routeMessage：对一条聊天消息进行路由判定
 *
 * - 先跑本地规则（ruleBasedRoute），命中则直接返回
 * - 否则调用 DeepSeek，让模型基于项目结构返回 { kind, engineInstruction, qaHint }
 */
async function routeMessage (message, projectInfo, context) {
  // 先尝试规则匹配，命中则直接返回，减少幻觉和时延
  const rule = ruleBasedRoute(message)
  if (rule) return rule

  const systemPrompt = [
    '你是一个智能路由器，负责判断「一条用户聊天输入」在前端项目里的作用类型。',
    '项目是 Vue2 + ElementUI + Vue Router 架构。',
    '',
    '你只输出 JSON，不要任何解释或注释。',
    '',
    '可选的 kind：',
    '- "generate_page"：用户在描述一个新的页面结构、布局、模块（适合走页面生成流程）。',
    '- "modify_existing"：用户在要求修改现有页面/路由/样式/校验等行为（例如「列表点击跳详情」「按钮加事件」「只改样式」等）。',
    '- "qa"：用户在纯粹提问（例如问使用方法、解释代码、问业务概念），需要走问答，不改代码。',
    '',
    'Context: 项目结构（只读）：',
    JSON.stringify(projectInfo, null, 2),
    '',
    '调用方上下文（只读）：',
    JSON.stringify(context || {}, null, 2),
    '',
    '输出 JSON 结构：',
    '{',
    '  "kind": "generate_page" | "modify_existing" | "qa",',
    '  "engineInstruction": "若 kind=modify_existing，这里给出一条适合发送给 /api/engine/apply-instruction 的中文指令；',
    '                        若 kind=generate_page，可留空；若 kind=qa，可省略或留空。",',
    '  "qaHint": "若 kind=qa，这里给出一条附加提示，说明这是关于什么的提问（如：页面用法 / 代码解释 / 业务概念），便于后续问答更准确。",',
    '  "notes": "可选，人类可读备注"',
    '}'
  ].join('\n')

  const userPrompt = [
    '这是一条刚刚在前端「无代码开发」聊天输入框中发送的用户消息：',
    '',
    message
  ].join('\n')

  const data = await callDeepseekJson(systemPrompt, userPrompt)
  if (!data || typeof data !== 'object') {
    return { kind: 'qa' }
  }
  const allowed = ['generate_page', 'modify_existing', 'qa']
  const kind = allowed.includes(data.kind) ? data.kind : 'qa'
  return {
    kind,
    engineInstruction: data.engineInstruction || '',
    qaHint: data.qaHint || '',
    notes: data.notes || ''
  }
}

module.exports = {
  routeMessage
}

