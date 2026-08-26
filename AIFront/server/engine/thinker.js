/**
 * 思维引擎（thinker）
 *
 * 职责：在「用户原话」丢给路由/规划/模型之前，先像人一样理解意图，
 * 产出结构化理解（想做什么、不要做什么、具体改哪里），并生成无歧义的 refinedInstruction，
 * 从而减少后续路由与规划的幻觉、瞎指挥，让结果和用户真正想要的对应上。
 *
 * 流程：先规则匹配常见意图 → 未命中则调模型做意图理解 → 输出 thought 供 execute 使用
 */

const { callDeepseekText, callDeepseekJson, callDeepseekStreamJsonReasoningFirst } = require('./shared-llm')

/**
 * 规则优先：对常见、明确的用户说法直接产出结构化理解，零次 LLM
 * message 支持是原话或「原话 + 补充」拼接文本，用于在澄清续问时一并考虑上下文
 */
function ruleBasedThink (message) {
  const text = (message || '').trim()
  if (!text) return null

  // 0) 菜单/菜单项 没有或加 logo/图标 → 通用意图：在「项目语义中包含导航菜单的文件」里为该菜单项添加图标，不写死左侧/App.vue
  const isMenuIconIntent =
    /(菜单|导航|侧栏|侧边|顶栏|sidebar|nav|el-menu)/.test(text) &&
    /(没有logo|没有图标|缺.*图标|加logo|加图标|加上logo|加上图标)/.test(text)
  const isMenuIconShort = /^(加上logo|加logo|加个图标|加个logo|加上图标)$/.test(text.trim())
  const hasMenuItemHint = /今日股票|指令市场|仪表盘|期货|表格|无代码|足球|篮球|羽毛球|指令详情|菜单项|某个项/.test(text)
  if (isMenuIconIntent || (isMenuIconShort && hasMenuItemHint)) {
    const menuItemHint = /今日股票推荐|今日股票/.test(text) ? '「今日股票推荐」'
      : /指令市场/.test(text) ? '「指令市场」'
      : /仪表盘/.test(text) ? '「仪表盘」'
      : /期货预测|期货/.test(text) ? '「期货预测」'
      : /表格页/.test(text) ? '「表格页」'
      : /无代码/.test(text) ? '「无代码开发」'
      : /足球/.test(text) ? '「足球数据统计」'
      : /篮球/.test(text) ? '「篮球数据统计」'
      : /羽毛球/.test(text) ? '「羽毛球数据统计」'
      : /指令详情/.test(text) ? '「指令详情」'
      : '用户所指的菜单项'
    return {
      intentSummary: `在包含导航菜单的布局文件中，为${menuItemHint}对应的菜单项添加左侧图标`,
      doNot: ['不要改业务视图页面内容', '只改包含 el-menu 的布局/根组件中的 el-menu-item'],
      target: '由 projectInfo.semantic.menuContainers 确定的、包含导航菜单的文件（如 App.vue、Layout.vue 等）',
      refinedInstruction: `在【目标文件：由 projectInfo.semantic.menuContainers 解析出的包含导航/菜单的文件】中，找到${menuItemHint}对应的菜单项（如 el-menu-item、a-menu-item 等，依当前项目而定），在其内（标题或 slot="title" 前）添加左侧图标，写法与同文件中其它菜单项完全一致（根据当前项目实际使用的 UI 库：Element 用 el-icon-*，Ant Design 用 a-icon/Icon 等）。仅修改该菜单项，不改其它文件。`,
      rawMessage: text,
      fromRule: 'menu_item_icon'
    }
  }
  if (isMenuIconShort) {
    return {
      intentSummary: '用户指在导航菜单某菜单项上加 logo/图标（目标文件由项目语义 menuContainers 确定）',
      doNot: ['不要改当前页面内容区', '目标为包含菜单的布局文件'],
      target: '由 semantic.menuContainers 确定的包含导航菜单的文件',
      refinedInstruction: '在【目标文件：projectInfo.semantic.menuContainers 中的菜单所在文件】中，为尚未带图标的菜单项添加左侧图标，写法与同文件中其它菜单项一致（根据当前项目使用的 UI 库而定）。若用户之前提到过具体菜单名，则只改该项。仅修改该布局文件。',
      rawMessage: text,
      fromRule: 'menu_item_icon_short'
    }
  }

  // 1) 通用：任意「X改成Y」/「X改为Y」（可有可无空格）——原样透传，由 codegen 做全文查找替换，不枚举具体文案
  if (/.+\s*改成\s*.+/.test(text) || /.+\s*改为\s*.+/.test(text)) {
    return {
      intentSummary: '用户希望将某处文字或代码替换为指定内容',
      doNot: ['不要改其他无关位置', '不要整页重写'],
      target: '用户指定的原文 → 新文',
      refinedInstruction: text,
      rawMessage: text,
      fromRule: 'generic_replace'
    }
  }

  // 0.5) 指令市场列表页整体太丑 → 直接认定是想美化列表页，而不是详情页，不再反复追问
  const isCommandMarketUgly =
    /(指令市场|CommandMarket).*?(页面|列表)?.*(丑|不好看|难看|丑爆|不美观|灰了吧唧|不精致)/.test(text)
  if (isCommandMarketUgly) {
    return {
      intentSummary: '用户觉得指令市场列表页面整体不够美观，想要整体优化视觉与布局',
      doNot: [
        '不要误改指令详情页',
        '不要改路由与接口逻辑',
        '不要删除现有功能，只做样式与布局上的美化'
      ],
      target: '指令市场列表页面（src/views/CommandMarket.vue）',
      refinedInstruction: '对指令市场列表页面（src/views/CommandMarket.vue）进行整体视觉与布局美化：在不改变现有数据与交互逻辑的前提下，优化卡片样式、配色、留白、阴影与排版，使其更现代、更统一。仅修改与 UI/UX 相关的 template 与 style，不动业务逻辑与路由。',
      rawMessage: text,
      fromRule: 'command_market_ugly'
    }
  }

  // 0.55) 某个页面/界面「空白/白屏/右侧什么都没有」→ 直接认定是页面渲染或数据加载 Bug，而不是反复追问
  // 典型：
  // - 期货预测页面空白了
  // - 某某页面白屏了
  // - 点击左侧 XXX 菜单，右侧还是什么都没有
  const isPageBlankBug =
    /((页面|页|界面|画面|右侧|右边).*(空白|白屏|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的))|((空白|白屏|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的).*(页面|界面|画面|右侧|右边))/.test(text) ||
    /(点击|点开).*(菜单|导航).*(右侧|右边).*(空白|啥也没|什么都没|没有内容|没显示|不显示|出不来|空的)/.test(text)
  if (isPageBlankBug) {
    const hasFutures = /(期货|期货预测|期货策略|期货量化)/.test(text)
    const mentionsMenu = /(点击|点开).*(菜单|导航)/.test(text)
    return {
      intentSummary: hasFutures
        ? '用户反馈「期货预测」相关页面出现空白/白屏或点击菜单后右侧无内容，想修复页面显示或路由跳转问题'
        : '用户反馈当前某个页面出现空白/白屏或点击菜单后右侧无内容，想修复页面显示或路由跳转问题',
      doNot: [
        '不要重写整个项目结构或大范围改路由配置',
        '不要改动与该页面无关的其它页面',
        '优先检查路由与菜单绑定是否正确，再检查该页面的数据加载、条件渲染与运行时错误'
      ],
      target: hasFutures
        ? '期货预测相关页面及其路由/菜单绑定（FuturesPrediction.vue + /futures-prediction + App.vue 菜单）'
        : '当前路由对应的页面及其路由/菜单绑定（由 activeFile 或默认视图决定）',
      refinedInstruction: hasFutures
        ? '排查并修复期货预测页面出现空白/白屏或点击左侧「期货预测」菜单后右侧无内容的问题：1）先检查 App.vue 中 el-menu 的 index="/futures-prediction" 是否与 src/router/index.js 中的 path "/futures-prediction" 完全一致，且该路由正确挂载了 FuturesPrediction 组件；2）确认 <router-view> 正常渲染且没有被条件隐藏；3）在不改动无关页面的前提下，检查 FuturesPrediction.vue 内部是否存在运行时错误（例如 echarts 初始化、mounted 钩子报错）、接口请求失败或 v-if 条件始终为 false，导致内容不渲染，并修复这些问题，使期货预测页面重新正常显示内容。'
        : '排查并修复当前页面出现空白/白屏或点击菜单后右侧无内容的问题：1）优先检查 App.vue（或布局组件）中 el-menu 的 index 是否与 src/router/index.js 中对应路由的 path 完全一致，并确认该 path 已正确挂载目标组件；2）确认 <router-view> 正常存在且未被 v-if/v-show 隐藏；3）在不改动无关页面的前提下，检查该页面内部是否存在运行时错误、接口请求失败或 v-if 条件始终为 false 导致不渲染内容，并修复这些问题，使页面重新正常显示内容。',
      rawMessage: text,
      fromRule: 'page_blank_bug'
    }
  }

  // 0.6) 指令市场页面「股票名称显示不对」类问题（例如：代码是 600002，名称却是「股票3」）
  // 目标：识别这是「数据/映射 Bug」，而不是让用户提供正确股票名称，避免一轮轮追问
  const isMarketStockNameBug =
    // 一句话里直接提到指令市场 + 股票名称 + 不对
    /(指令市场|CommandMarket).*(股票名称|股票名字|名称值|股票名).*(不对|错误|有问题|不准确)/.test(text) ||
    // 明确说「股票名称显示的股票3 不对」
    /(股票名称|股票名字).*(显示的?)?股票\d+.*(不对|错误|有问题|不准确)/.test(text) ||
    /股票名称显示的?股票\d+[，,。]*(展示|显示)?不对/.test(text) ||
    // 说明代码对、名称不对（结合上一轮原话时也能命中）
    /(股票代码|代码).*(600\d{3}).*(对|是对的).*(股票名称|股票名字|名称值).*(不对|错误|有问题|不准确)/.test(text) ||
    // 指出是「接收数据/大模型返回数据不对」但又提到股票名称
    /(接收数据|返回数据|大模型).*不对.*(股票名称|股票名字|名称值|股票名)/.test(text)
  if (isMarketStockNameBug) {
    return {
      intentSummary: '用户发现指令市场页面中的股票推荐列表里，股票名称字段是占位符（如「股票3」），与股票代码不匹配，认为这是数据/映射 Bug，希望修复展示逻辑。',
      doNot: [
        '不要改动指令市场页面的整体布局和样式',
        '不要删除或重写股票推荐表格以外的业务逻辑',
        '不要依赖真实行情接口，只在现有 mock/本地生成数据的范围内修复名称展示'
      ],
      target: '指令市场页面股票推荐列表（src/views/CommandMarket.vue 中 stockList 生成与展示逻辑）',
      refinedInstruction:
        '检查指令市场页面（src/views/CommandMarket.vue）中股票推荐表格的 stockList 数据生成逻辑，修复股票名称字段，避免出现「股票3」这类难以识别的占位名称：在不接入真实行情接口的前提下，让 name 字段至少与股票代码一一对应、便于识别（例如使用更直观的命名规则，或在名称中包含股票代码），保证代码和名称展示一致且可理解。',
      rawMessage: text,
      fromRule: 'command_market_stock_name_bug'
    }
  }

  // 1) 明确「指令类型」该处换说法 → 只改工具栏标签，不改别的
  if (/指令类型.*[换改修]|[换改修].*指令类型|指令类型.*(这几个字|该处|换一种描述)/.test(text)) {
    return {
      intentSummary: '用户希望将页面工具栏中的「指令类型：」换一种说法，仅改该处几个字',
      doNot: ['不要改副标题', '不要改样式', '不要生成新页面', '不要改其他文案'],
      target: '工具栏标签「指令类型：」',
      refinedInstruction: '将当前页面工具栏中的「指令类型：」该处文案换一种说法，仅改该处文字，不动其他。',
      rawMessage: text,
      fromRule: 'instruction_type_label'
    }
  }

  // 2) 换描述/副标题/好听一点 → 只改 .page-subtitle，相同语义换说法
  if (/(描述|文案|副标题|说法).*[换改]|[换改].*(描述|文案|副标题|说法)|不好听|好听一点|换个说法|换一种说法/.test(text) && !/指令类型/.test(text)) {
    return {
      intentSummary: '用户希望将页面副标题（或某段描述）相同语义换一种说法',
      doNot: ['不要改主标题', '不要改样式', '不要生成新页面', '不要缩短或改变原意'],
      target: '页面副标题 .page-subtitle',
      refinedInstruction: '将当前页面副标题（.page-subtitle）的文案相同语义换一种说法，仅改该处，不改主标题与样式。',
      rawMessage: text,
      fromRule: 'subtitle_rewrite'
    }
  }

  // 2.8) 仅说某个页面名（无具体操作）→ 通用锁定该页，不追问，由 planner 按页面名解析目标
  const trimmed = text.trim()
  const pageOnlyPatterns = [
    { re: /^(指令市场(页面)?|改指令市场|我要改指令市场|指令市场|CommandMarket)$/, name: '指令市场' },
    { re: /^(期货预测(页面)?|期货页面|改期货|FuturesPrediction)$/, name: '期货预测' },
    { re: /^(详情页|指令详情(页面)?|改详情页|CommandDetail)$/, name: '详情页' },
    { re: /^(仪表盘|首页|Dashboard)$/, name: '仪表盘' },
    { re: /^(无代码|低代码页面|NoCode)$/, name: '无代码' },
    { re: /^(今日股票|股票推荐页)$/, name: '今日股票推荐' }
  ]
  for (const { re, name } of pageOnlyPatterns) {
    if (re.test(trimmed)) {
      return {
        intentSummary: `用户指定目标为「${name}」页面，等待用户说明具体要做的修改`,
        doNot: ['不要改其他无关页面'],
        target: `「${name}」对应视图（由 planner 根据页面名解析）`,
        refinedInstruction: `用户仅指定了目标页面「${name}」，未说具体修改内容。若当前仅此一句，请回复：已锁定为【${name}】页面，请直接说您要做的修改。若对话上下文中有用户之前说的具体修改内容，则按该内容对「${name}」对应视图执行修改。`,
        rawMessage: text,
        fromRule: 'page_name_only',
        targetSpecificationOnly: true,
        lockedPageName: name
      }
    }
  }

  // 2.9) 卡片里的 tag/标签 位置（下面、跑上面、很丑）→ 通用：改「用户所指页面」的卡片内标签样式，目标文件由上下文/当前页/用户提到的页面名决定
  const isCardTagPosition =
    /(卡片|card).*(里面|内)?.*(tag|标签)/.test(text) && /(下面|上面|位置|跑上面|跑下面|很丑|难看)/.test(text)
  const isCardTagPositionAlt = /(tag|标签).*(卡片|card)/.test(text) && /(下面|上面|位置|跑上面|跑下面|很丑)/.test(text)
  if (isCardTagPosition || isCardTagPositionAlt) {
    return {
      intentSummary: '用户希望卡片内的标签（tag）固定在卡片下方显示，不要跑到上面',
      doNot: ['不要改 template 结构，仅改样式', '目标页面由用户当前打开页或用户明确提到的页面名确定'],
      target: '用户当前所在页面或用户明确提到的页面中，卡片内标签区域（.command-content 与 .tags-row）',
      refinedInstruction: '在当前目标页面（由上下文 activeFile/currentRoute 或用户原话中提到的页面名确定）中，将卡片内的标签（.tags-row）固定在卡片内容区底部显示：为 .command-content 设置 flex:1 与 min-height:0，为 .tags-row 设置 margin-top: auto，使标签始终在卡片主体下方。仅修改 <style>，不改 template 与逻辑。',
      rawMessage: text,
      fromRule: 'card_tag_position'
    }
  }

  // 2.95) 卡片内「描述」垂直居中：用户说「指令市场每个卡片的描述垂直居中」「描述现在偏上了」「还是没垂直居中」等
  // 说明：这里不写死 CommandMarket.vue，而是交给 planner 结合 activeFile / currentRoute / originalMessage 解析具体页面，
  // 规则只负责把「这是卡片描述区的垂直居中样式问题」这件事说清楚，避免再去追问「是哪一块」。
  const isCardDescriptionCenter =
    /(卡片|card).*(描述|description).*(垂直居中|上下居中|纵向居中)/.test(text) ||
    /(描述|description).*(垂直居中|上下居中|纵向居中).*(卡片|card)/.test(text)
  if (isCardDescriptionCenter) {
    return {
      intentSummary: '用户希望卡片中的描述文案在卡片内容区域内垂直居中显示，而不是贴在上方',
      doNot: [
        '不要改动接口与数据字段',
        '不要重写或大改卡片 template 结构',
        '不要调整标签(tag) 区域的位置（保持标签仍然在卡片下方）'
      ],
      target: '当前目标页面中卡片主内容区域内部的描述文字块（例如 .description-wrap / .description）',
      refinedInstruction:
        '在当前目标页面（由上下文 activeFile/currentRoute 或用户原话中提到的页面名确定）中，将卡片主内容区域里的描述文案做垂直居中对齐：保持标题在上、标签(.tags-row) 在下不变，通过为描述外层容器（如 .description-wrap）设置 flex:1、display:flex、align-items:center 等方式，使描述在卡片可用内容高度范围内看起来是上下居中的。仅修改 <style> 中与描述相关的样式，不改 template 与业务逻辑。',
      rawMessage: text,
      fromRule: 'card_description_vertical_center'
    }
  }

  // 3) 标签间距：用户提到 tag/标签 左右距离、挨着等 → 只改标签样式间距
  if (/(tag|标签).*(距离|间距|挨着|挨在一起)/i.test(text) || /(左右).*(tag|标签).*(距离|间距|挨着)/i.test(text)) {
    return {
      intentSummary: '用户希望调整当前页面卡片或区域内标签的左右间距',
      doNot: ['不要改副标题或标题', '不要生成新页面', '不要修改业务逻辑或模板结构'],
      target: '当前页面中用于展示标签的行（例如 .tags-row 与 .tag-item）',
      refinedInstruction: '在当前页面中，为标签列表区域增加合适的左右间距（例如 .tags-row 使用 flex + gap，或 .tag-item 增加 margin-right），仅修改 <style> 中与标签相关的样式，不改 template 和其他样式。',
      rawMessage: text,
      fromRule: 'tag_spacing'
    }
  }

  // 4) 工具栏与卡片间距：筛选框/搜索框这一行和下面卡片距离太远/近一点 → 只改 toolbar 与 card-grid 间距
  if (
    (/(筛选框|筛选|搜索框|工具栏|这一行)/.test(text) &&
      /卡片/.test(text) &&
      /(距离|间距|太远|太近|近一点|靠近)/.test(text))
  ) {
    return {
      intentSummary: '用户希望缩短当前页面中筛选工具栏与卡片列表之间的垂直间距',
      doNot: ['不要改标题和副标题', '不要生成新页面', '不要改业务逻辑或模板结构'],
      target: '当前页面工具栏(.toolbar)与卡片网格(.card-grid)之间的垂直间距',
      refinedInstruction:
        '在当前页面中，缩短筛选工具栏这一行(.toolbar)与下面卡片列表(.card-grid)之间的垂直距离，例如减小 .toolbar 的下内边距和 .card-grid 的上内边距，仅修改 <style> 中相关 padding，不改 template 与逻辑。',
      rawMessage: text,
      fromRule: 'toolbar_card_spacing'
    }
  }

  // 5) 按钮颜色柔和一点 / 太刺眼 → 调整主按钮颜色为更柔和的色值
  if (/按钮/.test(text) && /(颜色|太亮|太刺眼|柔和|淡一点|浅一点|不那么亮|不要这么亮)/.test(text)) {
    return {
      intentSummary: '用户希望当前页面主按钮颜色更柔和、不要太刺眼',
      doNot: ['不要改按钮文案', '不要改按钮布局', '不要生成新页面', '不要改业务逻辑'],
      target: '当前页面内的主按钮（如 .el-button--primary）',
      refinedInstruction: '在当前页面样式中，将主按钮（如 .el-button--primary）的背景色和边框色调整为更柔和的蓝色，并优化 hover 态的亮度，仅修改 <style> 中与按钮颜色相关的属性，不改 template 与逻辑。',
      rawMessage: text,
      fromRule: 'button_color_soften'
    }
  }

  // 6) 标题字号调整：标题字号大一点/小一点
  if (/(主标题|页面标题|标题).*(大一点|再大|大一号|字号大|字体大|小一点|再小|小一号|字号小|字体小)/.test(text)) {
    return {
      intentSummary: '用户希望调整页面主标题的字号大小',
      doNot: ['不要改标题文案', '不要改副标题', '不要改布局结构', '不要生成新页面'],
      target: '当前页面主标题（例如 .page-title 或 h1）',
      refinedInstruction: '在当前页面样式中，调整主标题（例如 .page-title 或 h1）的 font-size，使其根据用户描述变大或变小，仅修改字号，不改标题文案与布局结构。',
      rawMessage: text,
      fromRule: 'title_fontsize'
    }
  }

  // 7) 标题居中：标题/主标题 居中/放中间
  if (/(主标题|页面标题|标题).*(居中|放中间|放到中间)/.test(text)) {
    return {
      intentSummary: '用户希望将页面主标题居中显示',
      doNot: ['不要改标题文案', '不要改其他区域布局', '不要生成新页面'],
      target: '当前页面主标题区域（如 .page-header / .page-title）',
      refinedInstruction: '在当前页面样式中，将主标题区域（如 .page-header 内的 .page-title）设置为水平居中对齐，例如通过 text-align: center 与 justify-content: center，仅修改样式，不改文案和业务逻辑。',
      rawMessage: text,
      fromRule: 'title_center'
    }
  }

  // 7.5) 标题排版样式问题（通用）：中英文/多语言标题占宽度一样、中文竖排/挤在一起、整体很丑 → 识别为标题区域样式 Bug，只改 CSS
  const isTitleLayoutUgly =
    /(标题|title)/.test(text) &&
    (/(中文|Chinese)/.test(text) || /(英文|English)/.test(text) || /中英文标题|多语言标题/.test(text)) &&
    /(竖着|竖排|一竖|太挤|挤在一起|难看|很丑|不好看)/.test(text)
  if (isTitleLayoutUgly) {
    return {
      intentSummary: '用户觉得当前页面的中英文/多语言标题排版不好看（例如中文被压缩成竖排或标题彼此挤在一起），希望通过 CSS 优化标题布局和折行行为。',
      doNot: [
        '不要改任何数据或接口逻辑',
        '不要改标题文案本身',
        '不要重写或大改 template 结构，仅通过 CSS 调整布局与折行行为'
      ],
      target: '当前页面中展示中英文/多语言标题的区域（例如卡片标题行、列表标题行等容器）',
      refinedInstruction:
        '在当前页面中，优化中英文/多语言标题的排版样式，避免因为宽度一致或布局不合理导致中文竖着展示、标题挤在一起：在不改动业务逻辑和模板结构的前提下，通过调整标题容器及其子元素的 CSS（例如标题行的 flex 布局、gap、max-width/width、white-space、word-break、行高等），让中文标题能够水平自然展示、不被过度压缩，同时保证英文或其他语言标题显示正常、整体视觉更协调。仅修改 <style> 中与标题相关的样式，不改 JS 逻辑与其它区域布局。',
      rawMessage: text,
      fromRule: 'title_layout_ugly'
    }
  }

  // 7.6) 中英文标题宽度太宽 / 超出卡片：例如「中英文标题现在宽度有点宽，都超出卡片了，宽度小一点」
  // 说明：识别为卡片标题区域的样式问题，只动 .name-row / .name-zh / .name-en 的宽度与溢出，不再追问是哪一块。
  const isCardTitleWidthTooWide =
    /(中英文标题|中英文名字|中英文名称|标题)/.test(text) &&
    /(宽度|太宽|变窄|窄一点|小一点|超出|溢出|超过卡片)/.test(text) &&
    /(卡片|card|指令市场|CommandMarket)/.test(text)
  if (isCardTitleWidthTooWide) {
    return {
      intentSummary: '用户觉得当前页面中英文标题在卡片内宽度过大、横向超出卡片，希望整体缩窄并避免溢出。',
      doNot: [
        '不要改标题文案本身',
        '不要修改标题所在行以外的布局（例如标签区域、描述区域）',
        '不要改动接口与数据字段',
        '不要重写 template 结构，仅通过 CSS 限制宽度与溢出'
      ],
      target: '当前页面中展示中英文标题的卡片标题行（例如 .name-row / .name-zh / .name-en）',
      refinedInstruction:
        '在当前目标页面（由上下文 activeFile/currentRoute 或用户原话中提到的页面名确定）中，缩小卡片中英文标题的宽度并避免横向溢出：通过调整 .name-row / .name-zh / .name-en 的 max-width、flex-basis 与 overflow，使中英文标题在同一行内不会超过卡片可用宽度，超出的部分使用 text-overflow: ellipsis 截断，整体视觉上比当前更窄一些但仍保持可读。仅修改 <style> 中与标题宽度/溢出相关的样式，不改业务逻辑与模板结构。',
      rawMessage: text,
      fromRule: 'card_title_width_too_wide'
    }
  }

  // 8) hover 时展示全部：用户说 hover/悬停 时(候) 展示/显示 全部/完整，或说「没展示全部」「还是没展示全部」
  const isHoverShowFull =
    /(hover|悬停)\s*时(候)?\s*(还是)?\s*(没)?\s*(展示|显示)\s*(全部|完整)/.test(text) ||
    /(展示|显示)\s*(全部|完整)\s*(hover|悬停|时)/.test(text) ||
    /(没|还是没)\s*展示\s*全部/.test(text) ||
    /hover\s*时候\s*还是\s*没/.test(text)
  if (isHoverShowFull) {
    return {
      intentSummary: '用户希望鼠标悬停被截断的文案时能展示全部内容',
      doNot: ['不要整页重写', '不要删改业务逻辑', '不要删除或合并现有 template 结构'],
      target: '当前页面内所有被省略的文案区块（任意页面通用）',
      refinedInstruction: '在当前页面中，为所有被省略（text-overflow: ellipsis 或 -webkit-line-clamp）的文案区块添加 el-tooltip，使鼠标悬停时展示完整内容：根据模板中实际使用的数据（如 v-for 的 item.xxx、或单条数据的字段）将 content 绑定到对应完整字段，placement 为 top，open-delay 300；若某区块原有 @mouseenter/@mouseleave 或仅靠 title 展示，改为 el-tooltip。仅做上述修改，保持其余逻辑与样式不变。',
      rawMessage: text,
      fromRule: 'hover_show_full'
    }
  }

  // 9) 超出省略号（通用）：长文本/标题/描述 超出显示省略号、单行省略、多行省略、截断、显示不下、溢出
  if (/(超出|长文本|标题|描述|文字|文案).*(显示)?\s*省略(号)?|(单行|多行)\s*省略|省略号\s*显示|截断|显示不下|太长\s*溢出|超长\s*省略|ellipsis/i.test(text)) {
    return {
      intentSummary: '用户希望当前页面中长文案超出时显示省略号',
      doNot: ['不要整页重写', '不要删改业务逻辑', '不要删除现有结构'],
      target: '当前页面内需要截断的文案区块（任意页面通用）',
      refinedInstruction: '在当前页面中，为需要截断的文案区块添加省略样式：单行截断用 overflow:hidden; text-overflow:ellipsis; white-space:nowrap；多行截断用 display:-webkit-box; -webkit-line-clamp:N; -webkit-box-orient:vertical; overflow:hidden。根据当前文件实际结构选择对应 class 或内联样式，仅改样式或必要的最小 template 包裹。',
      rawMessage: text,
      fromRule: 'text_ellipsis'
    }
  }

  // 10) 空状态（通用）：没有数据时显示空状态、列表为空时显示占位、无数据、空列表、没有记录
  if (/(没有数据|列表为空|空数据|无数据|空列表|没有记录|无记录).*(显示|展示|加)?|(显示|加).*(空状态|占位|空占位|empty)|空状态|空数据(时)?\s*显示|暂无数据/i.test(text)) {
    return {
      intentSummary: '用户希望列表/表格无数据时显示空状态或占位',
      doNot: ['不要整页重写', '不要删改有数据时的展示逻辑'],
      target: '当前页面列表/表格容器（任意页面通用）',
      refinedInstruction: '在当前页面中，当列表或表格数据为空时显示空状态：在数据列表/表格的容器上根据数据长度（如 list.length===0）用 v-if/v-else 展示 el-empty 或自定义空状态占位（如「暂无数据」），保留原有有数据时的结构。仅做以上修改。',
      rawMessage: text,
      fromRule: 'empty_state'
    }
  }

  // 11) 加载中（通用）：加载时显示 loading、数据请求时显示加载中、请求中、转圈、骨架屏
  if (/(加载|请求).*(显示|加)?\s*(loading|加载中|转圈|骨架屏)?|(显示|加).*(loading|加载中)|数据请求.*loading|loading\s*效果|加载中\s*显示|请求中\s*显示|骨架屏|skeleton/i.test(text)) {
    return {
      intentSummary: '用户希望在数据加载或请求过程中显示 loading 状态',
      doNot: ['不要整页重写', '不要删改数据请求逻辑'],
      target: '当前页面列表/表格/表单容器（任意页面通用）',
      refinedInstruction: '在当前页面中，在数据加载或请求期间显示加载状态：在列表/表格或主内容容器上使用 v-loading 绑定 loading 变量（或 el-skeleton），在请求前设 loading=true、请求结束后设 loading=false。若已有 data 中 loading 字段则复用，否则新增。仅做以上修改。',
      rawMessage: text,
      fromRule: 'loading_state'
    }
  }

  // 12) 表格斑马纹（通用）：表格斑马纹、隔行变色
  if (/(表格|el-table).*(斑马纹|隔行)|斑马纹|隔行\s*变(色|背景)/.test(text)) {
    return {
      intentSummary: '用户希望表格使用斑马纹或隔行变色',
      doNot: ['不要改表格列与数据', '不要整页重写'],
      target: '当前页面的 el-table（任意页面通用）',
      refinedInstruction: '在当前页面中，为 el-table 增加斑马纹效果：添加 stripe 属性（<el-table stripe>），或通过 :row-class-name 实现隔行背景色。仅做以上修改。',
      rawMessage: text,
      fromRule: 'table_stripe'
    }
  }

  // 13) 按钮防重复点击（通用）：提交防重复点击、按钮防止重复点击
  if (/(提交|按钮).*(防(止)?\s*重复|防(止)?\s*二次|禁止重复)|防(止)?\s*重复\s*点击|点击\s*后\s*禁用/.test(text)) {
    return {
      intentSummary: '用户希望提交或确认类按钮防止重复点击',
      doNot: ['不要改按钮文案与业务逻辑', '不要整页重写'],
      target: '当前页面提交/确认类按钮（任意页面通用）',
      refinedInstruction: '在当前页面中，为提交或确认类按钮增加防重复点击：使用 :loading 绑定一个 loading 变量（如 submitLoading），点击时先设 true、请求结束后设 false，或使用 disabled 在提交中禁用按钮。若已有 loading 状态则复用。仅做以上修改。',
      rawMessage: text,
      fromRule: 'button_prevent_double'
    }
  }

  // 14) 危险操作前确认（通用）：删除前确认、操作前二次确认
  if (/(删除|操作).*(前|时).*(确认|二次确认)|(确认|二次确认).*(删除|操作)|(删除|操作)\s*前\s*要\s*确认/.test(text)) {
    return {
      intentSummary: '用户希望删除或危险操作前弹出确认框',
      doNot: ['不要改删除/操作的后端逻辑', '不要整页重写'],
      target: '当前页面删除或危险操作按钮（任意页面通用）',
      refinedInstruction: '在当前页面中，在执行删除或危险操作前先弹出确认：使用 this.$confirm（或 MessageBox）在用户点击删除/危险按钮时先提示「是否确认删除？」等，用户确认后再执行原有逻辑。仅做以上修改。',
      rawMessage: text,
      fromRule: 'confirm_before_danger'
    }
  }

  // 15) 卡片/列表项 hover 效果（通用）：卡片 hover 有阴影、列表项悬停高亮
  if (/(卡片|列表项|列表).*(hover|悬停).*(阴影|高亮|效果)|(hover|悬停).*(阴影|高亮).*(卡片|列表)/.test(text) || /卡片\s*hover|列表\s*悬停/.test(text)) {
    return {
      intentSummary: '用户希望卡片或列表项在 hover 时有视觉反馈',
      doNot: ['不要改布局与业务逻辑', '不要整页重写'],
      target: '当前页面卡片或列表项容器（任意页面通用）',
      refinedInstruction: '在当前页面样式中，为卡片或列表项增加 hover 效果：在对应 class 上添加 :hover 样式，如 box-shadow 加深、background 微变、或 transform: translateY(-2px)，使鼠标悬停时有明显反馈。仅修改 <style>，不改 template。',
      rawMessage: text,
      fromRule: 'card_hover_effect'
    }
  }

  // 16) 图片懒加载（通用）：图片懒加载
  if (/图片?\s*懒加载|懒加载\s*图片|img\s*lazy|image\s*lazy/i.test(text)) {
    return {
      intentSummary: '用户希望页面图片使用懒加载',
      doNot: ['不要改图片地址与业务逻辑', '不要整页重写'],
      target: '当前页面中的图片（img 或 el-image）（任意页面通用）',
      refinedInstruction: '在当前页面中，为图片增加懒加载：若使用 el-image 则加 lazy 属性；若使用原生 img 则改为 el-image 并设置 lazy，或使用 loading="lazy"（兼容性允许时）。仅做以上修改。',
      rawMessage: text,
      fromRule: 'image_lazy'
    }
  }

  // 17) 响应式栅格（通用）：小屏一排一个、移动端一排一个
  if (/(小屏|移动端|手机端).*(一排\s*一个|一个\s*一排)|(一排\s*一个|响应式).*(小屏|移动端)|栅格\s*响应|el-col\s*响应/.test(text)) {
    return {
      intentSummary: '用户希望小屏或移动端时栅格一排显示一个或适配',
      doNot: ['不要改大屏下的列数逻辑', '不要整页重写'],
      target: '当前页面 el-row/el-col 或栅格布局（任意页面通用）',
      refinedInstruction: '在当前页面中，为栅格增加响应式：在 el-col 上设置 :xs="24" 使小屏一排一个，:sm="12"、:md="8"、:lg="6" 等随屏宽递增列数，或根据用户描述调整 breakpoint。仅做以上修改。',
      rawMessage: text,
      fromRule: 'responsive_grid'
    }
  }

  // 18) 点击复制 / 一键复制（通用）
  if (/(点击|一键|按钮).*复制|复制\s*到\s*剪贴板|copy|clipboard/i.test(text)) {
    return {
      intentSummary: '用户希望某处内容可点击复制到剪贴板',
      doNot: ['不要改原有展示逻辑', '不要整页重写'],
      target: '当前页面需支持复制的内容或按钮（任意页面通用）',
      refinedInstruction: '在当前页面中，为指定内容或按钮增加复制到剪贴板能力：点击时使用 navigator.clipboard.writeText 或 execCommand("copy") 将目标文本写入剪贴板，可配合 this.$message.success("复制成功")。仅做以上修改。',
      rawMessage: text,
      fromRule: 'copy_clipboard'
    }
  }

  // 19) 回到顶部（通用）
  if (/回到顶部|返回顶部|back\s*to\s*top|el-backtop/i.test(text)) {
    return {
      intentSummary: '用户希望页面有回到顶部按钮或功能',
      doNot: ['不要改页面主体布局', '不要整页重写'],
      target: '当前页面（任意页面通用）',
      refinedInstruction: '在当前页面中增加回到顶部：使用 el-backtop 或固定定位按钮，点击时 scrollTo(0,0) 或 el-backtop 默认行为。仅做以上修改。',
      rawMessage: text,
      fromRule: 'back_to_top'
    }
  }

  // 20) 表单校验 / 必填项（通用）
  if (/(表单|输入|必填).*(校验|验证|校验)|提交\s*前\s*校验|校验\s*通过\s*才|rules|required/i.test(text)) {
    return {
      intentSummary: '用户希望表单有校验或必填项校验',
      doNot: ['不要删改已有表单项', '不要整页重写'],
      target: '当前页面 el-form 及表单项（任意页面通用）',
      refinedInstruction: '在当前页面中，为 el-form 增加 rules 校验：在 form 上绑定 :rules，在需要必填的 el-form-item 上设置 prop 与 rules 中对应项（required: true、message），提交前调用 this.$refs.form.validate()，通过后再提交。仅做以上修改。',
      rawMessage: text,
      fromRule: 'form_validation'
    }
  }

  // 21) 分页（通用）
  if (/(加|增加|要|弄).*分页|分页\s*(组件|功能)|el-pagination|列表\s*分页/.test(text)) {
    return {
      intentSummary: '用户希望列表或表格有分页',
      doNot: ['不要改列表数据逻辑', '不要整页重写'],
      target: '当前页面列表/表格下方（任意页面通用）',
      refinedInstruction: '在当前页面中增加分页：使用 el-pagination，绑定 current-page、page-size、total，@current-change 与 @size-change 时更新页码并重新请求数据（或截取当前页数据）。仅做以上修改。',
      rawMessage: text,
      fromRule: 'pagination'
    }
  }

  // 22) 搜索 / 筛选（通用）
  if (/(加|增加|要).*(搜索|筛选)|(搜索|筛选).*(框|功能)|el-input.*search|filter/.test(text)) {
    return {
      intentSummary: '用户希望增加搜索或筛选功能',
      doNot: ['不要删改列表主体', '不要整页重写'],
      target: '当前页面列表/表格上方或工具栏（任意页面通用）',
      refinedInstruction: '在当前页面中增加搜索或筛选：在列表上方加 el-input（可带搜索图标）或 el-select，v-model 绑定关键字/筛选条件，在请求列表数据时带上该参数，或前端 filter 过滤。仅做以上修改。',
      rawMessage: text,
      fromRule: 'search_filter'
    }
  }

  // 23) 排序（通用）
  if (/(表格|列表).*排序|排序\s*功能|sortable|sort-order/i.test(text)) {
    return {
      intentSummary: '用户希望表格或列表支持排序',
      doNot: ['不要改列定义与数据', '不要整页重写'],
      target: '当前页面 el-table 列或列表头（任意页面通用）',
      refinedInstruction: '在当前页面中为表格或列表增加排序：el-table 列加 sortable 或 sortable="custom"，监听 sort-change 在请求时传 sort 参数，或前端对数据 sort。仅做以上修改。',
      rawMessage: text,
      fromRule: 'sort'
    }
  }

  // 24) 骨架屏 / Skeleton（通用）
  if (/骨架屏|skeleton|加载\s*骨架|占位\s*骨架/i.test(text)) {
    return {
      intentSummary: '用户希望加载时显示骨架屏',
      doNot: ['不要改数据加载逻辑', '不要整页重写'],
      target: '当前页面主内容区域（任意页面通用）',
      refinedInstruction: '在当前页面中，在数据加载时显示骨架屏：使用 el-skeleton 或自定义骨架占位，v-if="loading" 时显示骨架、否则显示真实内容。仅做以上修改。',
      rawMessage: text,
      fromRule: 'skeleton_screen'
    }
  }

  // 25) 错误提示 / 失败重试（通用）
  if (/(错误|失败).*(提示|显示|toast)|(重试|再试).*(按钮|一次)|请求\s*失败\s*提示|error\s*message/i.test(text)) {
    return {
      intentSummary: '用户希望请求失败时有提示或重试',
      doNot: ['不要改请求成功逻辑', '不要整页重写'],
      target: '当前页面请求逻辑（任意页面通用）',
      refinedInstruction: '在当前页面中，请求失败时给出提示：在 catch 中 this.$message.error(err.message 或 "请求失败")；可选增加「重试」按钮或提示中的重试逻辑，重新发起请求。仅做以上修改。',
      rawMessage: text,
      fromRule: 'error_retry'
    }
  }

  // 26) 刷新按钮 / 重新加载（通用）
  if (/(刷新|重新加载|重新请求|reload).*(按钮|一下|功能)|(加|要).*刷新\s*按钮/.test(text)) {
    return {
      intentSummary: '用户希望有刷新或重新加载功能',
      doNot: ['不要改原有数据展示', '不要整页重写'],
      target: '当前页面工具栏或操作区（任意页面通用）',
      refinedInstruction: '在当前页面中增加刷新：按钮或图标点击时重新调用拉取数据的 method（如 fetchList），可选 v-loading 在刷新时显示。仅做以上修改。',
      rawMessage: text,
      fromRule: 'refresh'
    }
  }

  // 27) 禁用 / 只读（通用）
  if (/(输入框|表单|按钮).*(禁用|只读|disabled|readonly)|(禁用|只读).*(某|这个|这里)/.test(text)) {
    return {
      intentSummary: '用户希望某输入或按钮为禁用或只读',
      doNot: ['不要改其他表单项', '不要整页重写'],
      target: '当前页面指定表单项或按钮（任意页面通用）',
      refinedInstruction: '在当前页面中，根据用户描述为指定 el-input/el-select 或按钮添加 :disabled 或 :readonly，可按条件绑定（如状态为某值时禁用）。仅做以上修改。',
      rawMessage: text,
      fromRule: 'disabled_readonly'
    }
  }

  // 28) 占位文案 / placeholder（通用）
  if (/(占位|placeholder|提示文案).*(改|换|设置)|输入框\s*占位|placeholder\s*改/i.test(text)) {
    return {
      intentSummary: '用户希望修改占位文案或 placeholder',
      doNot: ['不要改校验与逻辑', '不要整页重写'],
      target: '当前页面输入框等 placeholder（任意页面通用）',
      refinedInstruction: '在当前页面中，根据用户描述修改对应输入框或选择器的 placeholder 属性为指定文案。仅做以上修改。',
      rawMessage: text,
      fromRule: 'placeholder'
    }
  }

  // 29) 图标/按钮的 tooltip 提示（通用）
  if (/(图标|按钮).*(提示|tooltip)|(鼠标|悬停).*(显示|出现).*提示|el-tooltip\s*包/i.test(text)) {
    return {
      intentSummary: '用户希望图标或按钮悬停时显示提示',
      doNot: ['不要改图标与逻辑', '不要整页重写'],
      target: '当前页面图标或按钮（任意页面通用）',
      refinedInstruction: '在当前页面中，为指定图标或按钮外包 el-tooltip，content 为提示文案，placement 按需。仅做以上修改。',
      rawMessage: text,
      fromRule: 'tooltip_icon'
    }
  }

  // 30) 标签页 / Tabs 切换（通用）
  if (/(加|要|弄).*标签页|tab\s*切换|el-tabs|多\s*tab/i.test(text)) {
    return {
      intentSummary: '用户希望增加标签页或 Tab 切换',
      doNot: ['不要删改现有主内容', '不要整页重写'],
      target: '当前页面（任意页面通用）',
      refinedInstruction: '在当前页面中增加 el-tabs：tab 与内容区对应，v-model 或 @tab-click 切换显示不同内容。仅做以上修改。',
      rawMessage: text,
      fromRule: 'tabs'
    }
  }

  // 31) 弹窗 / 抽屉（通用）
  if (/(弹窗|对话框|抽屉|drawer|dialog|modal).*(加|要|打开)|(加|要).*(弹窗|抽屉)/.test(text)) {
    return {
      intentSummary: '用户希望增加或调整弹窗/抽屉',
      doNot: ['不要改页面主体逻辑', '不要整页重写'],
      target: '当前页面弹窗或抽屉组件（任意页面通用）',
      refinedInstruction: '在当前页面中增加或调整 el-dialog/el-drawer：控制 visible 的变量，打开时设 true、关闭时设 false，内容按用户描述放置。仅做以上修改。',
      rawMessage: text,
      fromRule: 'modal_drawer'
    }
  }

  // 32) 行内编辑 / 可编辑（通用）
  if (/(行内|表格|列表).*编辑|可编辑|inline\s*edit|点击\s*编辑/.test(text)) {
    return {
      intentSummary: '用户希望支持行内或可编辑',
      doNot: ['不要改数据结构', '不要整页重写'],
      target: '当前页面表格或列表行（任意页面通用）',
      refinedInstruction: '在当前页面中实现行内编辑：点击行或单元格时切换为 input/select 等，编辑后保存更新数据或调用接口，可配合 blur 或确认按钮。仅做以上修改。',
      rawMessage: text,
      fromRule: 'inline_edit'
    }
  }

  // 33) 全选 / 批量选择（通用）
  if (/(全选|批量|多选|勾选).*(表格|列表)|(表格|列表).*(全选|多选)|selection|select-all/i.test(text)) {
    return {
      intentSummary: '用户希望表格或列表支持全选/批量选择',
      doNot: ['不要改列与数据', '不要整页重写'],
      target: '当前页面 el-table 或列表（任意页面通用）',
      refinedInstruction: '在当前页面中为 el-table 增加 type="selection" 列，通过 selection-change 或 ref 获取选中行；或列表前加 checkbox 全选。仅做以上修改。',
      rawMessage: text,
      fromRule: 'select_all'
    }
  }

  // 34) 清空 / 重置（通用）
  if (/(清空|重置|清空筛选|重置表单).*(按钮|功能)|(按钮|功能).*(清空|重置)/.test(text)) {
    return {
      intentSummary: '用户希望有清空或重置功能',
      doNot: ['不要改表单或列表主体', '不要整页重写'],
      target: '当前页面表单或筛选区（任意页面通用）',
      refinedInstruction: '在当前页面中增加清空/重置：按钮点击时对表单调用 resetFields() 或手动将筛选条件置空，并可选重新请求数据。仅做以上修改。',
      rawMessage: text,
      fromRule: 'clear_reset'
    }
  }

  // 35) 导出（通用）
  if (/(导出|export).*(Excel|excel|数据|列表)|(加|要).*导出/.test(text)) {
    return {
      intentSummary: '用户希望支持导出数据',
      doNot: ['不要改列表与数据逻辑', '不要整页重写'],
      target: '当前页面工具栏或操作区（任意页面通用）',
      refinedInstruction: '在当前页面中增加导出：按钮点击时根据当前列表数据或接口生成 Excel/CSV（可用 xlsx 等库）或触发后端导出接口，下载文件。仅做以上修改。',
      rawMessage: text,
      fromRule: 'export'
    }
  }

  // 36) 面包屑（通用）
  if (/(面包屑|breadcrumb|导航路径).*(加|要)|(加|要).*面包屑/.test(text)) {
    return {
      intentSummary: '用户希望增加面包屑导航',
      doNot: ['不要改页面主内容', '不要整页重写'],
      target: '当前页面顶部（任意页面通用）',
      refinedInstruction: '在当前页面顶部增加 el-breadcrumb，展示当前路径（如 首页 / 列表 / 详情），可配合路由或 props 生成。仅做以上修改。',
      rawMessage: text,
      fromRule: 'breadcrumb'
    }
  }

  // 37) 吸顶 / 固定表头（通用）
  if (/(吸顶|固定\s*表头|sticky|滚动\s*固定).*(导航|头部|表头)/.test(text)) {
    return {
      intentSummary: '用户希望某区域吸顶或固定',
      doNot: ['不要改主体布局', '不要整页重写'],
      target: '当前页面需吸顶的头部或表头（任意页面通用）',
      refinedInstruction: '在当前页面中为指定头部或表头增加吸顶：position: sticky; top: 0; z-index 适当，或 el-table 的 fixed 表头。仅改 style 或对应属性。',
      rawMessage: text,
      fromRule: 'sticky_header'
    }
  }

  // 38) 优化页面/样式/卡片 → 简单场景走本地 CSS，小而精；复杂场景（省略号/布局细节等）优先调大模型（注意：hover 展示全部已由规则 8 处理）
  if (/优化/.test(text) && (/页面|样式|卡片|布局|美观|贴边|靠边框/.test(text))) {
    const hasComplexStyleKeyword = /(hover|悬停|悬浮|省略号|ellipsis|动画|渐变|响应式|网格|栅格|卡片里面布局|布局乱|重排)/i.test(text)
    return {
      intentSummary: '用户希望优化页面样式或布局，使其更美观',
      doNot: ['不要整页重写', '不要删改业务逻辑', '不要大幅改 template 结构'],
      target: '当前页面的样式（CSS）',
      refinedInstruction: '优化当前页面的卡片与整体样式，仅调整 CSS（间距、颜色、布局等），保持业务逻辑和 template 不变；如涉及复杂效果（省略号、hover 动画等）可适当补充对应的 CSS。',
      rawMessage: text,
      fromRule: hasComplexStyleKeyword ? 'style_complex' : 'style_only'
    }
  }

  // 兜底：任何「改/加/要/实现/弄/帮/让/把/给」类祈使句，一律视为对当前页的修改意图，原话透传（覆盖所有可能）
  const looksLikeModify = (
    /^(改|加|要|实现|弄|帮|让|把|给|做|搞|弄个|加个|要个|帮我|给咱)/.test(text) ||
    (text.length <= 100 && /(改|加|要|实现|弄|增加|加上|弄个|加个)(一下|个|一个)?\s*/.test(text))
  )
  if (looksLikeModify) {
    return {
      intentSummary: '用户希望对当前页面做修改或增加功能，按用户原意精确实现',
      doNot: ['不要整页重写', '不要删改与用户描述无关的逻辑', '不要扩大修改范围'],
      target: '当前页面（由 activeFile 或默认视图决定）',
      refinedInstruction: text,
      rawMessage: text,
      fromRule: 'generic_modify'
    }
  }

  return null
}

/**
 * 主入口：先规则后模型，产出 thought，供 execute 在路由与规划前使用
 * @returns { Promise<{ intentSummary: string, doNot: string[], target: string, refinedInstruction: string, rawMessage: string }> }
 */
/** 当用户针对「追问」做补充时，构建完整对话内容，供模型一次性理解 */
function buildUserPromptForThink (raw, context) {
  const replyTo = context && context.replyToClarification
  if (!replyTo || typeof replyTo.originalMessage !== 'string' || typeof replyTo.clarificationQuestion !== 'string') {
    return null
  }
  const contextLines = []
  const activeFile = context && typeof context.activeFile === 'string' ? context.activeFile : ''
  if (activeFile) contextLines.push('当前用户打开/关注的页面（或文件）：' + activeFile)
  if (context && typeof context.currentRoutePath === 'string' && context.currentRoutePath) {
    contextLines.push('当前路由路径：' + context.currentRoutePath)
  }
  const contextBlock = contextLines.length ? '\n上下文：\n' + contextLines.join('\n') + '\n' : ''
  return [
    '【用户之前说】',
    replyTo.originalMessage.trim(),
    '',
    '【助手追问】',
    replyTo.clarificationQuestion.trim(),
    '',
    '【用户补充】',
    (raw || '').trim(),
    contextBlock
  ].join('\n')
}

/**
 * 轻量意图分类：在「思维引擎」输出 thought 之后，再补充 taskKind / targetGranularity，
 * 便于后续路由与规划更有针对性（例如简单样式微调 / 数据 Bug / 逻辑修改 / 新特性等）。
 */
async function classifyIntent (raw, thought, context = {}) {
  const text = (raw || '').trim()
  if (!text) return null
  // 若规则已明确 fromRule，可直接用启发式推断，避免额外模型调用
  const fromRule = thought && typeof thought.fromRule === 'string' ? thought.fromRule : ''
  if (fromRule) {
    if (/style|button_color|card_height|tag_spacing|toolbar_card_spacing|title_fontsize|title_center|hover_show_full|text_ellipsis/.test(fromRule)) {
      return { taskKind: 'style_tweak', targetGranularity: 'section', confidence: 0.9 }
    }
    if (/page_blank_bug|command_market_stock_name_bug/.test(fromRule)) {
      return { taskKind: 'data_bug', targetGranularity: 'page', confidence: 0.9 }
    }
    if (/pagination|search_filter|form_validation|export|inline_edit|select_all|clear_reset|button_prevent_double|confirm_before_danger/.test(fromRule)) {
      return { taskKind: 'logic_change', targetGranularity: 'section', confidence: 0.85 }
    }
    return { taskKind: 'other', targetGranularity: 'page', confidence: 0.6 }
  }

  // 无 fromRule 时，调用 DeepSeek 做一次轻量分类
  try {
    const systemPrompt = [
      '你是一个「意图分类器」，负责根据一条用户自然语言指令判断任务类型。',
      '只输出 JSON，不要任何解释。',
      '',
      'taskKind 取值（必选其一）：',
      '- "style_tweak"：纯样式/视觉/排版调整（颜色、间距、对齐、圆角、阴影、字体等，不涉及业务逻辑）。',
      '- "layout_tweak"：布局结构/栅格/模块位置调整（如卡片布局、响应式列数），可能需轻微改 template。',
      '- "data_bug"：数据展示错误/字段映射问题（如名称错、接口值不对、统计数字异常）。',
      '- "logic_change"：交互或业务逻辑修改（点击行为、校验、分页、搜索、导出逻辑等）。',
      '- "new_feature"：明显新增一块功能或页面（如「新增一个报告页」「加一个导出功能」）。',
      '- "explain_code"：用户只是让你解释代码/日志/报错，不改代码。',
      '- "other"：不属于以上任一类。',
      '',
      'targetGranularity 取值：',
      '- "page"：整页级别修改。',
      '- "section"：页面中的某个区域/模块（如卡片列表、工具栏、表格区域、侧边栏）。',
      '- "component"：独立组件或复用块。',
      '- "line_level"：极小粒度（几行代码/一个语句级别）。',
      '',
      'confidence：0~1 的数字，表示你对 taskKind 判断的把握程度。',
      '只输出一个 JSON：{ "taskKind": "...", "targetGranularity": "...", "confidence": 0.xx }'
    ].join('\n')
    const userPrompt = JSON.stringify({
      message: text,
      activeFile: context && context.activeFile,
      currentRoutePath: context && context.currentRoutePath,
      refinedInstruction: thought && thought.refinedInstruction
    })
    const data = await callDeepseekJson(systemPrompt, userPrompt)
    if (!data || typeof data !== 'object') return null
    const taskKind = typeof data.taskKind === 'string' ? data.taskKind : 'other'
    const targetGranularity = typeof data.targetGranularity === 'string' ? data.targetGranularity : 'page'
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0.5
    return { taskKind, targetGranularity, confidence }
  } catch (e) {
    return null
  }
}

/**
 * 第二层「模糊意图解析」：
 * 当第一层思维引擎判断 needsClarification=true 时，再调用一次 DeepSeek，
 * 结合 baseThought 与上下文，尽量自己猜出一个可执行的 refinedInstruction，
 * 只有真的无法安全判断时才坚持澄清。
 */
async function resolveAmbiguousWithLLM (raw, baseThought, context = {}) {
  const text = (raw || '').trim()
  if (!text || !baseThought || baseThought.needsClarification !== true) return null

  try {
    const systemPrompt = [
      '你是源码编辑助手的「意图解码器」。',
      '场景：第一层思维引擎觉得当前用户说法有点模糊，标记了 needsClarification=true。',
      '你的任务是：在不乱改项目的前提下，结合 baseThought 与上下文，尽量自己推断出一个可执行的 refinedInstruction，减少向用户追问。',
      '',
      '要求：',
      '1）可以合理「大胆猜测」，前提是不进行大范围或破坏性的修改（例如只改样式、小范围布局、单个文案/数字）。',
      '2）若能给出明确、范围小的修改指令，则返回 needClarification=false，并给出 guessedInstruction / intentSummary / intentKind。',
      '3）若多种解释之间差异极大，且任何一种改动都可能误删/重写整页或重要逻辑，则保持 needClarification=true，并给出更具体、聚焦的问题。',
      '4）优先将此类任务归为 style_tweak 或 layout_tweak，除非明显是数据或逻辑错误。',
      '',
      '只输出一个 JSON 对象，不要附加解释或 Markdown。字段：',
      '{',
      '  "resolved": true/false,              // 是否已给出自己的判断',
      '  "needClarification": true/false,    // 是否仍然需要向用户澄清',
      '  "guessedInstruction": "string",     // 若 resolved 且无需澄清：你认为可以直接执行的 refinedInstruction，自然语言中文',
      '  "intentSummary": "string",          // 对用户真实需求的简要总结',
      '  "intentKind": "style_tweak|layout_tweak|data_bug|logic_change|new_feature|other",',
      '  "targetHints": ["..."],             // 可选：你认为要改的页面/区域提示，如某个 .vue 文件名、class 名',
      '  "confidence": 0.0 ~ 1.0,            // 你对 guessedInstruction 的把握程度',
      '  "clarificationQuestion": "string"   // 若仍需澄清：一条更具体、单点聚焦的问题',
      '}'
    ].join('\n')

    const semanticViews = context && context.semantic && Array.isArray(context.semantic.views)
      ? context.semantic.views.slice(0, 16).map(v => ({
          file: v.file,
          name: v.name,
          routeTitle: v.routeTitle,
          menuTitle: v.menuTitle,
          semanticText: v.semanticText
        }))
      : []

    const userPayload = {
      message: text,
      baseThought,
      context: {
        activeFile: context && context.activeFile,
        preferredFile: context && context.preferredFile,
        currentRoutePath: context && context.currentRoutePath,
        semanticViews
      }
    }

    const data = await callDeepseekJson(systemPrompt, JSON.stringify(userPayload))
    if (!data || typeof data !== 'object') return null
    if (data.resolved !== true) return null

    const confidence = typeof data.confidence === 'number' ? data.confidence : 0.5
    const needClarification = data.needClarification === true
    return {
      resolved: true,
      needClarification,
      confidence,
      guessedInstruction: typeof data.guessedInstruction === 'string' ? data.guessedInstruction.trim() : '',
      intentSummary: typeof data.intentSummary === 'string' ? data.intentSummary.trim() : '',
      intentKind: typeof data.intentKind === 'string' ? data.intentKind : '',
      targetHints: Array.isArray(data.targetHints) ? data.targetHints : [],
      clarificationQuestion: typeof data.clarificationQuestion === 'string' ? data.clarificationQuestion.trim() : ''
    }
  } catch (e) {
    return null
  }
}

async function think (message, context = {}) {
  const raw = (message || '').trim()
  if (!raw) {
    return {
      intentSummary: '',
      doNot: [],
      target: '',
      refinedInstruction: '',
      rawMessage: raw,
      needsClarification: false
    }
  }

  const replyPrompt = buildUserPromptForThink(raw, context)
  const isReplyToClarification = !!replyPrompt

  // 规则匹配时：若是对上一轮澄清的补充，则用「原话 + 补充」一起喂给规则，确保像
  // 「指令市场页面太丑」「就好看一点就行」这类多轮说法也能一次性理解，不再反复追问
  const replyTo = context && context.replyToClarification
  const ruleText = (replyTo && typeof replyTo.originalMessage === 'string')
    ? [replyTo.originalMessage, raw].join('\n')
    : raw

  const rule = ruleBasedThink(ruleText)
  if (rule) {
    const base = Object.assign({ needsClarification: false }, rule)
    const intent = await classifyIntent(raw, base, context)
    return intent ? Object.assign(base, {
      taskKind: intent.taskKind,
      targetGranularity: intent.targetGranularity,
      intentConfidence: intent.confidence
    }) : base
  }

  // 上下文增强规则：短句「太高了、矮一点」「卡片高度矮一点」类，在当前活跃视图为 CommandMarket 时，推断为卡片高度调整（仅非「追问补充」时）
  const activeFile = context && typeof context.activeFile === 'string' ? context.activeFile : ''
  const isShortHeightComment = !isReplyToClarification &&
    ((/太高/.test(raw) && /矮/.test(raw)) || // 太高了，矮一点
    /(指令市场|CommandMarket|卡片).*高度.*(矮|低|小|短|再矮|再低)/.test(raw) ||
    /(高度).*(矮|低|小|短|再矮|再低).*(卡片)/.test(raw))
  if (isShortHeightComment && activeFile && activeFile.includes('CommandMarket.vue')) {
    return Object.assign({
      needsClarification: false
    }, {
      intentSummary: '用户觉得当前页面的指令卡片高度太高，想整体降低一点',
      doNot: ['不要改副标题或标题', '不要生成新页面', '不要修改业务逻辑或模板结构'],
      target: '指令市场页面卡片高度（.command-card 的 min-height）',
      refinedInstruction: '将指令市场页面（src/views/CommandMarket.vue）中的指令卡片整体高度调低一些，例如通过减小 .command-card 的 min-height，仅修改 <style> 中与卡片高度相关的样式，不改 template 和业务逻辑。',
      rawMessage: raw,
      fromRule: 'card_height_context'
    })
  }

  const { systemPrompt, userPrompt } = buildThinkPrompts(raw, context)
  let data
  try {
    const fullText = await callDeepseekText(systemPrompt, userPrompt)
    const jsonStr = fullText && fullText.includes(THINK_STREAM_SEP)
      ? fullText.split(THINK_STREAM_SEP)[1].trim()
      : (fullText || '').trim()
    data = (() => {
      try {
        const s = jsonStr.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
        return s ? JSON.parse(s) : null
      } catch (e) {
        return null
      }
    })()
  } catch (e) {
    return {
      intentSummary: raw,
      doNot: [],
      target: '',
      refinedInstruction: raw,
      rawMessage: raw,
      fromRule: false,
      needsClarification: false,
      error: e.message
    }
  }
  let baseThought = normalizeThought(data, raw)

  // 若第一层思维引擎觉得需要澄清，再走一层「模糊意图解析」，尽量自己猜出可执行指令，减少向用户追问
  if (baseThought.needsClarification) {
    const resolved = await resolveAmbiguousWithLLM(raw, baseThought, context)
    if (resolved && resolved.resolved) {
      if (!resolved.needClarification && resolved.confidence >= 0.6 && resolved.guessedInstruction) {
        baseThought = Object.assign({}, baseThought, {
          needsClarification: false,
          intentSummary: resolved.intentSummary || baseThought.intentSummary || raw,
          refinedInstruction: resolved.guessedInstruction || baseThought.refinedInstruction || raw,
          fromResolver: true,
          resolverConfidence: resolved.confidence,
          resolverTargetHints: resolved.targetHints || []
        })
      } else if (resolved.clarificationQuestion) {
        baseThought = Object.assign({}, baseThought, {
          clarificationQuestion: resolved.clarificationQuestion,
          resolverConfidence: resolved.confidence
        })
      }
    }
  }

  const intent = await classifyIntent(raw, baseThought, context)
  return intent ? Object.assign(baseThought, {
    taskKind: intent.taskKind,
    targetGranularity: intent.targetGranularity,
    intentConfidence: intent.confidence
  }) : baseThought
}

const THINK_STREAM_SEP = '\n---JSON---\n'

/** 构建思维引擎的 system / user 提示（与 think/thinkStream 共用） */
function buildThinkPrompts (raw, context) {
  const systemPrompt = [
    '你是一个「思维引擎」，像 Cursor 一样：先想清楚用户最终要什么，再拆成最小步骤；能一步完成就只做一步，不要扩大范围。请按下面两步输出。',
    '',
    '【第一步】先写出你的思考过程（像和同事对话一样，用自然段，3～8 句话）：',
    '1) 设身处地：用户当前在哪个页面、在做什么？',
    '2) 用户真正要的是什么？是「只改一个数/一处配置」还是「改文案/改样式/改逻辑/新增页面」？若只是改数量、改数字（如从4个改成8个），则结论必须是：只改那一处数字，不要动整页、不要重写代码。',
    '3) 列举可能：有哪 2～3 种合理解释？缺不缺关键信息？缺则设 needsClarification 为 true，不要猜。',
    '4) 下结论：为何「明确」或「需要澄清」；若明确，refinedInstruction 要写清「只做哪一件事」（例如：仅将控制卡片数量的数字从 4 改为 8，其他不改）。',
    '重要：若用户提到「详情页」「指令市场详情页」「指令详情页面」等，target 与 refinedInstruction 里必须保留「详情页」或「指令详情页面」，不能写成「指令市场页面」或「列表页」，否则会改错页面。',
    '写完后换行，然后单独一行写：---JSON---',
    '再换行后写【第二步】一个 JSON 对象（不要 markdown 包裹），字段：',
    '- needsClarification：布尔。',
    '- clarificationQuestion：字符串（仅 needsClarification 为 true 时必填）。',
    '- intentSummary：字符串（仅 false 时必填）。',
    '- doNot：字符串数组（仅 false 时必填；若用户只是改数字/数量，必须包含「不要重写整页」「不要改其他代码」）。',
    '- target：字符串（仅 false 时必填；若用户说的是详情页，必须写「指令详情页面」或「CommandDetail」，不要写指令市场列表）。',
    '- refinedInstruction：字符串（仅 false 时必填；若只是改数量，写清「仅将…从 X 改为 Y，其他不变」；若用户说的是详情页，必须保留「详情页」表述）。'
  ].join('\n')
  const replyPrompt = buildUserPromptForThink(raw, context)
  const activeFile = context && typeof context.activeFile === 'string' ? context.activeFile : ''
  const contextLines = []
  if (activeFile) contextLines.push('当前用户打开/关注的页面（或文件）：' + activeFile)
  if (context && typeof context.currentRoutePath === 'string' && context.currentRoutePath) {
    contextLines.push('当前路由路径：' + context.currentRoutePath)
  }
  const contextBlock = contextLines.length ? '\n上下文：\n' + contextLines.join('\n') + '\n' : ''
  const userPrompt = replyPrompt
    ? ('用户原话（多轮对话）：\n' + replyPrompt)
    : ('用户原话：\n' + raw + contextBlock)
  return { systemPrompt, userPrompt }
}

/** 将模型输出的 data 规范为统一的 thought 结构 */
function normalizeThought (data, raw) {
  if (!data || typeof data !== 'object') {
    return {
      intentSummary: raw,
      doNot: [],
      target: '',
      refinedInstruction: raw,
      rawMessage: raw,
      needsClarification: false
    }
  }
  const needsClarification = data.needsClarification === true || data.needsClarification === 'true'
  const reasoning = typeof data.reasoning === 'string' ? data.reasoning.trim() : ''
  const clarificationQuestion = typeof data.clarificationQuestion === 'string' ? data.clarificationQuestion.trim() : ''
  if (needsClarification) {
    return {
      intentSummary: '',
      doNot: [],
      target: '',
      refinedInstruction: raw,
      rawMessage: raw,
      fromRule: false,
      needsClarification: true,
      reasoning: reasoning || '您的描述可能有多种理解，需要先确认再执行。',
      clarificationQuestion: clarificationQuestion || '能否再具体说一下您想改的是哪一块、或哪个页面？'
    }
  }
  const doNot = Array.isArray(data.doNot) ? data.doNot : (data.doNot ? [data.doNot] : [])
  return {
    intentSummary: typeof data.intentSummary === 'string' ? data.intentSummary.trim() : raw,
    doNot,
    target: typeof data.target === 'string' ? data.target.trim() : '',
    refinedInstruction: typeof data.refinedInstruction === 'string' ? data.refinedInstruction.trim() : raw,
    rawMessage: raw,
    fromRule: false,
    needsClarification: false,
    reasoning: reasoning || undefined
  }
}

/**
 * 流式思维：边推流思考过程边产出最终 thought（onChunk 每收到一块就回调，用于前端实时展示）
 */
async function thinkStream (message, context = {}, options = {}) {
  const raw = (message || '').trim()
  if (!raw) {
    return {
      intentSummary: '',
      doNot: [],
      target: '',
      refinedInstruction: '',
      rawMessage: raw,
      needsClarification: false
    }
  }
  const replyPrompt = buildUserPromptForThink(raw, context)
  const isReplyToClarification = !!replyPrompt

  const replyTo = context && context.replyToClarification
  const ruleText = (replyTo && typeof replyTo.originalMessage === 'string')
    ? [replyTo.originalMessage, raw].join('\n')
    : raw

  const rule = ruleBasedThink(ruleText)
  if (rule) {
    const base = Object.assign({ needsClarification: false }, rule)
    const intent = await classifyIntent(raw, base, context)
    return intent ? Object.assign(base, {
      taskKind: intent.taskKind,
      targetGranularity: intent.targetGranularity,
      intentConfidence: intent.confidence
    }) : base
  }
  const activeFile = context && typeof context.activeFile === 'string' ? context.activeFile : ''
  const isShortHeightComment = !isReplyToClarification &&
    ((/太高/.test(raw) && /矮/.test(raw)) ||
    /(指令市场|CommandMarket|卡片).*高度.*(矮|低|小|短|再矮|再低)/.test(raw) ||
    /(高度).*(矮|低|小|短|再矮|再低).*(卡片)/.test(raw))
  if (isShortHeightComment && activeFile && activeFile.includes('CommandMarket.vue')) {
    return Object.assign({
      needsClarification: false
    }, {
      intentSummary: '用户觉得当前页面的指令卡片高度太高，想整体降低一点',
      doNot: ['不要改副标题或标题', '不要生成新页面', '不要修改业务逻辑或模板结构'],
      target: '指令市场页面卡片高度（.command-card 的 min-height）',
      refinedInstruction: '将指令市场页面（src/views/CommandMarket.vue）中的指令卡片整体高度调低一些，例如通过减小 .command-card 的 min-height，仅修改 <style> 中与卡片高度相关的样式，不改 template 和业务逻辑。',
      rawMessage: raw,
      fromRule: 'card_height_context'
    })
  }
  const { systemPrompt, userPrompt } = buildThinkPrompts(raw, context)
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : () => {}
  let data
  try {
    data = await callDeepseekStreamJsonReasoningFirst(systemPrompt, userPrompt, onChunk)
  } catch (e) {
    return {
      intentSummary: raw,
      doNot: [],
      target: '',
      refinedInstruction: raw,
      rawMessage: raw,
      fromRule: false,
      needsClarification: false,
      error: e.message
    }
  }
  const baseThought = normalizeThought(data, raw)
  const intent = await classifyIntent(raw, baseThought, context)
  return intent ? Object.assign(baseThought, {
    taskKind: intent.taskKind,
    targetGranularity: intent.targetGranularity,
    intentConfidence: intent.confidence
  }) : baseThought
}

/**
 * 满足性判断：根据用户最初需求和已完成步骤，判断是否已满足；若不满足则给出下一步指令（供 agent 循环使用）
 * @param {string} originalMessage - 用户最初说的话
 * @param {Array<{ round: number, planSummary: string, applySummary: string, actionDescriptions?: string[] }>} completedSteps - 已执行的轮次与摘要
 * @param {object} context - 可选上下文
 * @returns {Promise<{ satisfied: boolean, summary?: string, nextInstruction?: string, reasoning?: string }>}
 */
async function thinkSatisfied (originalMessage, completedSteps = [], context = {}) {
  const userSay = (originalMessage || '').trim()
  const stepsText = (completedSteps || []).length === 0
    ? '（尚未执行任何改动）'
    : completedSteps.map((s, i) => `第${i + 1}轮：${s.planSummary || ''}；${s.applySummary || ''}`).join('\n')

  const systemPrompt = [
    '你是「满足性判断」模块。根据用户最初的需求描述和已经执行过的步骤，判断：用户的需求是否已经完全满足。',
    '',
    '重要约束：',
    '1）你看不到真实浏览器画面，只能根据「已经执行的技术步骤」和补充的上下文(contextJson)来判断是否满足，不能要求再去“人工检查一下效果”。',
    '2）如果已经针对用户说的页面/文件做过一次明确的样式或结构修改（例如「把某页改成红色风格」「Tab 选中改成红色背景」「标题排版不好看」），且 contextJson.lastChanged 中包含对应文件，通常就可以认为已满足，不要再给出类似「检查并确认是否完全应用」「再确认一下效果」这类下一步。',
    '3）严禁把下一步写成纯检查类指令（例如「检查并确认…是否完全应用」「验证页面是否符合红色风格」），这类情况下一律视为 satisfied=true，并用 summary 简要描述已完成的改动。',
    '4）只有当从已完成步骤和 contextJson 里能明显看出「还缺一块很具体的实现」时，才给出 nextInstruction（例如：用户要「分页 + 搜索」，而目前只做了分页，这种可以给出「再为列表加搜索输入框和过滤逻辑」）。',
    '5）若 contextJson.lastThought 的 taskKind 为 "style_tweak"，且最近一轮 lastChanged 的修改类型是 CSS-only（由调用方保证），优先认为样式需求已基本满足；除非用户原话明确包含多个未覆盖的样式子需求。',
    '',
    '若已满足：返回 satisfied 为 true，并写一句 summary 总结完成了什么。',
    '若未满足：返回 satisfied 为 false，并写 nextInstruction（下一步要做的、一条清晰的技术指令，给规划器用，例如「在指令市场页给卡片列表加分页，每页 8 条」）。',
    '只输出一个 JSON 对象，不要 markdown。字段：satisfied（布尔）、summary（字符串，satisfied 为 true 时必填）、nextInstruction（字符串，satisfied 为 false 时必填）、reasoning（可选，一句话说明为何满足或为何还需一步）。'
  ].join('\n')

  const userPrompt = [
    '用户最初说：',
    userSay || '（无）',
    '',
    '已完成的步骤：',
    stepsText,
    '',
    '补充上下文（JSON，仅供参考）：',
    JSON.stringify(context || {}, null, 2),
    '',
    '请判断需求是否已满足，并按要求输出 JSON。'
  ].join('\n')

  let data
  try {
    data = await callDeepseekJson(systemPrompt, userPrompt)
  } catch (e) {
    return {
      satisfied: true,
      summary: '判断超时或失败，按已满足结束本轮。',
      reasoning: e.message
    }
  }

  if (!data || typeof data !== 'object') {
    return { satisfied: true, summary: '无法解析判断结果，按已满足结束。' }
  }

  const satisfied = data.satisfied === true || data.satisfied === 'true'
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  const nextInstruction = typeof data.nextInstruction === 'string' ? data.nextInstruction.trim() : ''
  const reasoning = typeof data.reasoning === 'string' ? data.reasoning.trim() : ''

  return {
    satisfied,
    summary: summary || undefined,
    nextInstruction: nextInstruction || undefined,
    reasoning: reasoning || undefined
  }
}

module.exports = {
  think,
  thinkStream,
  thinkSatisfied,
  ruleBasedThink
}
