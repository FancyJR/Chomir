/**
 * 规划器（planner）
 *
 * 职责：
 * - 将「自然语言指令 + 项目信息」转换为结构化的 actions 计划
 *   例如：add_view / modify_view
 * - 部分高频场景（比如优化指令市场样式）优先用本地规则生成 actions，避免额外的大模型调用
 * - 内置能力：换描述/改文案/副标题 → 直接产出「相同语义换一种说法、仅改 .page-subtitle」的 modify_view（见 isChangeTextIntent）
 */

const path = require('path')
const { callDeepseekJson } = require('./shared-llm')

/**
 * 意图→目标打分：根据用户原话在「视图 + 菜单容器」上算匹配度，避免同名菜单项与页面视图混淆
 * @param {string} userMessage - 用户原话（或原话+instruction 拼接）
 * @param {object} projectInfo - 含 views、semantic.views、semantic.menuContainers
 * @returns {{ intentType: string, bestFile: string, bestScore: number, scores: Array<{ file, score, source }> }}
 */
function scoreIntentTarget (userMessage, projectInfo) {
  const msg = (userMessage || '').trim().toLowerCase()
  const result = { intentType: 'unknown', bestFile: '', bestScore: -1, scores: [] }

  const views = Array.isArray(projectInfo && projectInfo.views) ? projectInfo.views : []
  const semanticViews = Array.isArray(projectInfo && projectInfo.semantic && projectInfo.semantic.views) ? projectInfo.semantic.views : []
  const menuContainers = Array.isArray(projectInfo && projectInfo.semantic && projectInfo.semantic.menuContainers) ? projectInfo.semantic.menuContainers : []

  // 1) 意图分类（基于关键词，不打 LLM）
  const hasMenuIntent = /(左侧菜单|左边菜单|菜单|导航|侧栏|侧边|顶栏|sidebar|nav|el-menu)/.test(msg) && /(没有logo|没有图标|加logo|加图标|加上logo|图标)/.test(msg)
  const hasDialogIntent = /弹窗|dialog|编辑指令弹窗|编辑弹窗|新建.*弹窗/.test(msg)
  const hasPageStyleIntent = /(样式|颜色|布局|间距|美观|优化|美化|主题|红色|蓝色)/.test(msg) && /(页面|仪表盘|指令市场|期货|表格|弹窗)/.test(msg)
  const hasPageContentIntent = /(加.*图表|加.*仪表盘|太空|文字描述|内容)/.test(msg) && /(页面|仪表盘|首页)/.test(msg)
  const hasDetailIntent = /(详情|详情页|detail)/.test(msg)
  const hasNewPageIntent = /新(建|增)|写\s*一个|做\s*一个/.test(msg) && /页面|视图/.test(msg)

  if (hasMenuIntent) result.intentType = 'menu_item_modify'
  else if (hasNewPageIntent) result.intentType = 'new_page'
  else if (hasDialogIntent) result.intentType = 'dialog_style'
  else if (hasDetailIntent) result.intentType = 'page_detail'
  else if (hasPageStyleIntent) result.intentType = 'page_style'
  else if (hasPageContentIntent) result.intentType = 'page_content'
  else result.intentType = 'page_or_generic'

  // 2) 菜单项名与视图名映射（用于对「同名视图」降权，避免菜单意图误选视图）
  const menuItemNameToViewBase = {
    '今日股票推荐': 'todaystockrecommendation',
    '今日股票': 'todaystockrecommendation',
    '指令市场': 'commandmarket',
    '仪表盘': 'dashboard',
    '期货预测': 'futuresprediction',
    '表格页': 'tablepage',
    '无代码开发': 'nocodebuilder',
    '指令详情': 'commanddetail'
  }
  let mentionedMenuName = null
  for (const [name, base] of Object.entries(menuItemNameToViewBase)) {
    if (msg.includes(name.toLowerCase()) || msg.includes(name)) {
      mentionedMenuName = base
      break
    }
  }

  // 3) 对每个候选目标打分
  const scoreMap = new Map()

  // 菜单容器
  for (const m of menuContainers) {
    const file = m.file || ''
    if (!file) continue
    let s = 0
    if (result.intentType === 'menu_item_modify') s += 100
    if (/menu|导航|el-menu|layout|app\.vue/i.test(m.semanticText || '')) s += 20
    if (!scoreMap.has(file) || scoreMap.get(file).score < s) {
      scoreMap.set(file, { file, score: s, source: 'menuContainers' })
    }
  }

  // 视图：菜单意图下对「与菜单项同名的视图」降权
  const viewList = semanticViews.length ? semanticViews : views
  for (const v of viewList) {
    const file = (v.file || '').trim()
    if (!file || !file.endsWith('.vue')) continue
    const base = path.basename(file, '.vue').toLowerCase()
    const semanticText = (v.semanticText || v.name || v.file || '').toLowerCase()
    let s = 0
    if (result.intentType === 'menu_item_modify' && mentionedMenuName && base === mentionedMenuName) {
      s -= 80
    }
    if (result.intentType === 'dialog_style') {
      if (v.hasDialog) s += 45
      if (/编辑指令弹窗|编辑弹窗|指令市场.*弹窗/.test(msg) && base === 'commandmarket') s += 55
      if (msg.includes('详情') && base.includes('detail')) s -= 30
    }
    if (result.intentType === 'page_style' || result.intentType === 'page_content' || result.intentType === 'page_or_generic') {
      if (msg.includes('仪表盘') && (base === 'dashboard' || /仪表盘|首页/.test(semanticText))) s += 50
      if (msg.includes('指令市场') && !msg.includes('弹窗') && (base === 'commandmarket' || /指令市场/.test(semanticText))) s += 50
      if (msg.includes('期货') && (base.includes('futures') || /期货/.test(semanticText))) s += 50
      if (msg.includes('今日股票') && base.includes('stock')) s += 40
      if (msg.includes('详情') && base.includes('detail')) s += 50
    }
    if (result.intentType === 'page_detail' && (base.includes('detail') || /详情/.test(semanticText))) s += 60
    if (semanticText && msg.length > 2) {
      const words = msg.replace(/\s+/g, ' ').split(' ').filter(w => w.length > 1)
      for (const w of words) {
        if (semanticText.includes(w)) s += 5
      }
    }
    const prev = scoreMap.get(file)
    if (!prev || prev.score < s) scoreMap.set(file, { file, score: s, source: 'views' })
  }

  const scores = Array.from(scoreMap.values()).filter(x => x.file)
  if (scores.length === 0) return result
  const best = scores.reduce((a, b) => (a.score >= b.score ? a : b))
  result.bestFile = best.file
  result.bestScore = best.score
  result.scores = scores
  return result
}

// 新页面意图：统一识别「新建/新增/写一个/做一个 XXX 页面」这类需求，后续用于：
// 1）在 ruleBasedPlan 中让出给 LLM 规划 add_view；
// 2）在 plan() 中对 LLM 返回的 actions 做硬约束与过滤，避免新页面需求误伤 CommandMarket 等业务页。
const newPageIntentRe = /新(建|增)?\s*(一个)?\s*页面|新(建|增).*页(面)?|新增\s*视图|新建\s*视图|写\s*(一个|个)?\s*[\u4e00-\u9fa5A-Za-z0-9_-]*页(面)?|做\s*(一个|个)?\s*[\u4e00-\u9fa5A-Za-z0-9_-]*页(面)?/

/**
 * 语义选页器：基于 analyzer 构建的 projectInfo.semantic.views + 用户话术，
 * 调用 DeepSeek 做一轮最近邻视图选择，返回最可能相关的 .vue 文件列表。
 *
 * 设计原则：
 * - 不替代现有规则与 activeFile/currentRoutePath 逻辑，只在规则无法锁定时提供「候选视图集合」；
 * - LLM 只负责在 views 之间做语义打分，输出 file 列表，planner 再基于这些 file 生成 actions；
 * - 若解析失败或模型异常，直接返回 null，保持原有行为。
 */
async function semanticPickViews (instruction, projectInfo, context = {}) {
  const semantic = projectInfo && projectInfo.semantic
  const views = semantic && Array.isArray(semantic.views) ? semantic.views : null
  if (!views || !views.length) return null

  const originalMessage = (context && typeof context.originalMessage === 'string' ? context.originalMessage : '').trim()
  const thought = context && typeof context.thought === 'object' ? context.thought : null
  const refinedFromThought = thought && typeof thought.refinedInstruction === 'string'
    ? thought.refinedInstruction.trim()
    : ''

  const textPieces = [originalMessage, instruction, refinedFromThought].filter(Boolean)
  if (!textPieces.length) return null
  const combinedText = textPieces.join('\n')

  const systemPrompt = [
    '你是一个「语义视图选择器」（semantic picker），职责是：',
    '在一个 Vue2 + ElementUI 项目中，根据「用户话术」在给定的视图列表里选择 1～3 个最相关的页面。',
    '',
    '输入：',
    '- userText：用户原话与经过思维引擎精炼后的指令拼接在一起（可能多行）。',
    '- views：由 analyzer 构建的项目语义地图，每个元素包含 { name, file, routePath, routeTitle, menuTitle, semanticText }：',
    '  - name：组件名，例如 FuturesPrediction；',
    '  - file：视图文件路径，例如 src/views/FuturesPrediction.vue；',
    '  - routePath：路由 path，例如 /futures-prediction；',
    '  - routeTitle：路由 meta.title，例如「期货预测」；',
    '  - menuTitle：左侧菜单文案，例如「期货预测」；',
    '  - semanticText：以上字段拼接后的字符串，用于语义匹配。',
    '',
    '任务：',
    '1. 只在 views 列表里做语义最近邻匹配，不要虚构不存在的文件；',
    '2. 结合 userText 与每个视图的 semanticText，从语义上判断哪些页面「最像」用户描述的页面；',
    '3. 最多返回 3 个候选，按照相关度从高到低排序；',
    '4. 若所有视图都几乎无关，可以返回空数组 files: []；',
    '5. 典型示例：',
    '   - 当 userText 包含「期货预测页面空白了」「点击左侧期货预测菜单，右侧什么都没有」等时，',
    '     若某个视图的 file/routeTitle/menuTitle/semanticText 里包含「FuturesPrediction」或「期货预测」，',
    '     则它应当排在第一位，例如 src/views/FuturesPrediction.vue；',
    '   - 当 userText 包含「指令市场详情页」「指令详情页面」时，',
    '     若存在 CommandDetail/GeneratedDetail 这类详情视图，应优先返回这些详情视图，而不是列表页。',
    '',
    '输出：只返回一个 JSON 对象，不要加 ``` 包裹，字段为：',
    '{',
    '  "files": string[]  // 0～3 个 .vue 文件路径，按相关度排序，例如 ["src/views/FuturesPrediction.vue"]',
    '}'
  ].join('\n')

  const userPrompt = JSON.stringify({
    userText: combinedText,
    views
  })

  let data
  try {
    data = await callDeepseekJson(systemPrompt, userPrompt)
  } catch (e) {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const files = Array.isArray(data.files) ? data.files.filter(f => typeof f === 'string' && f.endsWith('.vue')) : []
  if (!files.length) return null
  return { files }
}

// 规则优先：对常见简单场景直接生成 actions，避免每次都请求 LLM
function ruleBasedPlan (instruction, projectInfo, context = {}) {
  const text = (instruction || '').trim()
  if (!text) return null

  // 目标文件解析原则：用户意图优先（本句提到的页面名），上下文仅辅助（当前打开页/上一轮目标）；不能因为上下文有某页就默认改那页
  const activeFile = context && typeof context.activeFile === 'string' ? context.activeFile : ''
  const preferredFile = context && typeof context.preferredFile === 'string' ? context.preferredFile.trim() : ''
  const originalMessage = (context && typeof context.originalMessage === 'string' ? context.originalMessage : '').trim()
  const currentRoutePath = (context && typeof context.currentRoutePath === 'string' ? context.currentRoutePath : '').trim()
  const textForTarget = [text, originalMessage].filter(Boolean).join(' ')
  const hasPageHint = /指令市场|详情|页面|列表|首页|登录|注册|仪表盘|home|login|detail/.test(textForTarget)

  let defaultFile = ''
  const views = Array.isArray(projectInfo && projectInfo.views) ? projectInfo.views : []
  const thought = context && context.thought
  const combinedMsg = [originalMessage, text].filter(Boolean).join(' ')
  const menuContainers = Array.isArray(projectInfo && projectInfo.semantic && projectInfo.semantic.menuContainers) ? projectInfo.semantic.menuContainers : []

  // 【意图→目标打分】先跑一遍匹配度算法，得到意图类型 + 最佳目标文件，再与规则结合
  const scored = scoreIntentTarget(combinedMsg, projectInfo)
  const intentType = scored.intentType
  const bestScoredFile = scored.bestFile
  const bestScore = scored.bestScore

  // 【最高优先】菜单项加 logo/图标：用打分结果或规则判，目标必须是菜单所在文件，同名视图被降权
  const hasMenuKeyword = /(左侧菜单|左边菜单|菜单|导航|侧栏|侧边|顶栏|sidebar|nav|el-menu)/.test(combinedMsg)
  const hasLogoKeyword = /(没有logo|没有图标|缺.*图标|加logo|加图标|加上logo|加上图标)/.test(combinedMsg)
  const isMenuIconIntent = thought && (thought.fromRule === 'menu_item_icon' || thought.fromRule === 'menu_item_icon_short')
  if (intentType === 'menu_item_modify' && bestScoredFile && menuContainers.some(m => m.file === bestScoredFile)) {
    defaultFile = bestScoredFile
  } else if (isMenuIconIntent || (hasMenuKeyword && hasLogoKeyword)) {
    defaultFile = menuContainers.length > 0 ? menuContainers[0].file : 'src/App.vue'
  }

  // 页面类 / 弹窗类意图：当用户话里「明确提到页面名/页面类词」（hasPageHint 为 true）时，
  // 才允许用打分结果覆盖默认目标；若用户只说「卡片/标题/描述」等而没说页面名，则优先用上下文（preferredFile/activeFile），避免误跳到无关页面
  if (!defaultFile && hasPageHint && (intentType === 'page_style' || intentType === 'page_content' || intentType === 'page_or_generic' || intentType === 'page_detail' || intentType === 'dialog_style') && bestScoredFile && bestScore >= 30) {
    defaultFile = bestScoredFile
  }

  // 通用「改哪里」：从用户原话解析要改的页面/视图（仅当未命中「菜单项」意图且打分未给出高置信目标时）
  if (!defaultFile) {
    function resolveTargetFromMessage (msg) {
      if (!msg || !views.length) return ''
      const t = (msg || '').trim()
      if (!t) return ''
      for (const v of views) {
        const base = path.basename((v.file || ''), '.vue').toLowerCase()
        if (base === 'commandmarket' && /指令市场|应用市场|command\s*market/i.test(t)) return v.file
        if (base === 'commanddetail' && /指令详情|详情页|详情页面|command\s*detail/i.test(t)) return v.file
        if ((base === 'futuresprediction' || /futures|期货/.test(base)) && /期货|期货预测|futures/i.test(t)) return v.file
        if (base === 'dashboard' && /仪表盘|首页|总览|dashboard/i.test(t)) return v.file
        if (base === 'nocodebuilder' && /无代码|低代码|可视化搭建|页面生成|no\s*code/i.test(t)) return v.file
        if (base === 'todaystockrecommendation' && /今日股票|股票推荐|stock\s*recommend/i.test(t)) return v.file
        if (base === 'tablepage' && /表格页|table\s*page/i.test(t)) return v.file
      }
      return ''
    }
    const explicitPageFile = resolveTargetFromMessage(originalMessage) || resolveTargetFromMessage(textForTarget)
    if (explicitPageFile) defaultFile = explicitPageFile
  }

  // 未明确提到页面名时：沿用上一轮目标（连续改同一页）或当前打开页/路由
  if (!defaultFile && !hasPageHint && preferredFile && preferredFile.endsWith('.vue')) {
    defaultFile = preferredFile
  } else if (!defaultFile && activeFile && activeFile.endsWith('.vue')) {
    defaultFile = activeFile
  }

  if (!defaultFile) {
    const routes = Array.isArray(projectInfo && projectInfo.routes) ? projectInfo.routes : []

    // 0.5) 「期货预测页面空白了」一类：若项目里已有期货视图则优先锁定；否则不再强行澄清，交给后续语义/LLM 选择最接近的页面
    const isFuturesIntent = /期货|期货预测|futures/i.test(textForTarget)
    if (isFuturesIntent) {
      const futureViews = views.filter(v => {
        const name = (v.name || '').toLowerCase()
        const file = (v.file || '').toLowerCase()
        return /futures|期货/.test(name) || /futures|期货/.test(file)
      })
      if (futureViews.length === 1) {
        defaultFile = futureViews[0].file
      } else if (futureViews.length > 1) {
        const labels = futureViews.map(v => path.basename(v.file || '', '.vue')).filter(Boolean)
        return {
          needsClarification: true,
          clarificationQuestion: `当前项目中发现多个与「期货」相关的页面候选：${labels.join('、')}。请问您说的「期货预测页面空白了」具体是哪个？（可以直接说文件名或对应路由）`,
          candidateFuturesViews: futureViews
        }
      }
      // 没有任何期货相关视图时，不再直接澄清，后续交给语义匹配或 LLM 在全局视图中选择最接近的页面（例如 TodayStockRecommendation）
    }

    // 1) 若前端传了当前路由，则优先用路由 → 组件 → 视图 的映射来精确选中对应页面（与 Cursor 当前文件绑定类似）
    if (currentRoutePath) {
      const route = routes.find(r => r.path === currentRoutePath)
      if (route && route.component) {
        const compName = String(route.component).toLowerCase()
        const byRouteView = views.find(v => (v.name || '').toLowerCase() === compName)
        if (byRouteView && byRouteView.file) {
          defaultFile = byRouteView.file
        }
      }
    }

    // 2) 文本中出现「指令详情/详情页」等 → 意图是详情页，而不是列表
    if (!defaultFile) {
      const detailRe = /指令\s*详情|详情\s*页|详情\s*页面|指令市场\s*详情|指令详情/
      const hasDetailInCombined = detailRe.test(textForTarget)
      const hasDetailInOriginal = detailRe.test(originalMessage)
      const hasDetailInText = detailRe.test(text)
      const isDetailIntent = hasDetailInCombined || hasDetailInOriginal || hasDetailInText

      if (isDetailIntent) {
        const detailViews = views.filter(v => {
          const name = (v.name || '').toLowerCase()
          const file = (v.file || '').toLowerCase()
          return name.includes('detail') || file.includes('detail')
        })

        if (detailViews.length === 1) {
          // 只有一个详情页候选时，直接选它（典型：CommandDetail.vue）
          defaultFile = detailViews[0].file
        } else if (detailViews.length > 1) {
          const lowerAll = textForTarget.toLowerCase()
          // 2.1) 文本里有「生成/自定义」等字眼 → 优先 Generated/自定义类详情页
          if (/自定义|生成|latest/i.test(lowerAll)) {
            const generated = detailViews.find(v => {
              const name = (v.name || '').toLowerCase()
              const file = (v.file || '').toLowerCase()
              return name.includes('generated') || file.includes('generated')
            })
            if (generated && generated.file) {
              defaultFile = generated.file
            }
          }
          // 2.2) 否则，若有「CommandDetail」这一类主详情页，则优先它（典型「指令详情页面」）
          if (!defaultFile) {
            const commandDetail = detailViews.find(v => {
              const name = (v.name || '').toLowerCase()
              const file = (v.file || '').toLowerCase()
              return name === 'commanddetail' || file.endsWith('commanddetail.vue')
            })
            if (commandDetail && commandDetail.file) {
              defaultFile = commandDetail.file
            }
          }
          // 2.3) 仍无法区分时，不再猜测具体详情页，而是交给上层走澄清流程
          if (!defaultFile && detailViews.length > 1) {
            const labels = detailViews.map(v => path.basename(v.file || '', '.vue')).filter(Boolean)
            return {
              needsClarification: true,
              clarificationQuestion: `当前项目中有多个详情页候选：${labels.join('、')}。请问您想优化的是哪一个？（可以直接说文件名或对应路由）`,
              candidateDetailViews: detailViews
            }
          }
        } else {
          // 文本明确是详情页，但暂时没扫到 views 列表时，按约定名称兜底
          defaultFile = 'src/views/CommandDetail.vue'
        }
      }
    }

    // 2.8) 若上述规则都未能锁定视图，则基于项目上下文做一轮「语义匹配」，尽量找到最可能对应的页面
    if (!defaultFile) {
      // 评分时优先用用户原话，避免 refinedInstruction/上下文里的其他页面名干扰「改哪里」
      const textForScoring = (originalMessage || text || '').trim() || textForTarget
      const lowerText = textForScoring.toLowerCase()
      let best = null
      let bestScore = 0

      const routeByComponent = new Map()
      routes.forEach(r => {
        if (!r || !r.component) return
        const key = String(r.component).toLowerCase()
        const arr = routeByComponent.get(key) || []
        arr.push(r)
        routeByComponent.set(key, arr)
      })

      for (const v of views) {
        if (!v || !v.file) continue
        const name = (v.name || '').toLowerCase()
        const file = (v.file || '').toLowerCase()
        const base = path.basename(v.file || '', '.vue').toLowerCase()
        const compRoutes = name ? (routeByComponent.get(name) || []) : []
        const routePaths = compRoutes.map(r => String(r.path || '').toLowerCase())

        let score = 0
        if (name && lowerText.includes(name)) score += 20
        if (base && lowerText.includes(base)) score += 16
        for (const p of routePaths) {
          if (!p) continue
          if (lowerText.includes(p)) score += 16
          const segs = p.split('/').filter(Boolean)
          const last = segs[segs.length - 1] || ''
          if (last && lowerText.includes(last)) score += 12
        }

        // 常见中文别名 → 视图名（用用户原话评分，上下文仅辅助）
        const isDashboard = base === 'dashboard'
        const isCommandMarket = base === 'commandmarket'
        const isCommandDetail = base === 'commanddetail'
        const isNoCode = base === 'nocodebuilder'
        if (isDashboard && /(仪表盘|首页|总览)/.test(textForScoring)) score += 22
        if (isCommandMarket && /(指令市场|应用市场)/.test(textForScoring)) score += 22
        if (isCommandDetail && /(指令详情|详情页|详情页面)/.test(textForScoring)) score += 22
        if (isNoCode && /(无代码|低代码|可视化搭建|页面生成)/.test(textForScoring)) score += 22

        if (/(期货|期货预测|futures)/i.test(textForScoring) && /futures|期货/i.test(base + ' ' + name + ' ' + file)) {
          score += 30
        }

        if (score > bestScore) {
          bestScore = score
          best = v
        }
      }

      if (best && best.file && bestScore > 0) {
        defaultFile = best.file
      }
    }
  }

  // 所有规则与语义匹配都无法确定目标视图时，让后续的 LLM planner 基于完整 projectInfo 再做一次全局语义选择；
  // 此时 ruleBasedPlan 返回 null，plan() 会调用 DeepSeek 来决定 actions（含目标文件）。
  if (!defaultFile) {
    return null
  }

  // 菜单项加图标 → 只改菜单所在文件（App.vue 或 menuContainers），绝不改视图页；用 hasMenuKeyword+hasLogoKeyword 或 thought 判
  const menuContainersList = Array.isArray(projectInfo && projectInfo.semantic && projectInfo.semantic.menuContainers) ? projectInfo.semantic.menuContainers : []
  const isMenuContainerFile = defaultFile && (menuContainersList.some(m => m.file === defaultFile) || defaultFile === 'src/App.vue')
  const isMenuIconAction = (hasMenuKeyword && hasLogoKeyword) || (thought && (thought.fromRule === 'menu_item_icon' || thought.fromRule === 'menu_item_icon_short'))
  if (isMenuContainerFile && isMenuIconAction) {
    let desc = (thought && thought.refinedInstruction) ? (thought.refinedInstruction || '').trim() : ''
    if (desc && desc.includes('【目标文件：')) {
      desc = desc.replace(/【目标文件：[^】]+】/g, defaultFile)
    }
    if (!desc) desc = `在 ${defaultFile} 的 el-menu 中，找到用户所指的菜单项（如「今日股票推荐」对应的 el-menu-item），在其内（span slot="title" 前）添加左侧图标 <i class="el-icon-xxx"></i>，与同文件中其它菜单项写法一致。仅修改该菜单项，不要改任何视图页面。`
    return {
      actions: [
        { type: 'modify_view', file: defaultFile, reason: text, description: desc }
      ]
    }
  }

  // 只改数量/数字：用户说「卡片数据少从4改成8」「数据从4个改成8个」等 → 最小改动，只改那一处数字，不碰整页
  const numChangeMatch = text.match(/(?:卡片)?(?:数据|数量|条数)?(?:比较)?少[，,]?\s*(?:从\s*)?(\d+)\s*个?\s*改成\s*(\d+)|从\s*(\d+)\s*个?\s*改成\s*(\d+)|(\d+)\s*个?\s*改成\s*(\d+)|(?:数据|数量)\s*从\s*(\d+)\s*改成\s*(\d+)/)
  if (numChangeMatch) {
    const fromNum = parseInt(numChangeMatch[1] || numChangeMatch[3] || numChangeMatch[5] || numChangeMatch[7], 10)
    const toNum = parseInt(numChangeMatch[2] || numChangeMatch[4] || numChangeMatch[6] || numChangeMatch[8], 10)
    if (!Number.isNaN(fromNum) && !Number.isNaN(toNum) && fromNum !== toNum) {
      return {
        actions: [
          {
            type: 'modify_view',
            file: defaultFile,
            reason: text,
            description: `仅将控制卡片/列表数量的数字（如 pageSize、limit、.slice(0,${fromNum})、:page-size 等）从 ${fromNum} 改为 ${toNum}，其他代码一律不改。不要重写文件、不要改 template 结构或样式。`,
            minimalEdit: true,
            numberChange: { from: fromNum, to: toNum }
          }
        ]
      }
    }
  }

  // 通用：任意「X改成Y」/「X改为Y」（可有可无空格）——直接产出 modify_view，由 codegen 做全文查找替换
  if (/.+\s*改成\s*.+/.test(text) || /.+\s*改为\s*.+/.test(text)) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户要求将指定文字或代码替换为另一处，仅做此处替换。'
        }
      ]
    }
  }

  // 优先识别「只改某处文案」：听懂用户是在让某几个字/某段话换一种描述，不是要生成页面
  // 1) 明确提到「指令类型」：只改工具栏「指令类型：」该处文案
  const isChangeInstructionTypeLabel = /指令类型.*[换改]|[换改].*指令类型|指令类型.*(这几个字|这段|换一种描述|换说法)/.test(text)
  if (isChangeInstructionTypeLabel) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户要求将页面工具栏中的「指令类型：」该处文案换一种说法，仅改该处文字，不动其他'
        }
      ]
    }
  }

  // 2.5) hover 时展示全部：用户说 hover/悬停 时展示全部、没展示全部 等 → 为卡片内截断文案加 el-tooltip（含 thinker  refine 后的说法）
  const isHoverShowFullIntent = (
    (/(hover|悬停)/i.test(text) && /(展示全部|显示全部|显示完整|没展示全部)/.test(text)) ||
    /(el-tooltip|悬停时展示完整|展示完整内容)/.test(text)
  )
  if (isHoverShowFullIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望 hover 被截断的文案时展示全部内容（通用能力，适用于任意页面）。请根据当前文件的 template 与 style，找出所有被省略的文案区块（含 text-overflow:ellipsis、-webkit-line-clamp 的 class 或内联样式），为每个区块外包 el-tooltip，:content 绑定该区块当前展示的数据（如 v-for 的 item 的对应字段、或单条数据的属性），placement="top"，:open-delay="300"；多行描述类区块可使用 effect="light"、popper-class（如 full-text-tooltip）及非 scoped 样式（max-width:360px; white-space:pre-wrap; word-break:break-word）；移除这些区块上原有的 title、@mouseenter、@mouseleave。仅做以上修改。'
        }
      ]
    }
  }

  // 通用能力：超出省略号
  if (/(超出|长文本|省略(号)?|单行|多行)\s*省略/.test(text) || /text_ellipsis|省略样式/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望长文案超出时显示省略号（通用）。请根据当前文件为需要截断的文案区块添加单行（overflow:hidden;text-overflow:ellipsis;white-space:nowrap）或多行（-webkit-line-clamp;overflow:hidden）样式，仅改 style 或最小 template。' }] }
  }
  // 仪表盘页面加图表/仪表盘：用户说仪表盘页面加一些仪表盘、图表、太空了、都是文字 等 → 在目标页加 ECharts 等图表
  const isDashboardAddCharts =
    /(仪表盘|dashboard)/i.test(textForTarget) &&
    (/加\s*(一些)?\s*(仪表盘|图表|图表组件)|(太)?空(了|洞)|都是文字|文字描述|丰富.*内容|加.*echarts|加.*图/.test(text) || /(仪表盘页面|首页).*加/.test(text))
  if (isDashboardAddCharts && defaultFile) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望在仪表盘页面增加图表/数据可视化组件，减少纯文字、让页面更丰富。请在当前视图的 template 中增加若干图表区域（如 el-row + el-col 布局），使用 ECharts（若项目已引入）或 div 占位 + ref，在 mounted 中初始化柱状图、饼图或折线图等；保留现有欢迎文案等内容，在其上方或下方添加图表卡片，使页面更像仪表盘。仅修改该视图的 template 与 script（含 echarts 初始化），不改路由与其它页面。'
        }
      ]
    }
  }

  // 通用能力：空状态
  if (/(没有数据|列表为空|空状态|空数据|空占位)/.test(text) || /empty_state|el-empty/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望无数据时显示空状态（通用）。请在列表/表格容器上根据数据长度用 v-if/v-else 展示 el-empty 或「暂无数据」占位，保留有数据时的结构。' }] }
  }
  // 通用能力：加载中
  if (/(加载|loading|加载中)/.test(text) && /(显示|加)/.test(text) || /loading_state|v-loading/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望加载时显示 loading（通用）。请在列表/表格或主内容容器上使用 v-loading 或 el-skeleton，绑定 loading 变量，在请求前 true、结束后 false。' }] }
  }
  // 通用能力：表格斑马纹
  if (/(表格|el-table).*斑马纹|斑马纹|隔行\s*变/.test(text) || /table_stripe/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望表格斑马纹或隔行变色（通用）。请为 el-table 添加 stripe 属性或 :row-class-name 实现隔行背景。' }] }
  }
  // 通用能力：卡片内部标题 / 内容 / 标签之间的间距（例如「每个卡片里面的标题、内容和 tag 都挨在一起了，上下加一些距离」）
  const isCardInnerSpacingIntent =
    /卡片/.test(text) &&
    /(标题|title).*(内容|description|描述).*(tag|标签)|(标题|内容|描述|tag|标签).*(挨在一起|挨着|贴在一起|太挤|距离|间距|上下加一些距离)/.test(text)
  if (isCardInnerSpacingIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望调整卡片内部标题、内容和标签之间的垂直/水平间距，使信息更易读且不显得拥挤：仅通过修改 <style> 中与卡片内部布局相关的样式（例如 .command-content、.name-row、.description-wrap、.tags-row 或对应 class 的 margin / padding / gap 等）来增加上下/左右间距，不改 template 结构和业务逻辑。'
        }
      ]
    }
  }
  // 通用能力：按钮防重复点击
  if (/(防重复|防止重复|禁止重复).*点击|按钮.*防重复/.test(text) || /button_prevent_double/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望提交按钮防重复点击（通用）。请为提交/确认按钮增加 :loading 或点击后 disabled，在请求期间禁用。' }] }
  }
  // 通用能力：危险操作前确认
  if (/(删除|操作).*确认|确认.*删除|二次确认/.test(text) || /confirm_before_danger/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望删除或危险操作前二次确认（通用）。请在执行前使用 this.$confirm 弹出确认框，用户确认后再执行原有逻辑。' }] }
  }
  // 通用能力：卡片/列表 hover 效果
  if (/(卡片|列表).*(hover|悬停).*(阴影|高亮)|card_hover_effect/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望卡片或列表项 hover 时有阴影/高亮（通用）。请在对应 class 的 :hover 中增加 box-shadow 或 background 变化，仅改 style。' }] }
  }
  // 通用能力：图片懒加载
  if (/图片?.*懒加载|懒加载|image_lazy/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望图片懒加载（通用）。请为 img/el-image 添加 lazy 或 loading="lazy"，仅改图片相关属性。' }] }
  }
  // 通用能力：响应式栅格
  if (/(小屏|移动端).*一排|响应式.*栅格|responsive_grid/.test(text)) {
    return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望小屏/移动端栅格一排一个或响应式（通用）。请为 el-col 设置 :xs="24" 等响应式属性。' }] }
  }
  // 通用能力：点击复制、回到顶部、表单校验、分页、搜索筛选、排序、骨架屏、错误重试、刷新、禁用只读、占位文案、图标 tooltip、tabs、弹窗抽屉、行内编辑、全选、清空重置、导出、面包屑、吸顶
  if (/复制|clipboard|copy/i.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望某处可点击复制到剪贴板（通用）。用 clipboard API 或 execCommand，复制成功可 message 提示。' }] }
  if (/回到顶部|返回顶部|backtop/i.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望有回到顶部（通用）。加 el-backtop 或按钮 scrollTo(0,0)。' }] }
  if (/表单.*校验|必填|校验.*通过|rules|required/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望表单校验/必填（通用）。el-form 的 :rules，提交前 validate。' }] }
  if (/分页|pagination/i.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望列表分页（通用）。el-pagination 绑定 current-page、page-size、total 与 change 事件。' }] }
  if (/搜索|筛选|filter/.test(text) && !/指令类型/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望搜索或筛选（通用）。输入/选择绑定条件，请求或前端 filter。' }] }
  if (/排序|sortable|sort-order/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望表格/列表排序（通用）。el-table 列 sortable 或 sort-change。' }] }
  if (/骨架屏|skeleton/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望加载时骨架屏（通用）。el-skeleton，v-if loading 时显示。' }] }
  if (/(错误|失败).*提示|重试|error.*message/i.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望失败提示或重试（通用）。catch 里 message.error，可选重试按钮。' }] }
  if (/刷新|重新加载|reload/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望刷新/重新加载（通用）。按钮点击重新请求数据。' }] }
  if (/禁用|只读|disabled|readonly/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望某处禁用或只读（通用）。:disabled 或 :readonly 绑定。' }] }
  if (/占位|placeholder/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望改占位文案（通用）。修改对应 placeholder。' }] }
  if (/(图标|按钮).*提示|tooltip.*包/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望图标/按钮悬停提示（通用）。外包 el-tooltip。' }] }
  if (/标签页|tab\s*切换|el-tabs/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望标签页/Tabs（通用）。el-tabs，tab 与内容对应。' }] }
  if (/弹窗|抽屉|dialog|drawer|modal/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望弹窗/抽屉（通用）。el-dialog/el-drawer，visible 控制。' }] }
  if (/行内编辑|可编辑|inline\s*edit/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望行内/可编辑（通用）。点击切 input，保存更新。' }] }
  if (/全选|批量|多选|selection/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望全选/批量选择（通用）。el-table selection 或 checkbox 全选。' }] }
  if (/清空|重置|reset/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望清空/重置（通用）。resetFields 或置空条件后重请求。' }] }
  if (/导出|export/i.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望导出（通用）。按钮触发导出接口或前端 xlsx 等。' }] }
  if (/面包屑|breadcrumb/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望面包屑（通用）。el-breadcrumb 展示路径。' }] }
  if (/吸顶|固定表头|sticky/.test(text)) return { actions: [{ type: 'modify_view', file: defaultFile, reason: text, description: '用户希望吸顶/固定表头（通用）。position:sticky 或 table fixed。' }] }

  // 2) 换描述/副标题/好听一点：只改 .page-subtitle
  const isChangeTextIntent = (
    /(描述|文案|副标题|说明|标题|文字|句子|说法).*[换改]|[换改].*(描述|文案|副标题|说明|标题|文字|句子|说法)/.test(text) ||
    /不好听|不好看|不顺口|好听一点|好听些|换一句|换一个(描述|文案)?|换个说法|换一种说法|改一下说法|顺口一点/.test(text)
  )
  if (isChangeTextIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户要求更换页面副标题（.page-subtitle）文案：相同语义换一种说法，仅改该处描述文字，不改主标题(.page-title)、不动样式与结构'
        }
      ]
    }
  }

  // 3) 标签间距：用户说 tag/标签 左右距离挨着 → 只改 CommandMarket 标签样式
  const isTagSpacingIntent = (
    /(tag|标签).*(距离|间距|挨着|挨在一起)/i.test(text) ||
    /(左右).*(tag|标签).*(距离|间距|挨着)/i.test(text)
  )
  if (isTagSpacingIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户要求调整指令卡片内标签的左右间距，仅修改 <style> 中与 .tags-row / .tag-item 相关的样式，不改模板与业务逻辑'
        }
      ]
    }
  }

  // 4) 工具栏与卡片间距：筛选框/搜索框这一行和下面卡片距离太远/近一点 → 只改当前页工具栏与卡片间距
  const isToolbarCardSpacingIntent = (
    (/(筛选框|筛选|搜索框|工具栏|这一行)/.test(text) &&
      /卡片/.test(text) &&
      /(距离|间距|太远|太近|近一点|靠近)/.test(text))
  )
  if (isToolbarCardSpacingIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望缩短筛选工具栏与卡片列表之间的垂直间距，仅调整 <style> 中 .toolbar 的 padding-bottom 和 .card-grid 的 padding-top，不改模板与业务逻辑'
        }
      ]
    }
  }

  // 5) 卡片高度：「卡片高度太高」「卡片高度还是太高」「指令市场卡片高度矮一点」等 → 只调当前页卡片高度样式
  const isCardHeightIntent = (
    /(卡片.*高度.*(太高|矮|低|小|短)|高度.*(太高|矮|低|小|短).*卡片|卡片高度还是太高|卡片太高|太高.*卡片|卡片.*太高|指令市场卡片高度.*(矮|低|小|短))/.test(text)
  )
  if (isCardHeightIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户觉得指令市场卡片高度太高，希望整体降低卡片高度，仅修改 <style> 中与 .command-card / .card-grid .command-card 相关的 min-height 等样式，不改模板与逻辑'
        }
      ]
    }
  }

  // 6) 按钮颜色柔和一点 / 太刺眼 → 调整当前文件主按钮颜色
  const isButtonColorSoftIntent =
    /按钮/.test(text) &&
    /(颜色|太亮|太刺眼|柔和|淡一点|浅一点|不那么亮|不要这么亮)/.test(text)
  if (isButtonColorSoftIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望当前页面主按钮颜色更柔和，调整 .el-button--primary 等主按钮颜色的背景和边框，仅改样式，不改逻辑'
        }
      ]
    }
  }

  // 7) 标题字号调整：「主标题字号大一点/小一点」
  const isTitleFontSizeIntent = /(主标题|页面标题|标题).*(大一点|再大|大一号|字号大|字体大|小一点|再小|小一号|字号小|字体小)/.test(text)
  if (isTitleFontSizeIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望调整当前页面主标题的字号大小，仅修改 .page-title 或 h1 的 font-size，不改文案与结构'
        }
      ]
    }
  }

  // 8) 标题居中：「主标题居中/放中间」
  const isTitleCenterIntent = /(主标题|页面标题|标题).*(居中|放中间|放到中间)/.test(text)
  if (isTitleCenterIntent) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户希望将当前页面主标题水平居中，仅调整主标题区域的对齐样式，不改文案与结构'
        }
      ]
    }
  }

  // 场景：优化指令市场/页面（含仅说「优化页面」）→ 单文件 modify_view，零次 LLM 规划，避免整页重写报错
  const hasOptimize = text.includes('优化')
  const hasTarget = text.includes('指令市场') || text.includes('CommandMarket') || text.includes('页面') || text.includes('整体') || text.includes('卡片')
  const styleLike = (
    text.includes('样式') || text.includes('颜色') || text.includes('布局') || text.includes('美观') ||
    text.includes('卡片') || text.includes('高度') || text.includes('间距') || text.includes('视觉') || text.includes('统一') ||
    text.includes('靠边框') || text.includes('贴边') || text.includes('靠边') || text.includes('贴边框')
  )
  // 「优化页面」「优化一下」等短句也命中，避免走 LLM 整页重写导致报错
  if (hasOptimize && (hasTarget || styleLike)) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '整体优化页面卡片高度与样式；若涉及卡片内贴边/靠边框，为 .command-card-footer 等增加合适 padding（仅调整 <style>，保持业务逻辑和 template 结构不变）'
        }
      ]
    }
  }

  // 兜底：未命中任何规则时，仍产出一条 modify_view；
  // 若用户明确要「新增/新建/写一个页面」这类 → 交给 LLM 规划（可能产出 add_view），而不是误改当前页面
  if (newPageIntentRe.test(text)) {
    return null
  }

  // 通用兜底样式补丁（Cursor 式）：若用户明确在说「样式/颜色/间距/对齐/字体/背景/边框」这类视觉属性，
  // 且不是在描述新页面或复杂交互/复杂布局，则统一走一次 CSS 补丁型 modify_view，
  // 由 codegen 只对 <style> 或最小必要的 class 做修改，而不重写 template 或业务逻辑。
  const styleKeywords = /(样式|颜色|配色|间距|距离|padding|margin|对齐|居中|靠左|靠右|字体|字号|粗细|加粗|背景|边框|阴影|圆角|高亮|hover|悬停|行高|line-height|布局|spacing)/i
  const logicKeywords = /(点击|请求|接口|保存|提交|删除|跳转|分页|搜索|筛选|排序|加载|刷新|重试|接口返回|请求失败|逻辑|校验|验证)/i
  // 复杂样式/布局关键词：这类场景通常需要 LLM 理解整体结构，不适合简单 CSS patch，
  // 保持与 Cursor 相似：简单 patch 用规则，复杂效果交给模型规划。
  const complexStyleKeywords = /(动画|渐变|transition|transform|旋转|缩放|响应式|自适应|栅格|grid|布局乱|重排|重构布局|多列布局|瀑布流|折行|换行|省略号|ellipsis|多行文本|卡片里面布局)/i
  if (styleKeywords.test(text) && !logicKeywords.test(text) && !complexStyleKeywords.test(text)) {
    return {
      actions: [
        {
          type: 'modify_view',
          file: defaultFile,
          reason: text,
          description: '用户提出的是纯样式/视觉相关调整（颜色、间距、对齐、字号、背景、边框、阴影、hover 效果等），请仅通过修改当前文件 <style> 或与目标元素相关的 class 的 CSS 属性来完成需求，可以按需新增少量 class 或在现有 class 上调整 margin/padding/gap/color/font-size/background/border 等；严禁重写或大改 template 结构，严禁修改 JS 逻辑和接口调用。'
        }
      ]
    }
  }

  const isDialogOnly = /弹窗|dialog|编辑.*弹窗|新建.*弹窗/.test(combinedMsg)
  const description = isDialogOnly
    ? '仅修改该页面内的弹窗/对话框（根据当前文件实际使用的组件，如 el-dialog、a-modal、Modal、van-popup 等）的样式，按用户要求调整，不要改页面其他区域。'
    : '根据用户描述对当前页面做最小必要修改，严格按用户意图实现，不要扩大范围、不要整页重写。'
  return {
    actions: [
      {
        type: 'modify_view',
        file: defaultFile,
        reason: text,
        description
      }
    ]
  }
}

/**
 * 检查某视图是否已在路由中注册；若未注册则返回应补的 router 的 modify_view action（用于「页面空白」先补路由）
 * @param {string} viewFile - 如 src/views/TodayStockRecommendation.vue
 * @param {object} projectInfo - 含 routes: { path, component }[]
 * @returns {{ hasRoute: boolean, routePath?: string, componentName?: string, routerAction?: object }}
 */
function ensureRouteForView (viewFile, projectInfo) {
  if (!viewFile || !viewFile.endsWith('.vue') || !viewFile.includes('views')) return { hasRoute: true }
  const componentName = path.basename(viewFile, '.vue')
  const routePath = '/' + componentName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
  const routes = Array.isArray(projectInfo && projectInfo.routes) ? projectInfo.routes : []
  const hasRoute = routes.some(r => (r.path === routePath) || (String(r.component || '').toLowerCase() === componentName.toLowerCase()))
  if (hasRoute) return { hasRoute: true }
  const title = componentName === 'TodayStockRecommendation' ? '今日股票推荐' : componentName === 'FuturesPrediction' ? '期货预测' : componentName
  const routerAction = {
    type: 'modify_view',
    file: 'src/router/index.js',
    reason: '补全缺失路由以修复点击菜单后页面空白',
    description: `在 src/router/index.js 中：1) 在现有 import 后添加一行：const ${componentName} = () => import('@/views/${componentName}.vue'); 2) 在 routes 数组内、任意现有路由对象后添加新项：{ path: '${routePath}', component: ${componentName}, meta: { title: '${title}' } }。不要删除、不要改已有路由，仅添加上述 import 与一条 route。`
  }
  return { hasRoute: false, routePath, componentName, routerAction }
}

/**
 * 主入口：根据用户指令 + 项目信息规划改动 actions
 *
 * 流程：
 * 1. 先跑 ruleBasedPlan 命中简单场景（零次 LLM 调用）
 * 2. 规则返回后若为「页面空白」且目标为视图，检查路由是否缺失，缺失则先补一条 modify router 的 action
 * 3. 若无命中，再调用 DeepSeek，让模型基于项目结构规划 add_view / modify_view 等 actions
 * 4. 最终只保留支持的 action 类型
 */
async function plan (instruction, projectInfo, context = {}) {
  const rule = ruleBasedPlan(instruction, projectInfo, context)
  if (rule) {
    const thought = context && context.thought
    const isPageBlankIntent = (thought && thought.fromRule === 'page_blank_bug') || /(页面)?空白|白屏|没显示|不显示|什么都没有/.test(instruction || '')
    const actions = Array.isArray(rule.actions) ? rule.actions : []
    if (isPageBlankIntent && actions.length === 1 && actions[0].type === 'modify_view' && (actions[0].file || '').endsWith('.vue') && (actions[0].file || '').includes('views')) {
      const viewFile = actions[0].file
      const { hasRoute, routerAction } = ensureRouteForView(viewFile, projectInfo)
      if (!hasRoute && routerAction) {
        rule.actions = [routerAction, ...actions]
      }
    }
    return rule
  }

  // 先基于项目语义地图做一轮「语义选页」，得到最相关的视图候选列表；
  // 这些候选将作为后续 LLM 规划 modify_view 的 file 白名单，避免误改无关页面。
  let semanticCandidates = null
  try {
    semanticCandidates = await semanticPickViews(instruction, projectInfo, context)
  } catch (e) {
    semanticCandidates = null
  }
  const candidateFiles = semanticCandidates && Array.isArray(semanticCandidates.files) ? semanticCandidates.files : []

  const systemPrompt = [
    '你是一个资深前端架构师，像 Cursor 一样思考：先理解用户最终要什么，再拆成最小步骤；能一步完成就只给一条 action，不要扩大范围。',
    '你只输出 JSON，不要任何解释或注释。',
    '',
    '项目结构（只读）：',
    JSON.stringify(projectInfo, null, 2),
    '',
    '语义视图候选（只读）：',
    JSON.stringify({
      candidateFiles,
      note: '若需要返回 modify_view，则优先且尽量只针对这些候选文件；除非非常明确需要改 router/App 菜单（如 src/router/index.js、src/App.vue），否则不要修改候选列表之外的视图文件。'
    }, null, 2),
    '',
    '根据用户需求输出 "actions" 数组。原则：最小改动。若用户只是改一个数字/数量（如「从4个改成8个」「数据少改成8条」），只给一条 modify_view，description 写清「仅将控制卡片/列表数量的数字（如 pageSize、limit、.slice(0,n)）从 X 改为 Y，其他代码不改」。',
    '',
    'action 类型：',
    '1) "add_view"：新增视图并挂载路由。',
    '2) "modify_view"：修改现有视图。若只是改文案/改数字/改一处配置，description 必须写「仅…不动其他」。',
    '   示例（只改数量）：',
    '{ "type": "modify_view", "file": "src/views/CommandMarket.vue", "reason": "用户要求卡片数据从4个改成8个", "description": "仅将控制卡片数量的数字（如 pageSize、.slice(0,4)）从 4 改为 8，其他代码不改。" }',
    '',
    '【新页面（newPageIntent）硬规则】当用户指令中出现「新建页面」「新增页面」「写一个XXX页面」「做一个XXX页面」「新建视图」「新增视图」等表述时，视为新增页面（newPageIntent）：',
    '- 这类需求的主输出必须是一个或多个 "add_view"（新增 .vue 视图文件）。',
    '- 你可以额外返回极少量针对路由或菜单文件的 "modify_view"，例如修改 "src/router/index.js" 或 "src/App.vue" 来挂上新页面的路由和左侧菜单标题。',
    '- 严禁在 newPageIntent 场景下返回任何针对现有业务视图（如 "src/views/CommandMarket.vue"、"src/views/CommandDetail.vue" 等）的 "modify_view"；不要把「新页面」拆成去改 CommandMarket 等旧页面的样式或结构。',
    '',
    '请根据指令给出 0~3 条 actions，能一步完成就一条。',
    '',
    '输出 JSON：{ "actions": [ ... ] }'
  ].join('\n')

  const userPrompt = [
    '用户指令：',
    instruction
  ].join('\n')

  const raw = await callDeepseekJson(systemPrompt, userPrompt)
  if (!raw || typeof raw !== 'object') {
    return { actions: [] }
  }
  if (!Array.isArray(raw.actions)) {
    return { actions: [] }
  }
  // 目前支持 add_view 与 modify_view 两类
  let actions = raw.actions.filter(a => a && (a.type === 'add_view' || a.type === 'modify_view'))

  // 若语义选页器给出了候选视图，则将其作为 modify_view 的 file 白名单，
  // 仅允许修改这些候选视图 + 路由/根组件文件（用于挂路由和菜单）。
  if (candidateFiles && candidateFiles.length) {
    const whitelist = new Set(candidateFiles.concat(['src/router/index.js', 'src/App.vue']))
    actions = actions.filter(a => {
      if (!a || a.type !== 'modify_view') return true
      const file = typeof a.file === 'string' ? a.file : ''
      if (!file) return false
      // 若模型返回的是相对短名（如 FuturesPrediction.vue），尝试补齐 src/views/ 前缀
      if (!whitelist.has(file) && file.endsWith('.vue')) {
        const prefixed = path.join('src', 'views', path.basename(file))
        if (whitelist.has(prefixed)) {
          a.file = prefixed
          return true
        }
      }
      return whitelist.has(file)
    })
  }

  // 若本轮是「新页面」意图，对 LLM 返回的 actions 再做一层硬约束过滤：
  // - 保留所有 add_view；
  // - 只允许修改路由/根组件（用于挂菜单），例如 src/router/index.js、src/App.vue；
  // - 允许在同一轮内对刚刚新增的视图文件做一次补充 modify_view；
  // - 严禁修改现有业务视图（如 CommandMarket.vue、CommandDetail.vue 等），避免「新页面」被错误拆成改老页面。
  const isNewPageIntent = newPageIntentRe.test(instruction || '')
  if (isNewPageIntent) {
    const addedViewNames = new Set(
      actions
        .filter(a => a.type === 'add_view' && a.viewName)
        .map(a => a.viewName)
    )
    actions = actions.filter(a => {
      if (!a) return false
      if (a.type === 'add_view') return true
      if (a.type === 'modify_view') {
        const file = String(a.file || '')
        if (!file) return false
        // 1) 允许只改路由或 App 根组件（左侧菜单）
        if (file.includes('src/router/index.js') || file.includes('src/App.vue')) return true
        // 2) 允许改刚刚新增的视图（例如 add_view 后立刻微调该页）
        if (file.endsWith('.vue') && addedViewNames.size) {
          for (const name of addedViewNames) {
            if (name && file.endsWith(name + '.vue')) return true
          }
        }
        // 3) 其余现有视图一律丢弃（特别是 CommandMarket.vue / CommandDetail.vue 等）
        return false
      }
      return false
    })
  }

  return { actions }
}

module.exports = {
  plan
}

