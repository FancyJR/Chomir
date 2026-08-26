/**
 * 项目分析器（analyzer）
 *
 * 职责：
 * - 从项目根目录读取 package.json / 路由 / store / 视图目录等基础信息
 * - 解析出「有哪些视图」「有哪些路由」，给 planner / router / codegen 使用
 * - 做 15 秒缓存，避免每次指令都全盘重新扫描工程，提升整体性能
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

// 缓存有效期（毫秒）——15 秒内重复调用直接走缓存
const CACHE_TTL_MS = 15000
let cached = null        // 最近一次分析的结果
let cachedAt = 0         // 最近一次分析的时间戳

/**
 * 安全读取文件内容：读取失败时返回空字符串，避免上层还要写 try/catch
 */
async function safeRead (filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8')
    return content
  } catch (e) {
    return ''
  }
}

/**
 * 列出某个目录下的所有 .vue 文件，返回 { name, file } 结构
 * 这里只关心第一层文件，不递归子目录
 */
function listVueFiles (dir, basePrefix) {
  try {
    const files = fs.readdirSync(dir)
    return files
      .filter(f => f.endsWith('.vue'))
      .map(f => ({
        name: path.basename(f, '.vue'),
        file: path.join(basePrefix, f)
      }))
  } catch (e) {
    return []
  }
}

/**
 * 解析 router/index.js 中的路由配置
 *
 * 这是一个“非严格解析”：用正则尽量从代码里提取出
 *   { path: '/xxx', component: Xxx, meta: { title: 'xxx' } }
 * 方便后续根据 path/component 做定位，而不需要真正执行 JS。
 */
function parseRoutes (routerCode) {
  const routes = []
  const routeRegex = /{\s*path:\s*'([^']+)'\s*,\s*component:\s*([A-Za-z0-9_]+)[^}]*}/g
  let m
  while ((m = routeRegex.exec(routerCode)) !== null) {
    const block = m[0]
    let metaTitle = ''
    const metaMatch = block.match(/meta:\s*{\s*title:\s*'([^']+)'/)
    if (metaMatch) {
      metaTitle = metaMatch[1]
    }
    routes.push({
      path: m[1],
      component: m[2],
      metaTitle
    })
  }
  return routes
}

/**
 * 从 App.vue 中提取菜单项信息：
 * - index（通常是路由 path）
 * - 展示文案（菜单标题）
 */
function parseMenuItems (appCode) {
  if (!appCode) return []
  const items = []
  const itemRe = /<el-menu-item\s+[^>]*index=["']([^"']+)["'][^>]*>([\s\S]*?)<\/el-menu-item>/g
  let m
  while ((m = itemRe.exec(appCode)) !== null) {
    const index = m[1]
    const inner = m[2]
    let title = ''
    const titleMatch = inner.match(/<span[^>]*slot=["']title["'][^>]*>([\s\S]*?)<\/span>/)
    if (titleMatch) {
      title = titleMatch[1].replace(/\s+/g, ' ').trim()
    } else {
      // 兜底：直接取去标签后的文本
      const plain = inner
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      title = plain
    }
    items.push({ index, title })
  }
  return items
}

/**
 * 分析当前工程结构
 *
 * @param {boolean} skipCache 是否忽略缓存强制重新扫描
 * @returns {Promise<{
 *   root: string,
 *   framework: string,
 *   pkg: object,
 *   files: { router: string, store: string|null, viewsDir: string, componentsDir?: string },
 *   views: { name: string, file: string }[],
 *   routes: { path: string, component: string, metaTitle?: string }[],
 *   semantic?: {
 *     views: {
 *       name: string,
 *       file: string,
 *       routePath: string,
 *       routeTitle: string,
 *       menuTitle: string,
 *       semanticText: string,
 *       patterns?: string[]   // 列表/详情/表单/表格/图表/API 调用 等模式标签
 *     }[],
 *     components?: {
 *       name: string,
 *       file: string,
 *       semanticText: string,
 *       patterns?: string[]
 *     }[],
 *     sectionsByView?: {
 *       [file: string]: {
 *         type: string,        // 如 card_list / filters_toolbar / title_block / footer / tab_bar 等
 *         selector: string,    // 代表性 CSS 选择器或根 class
 *         semanticText: string // 用于 LLM 语义匹配的描述
 *       }[]
 *     }
 *   }
 * }>}
 */
async function analyze (skipCache = false) {
  const now = Date.now()
  if (!skipCache && cached && (now - cachedAt) < CACHE_TTL_MS) {
    return cached
  }
  const projectRoot = path.resolve(__dirname, '..', '..')
  const pkgPath = path.resolve(projectRoot, 'package.json')
  const routerPath = path.resolve(projectRoot, 'src', 'router', 'index.js')
  const storePath = path.resolve(projectRoot, 'src', 'store', 'index.js')
  const viewsDir = path.resolve(projectRoot, 'src', 'views')
  const componentsDir = path.resolve(projectRoot, 'src', 'components')
  const appPath = path.resolve(projectRoot, 'src', 'App.vue')

  const [pkgJsonStr, routerCode, storeCode, appCode] = await Promise.all([
    safeRead(pkgPath),
    safeRead(routerPath),
    safeRead(storePath),
    safeRead(appPath)
  ])

  let pkg = {}
  try {
    pkg = pkgJsonStr ? JSON.parse(pkgJsonStr) : {}
  } catch (e) {
    pkg = {}
  }

  const views = listVueFiles(viewsDir, path.join('src', 'views'))
  const components = listVueFiles(componentsDir, path.join('src', 'components'))
  const routes = parseRoutes(routerCode)

  // 简单模式识别：根据文件内容与模板片段，为视图/组件打上「列表/详情/表单/表格/图表/API 调用」等标签
  function detectPatterns (code, filePath) {
    const patterns = new Set()
    const lower = (code || '').toLowerCase()
    const base = path.basename(filePath || '', '.vue').toLowerCase()
    if (/detail/.test(base) || /(详情页|详情页面|详情)/.test(code)) patterns.add('detail')
    if (/list/.test(base) || /(列表|清单)/.test(code)) patterns.add('list')
    if (/<el-form[\s>]/i.test(code) || /(表单|form-item)/.test(code)) patterns.add('form')
    if (/<el-table[\s>]/i.test(code) || /(表格|table-column)/.test(code)) patterns.add('table')
    if (/\becharts\b/.test(lower) || /this\.\$echarts/.test(lower)) patterns.add('chart')
    if (/\baxios\b/.test(lower) || /this\.\$http/.test(lower) || /\bfetch\s*\(/.test(lower)) patterns.add('api_call')
    return Array.from(patterns)
  }

  // 基于「视图 + 路由 + 菜单」构建一份轻量级语义索引，给上层做语义匹配使用
  const menus = parseMenuItems(appCode)
  const semanticViews = []
  const sectionsByView = {}
  for (const v of views) {
    const compName = (v.name || '').toLowerCase()
    const route = routes.find(r => (r.component || '').toLowerCase() === compName)
    const routePath = route ? route.path : ''
    const routeTitle = route ? (route.metaTitle || '') : ''
    const menu = menus.find(m => m.index === routePath)
    const menuTitle = menu ? menu.title : ''
    const baseName = path.basename(v.file, '.vue')
    const absViewPath = path.resolve(projectRoot, v.file)
    // 视图内容只读一次，用于模式识别与 section 粗定位
    // 注意：这里是同步循环 + await，会稍慢，但有 15s 缓存，且视图数量有限
    // eslint-disable-next-line no-await-in-loop
    const viewCode = await safeRead(absViewPath)
    const patterns = detectPatterns(viewCode, v.file)

    // 粗略提取 template 部分，用于 section 级索引（不追求严谨 AST，只提供线索给 LLM）
    const tplMatch = viewCode.match(/<template[\s\S]*?>([\s\S]*?)<\/template>/i)
    const tpl = tplMatch ? tplMatch[1] : ''
    const sections = []
    if (tpl) {
      const addSection = (type, selector, hint) => {
        sections.push({
          type,
          selector,
          semanticText: [type, selector, hint].filter(Boolean).join(' ')
        })
      }
      if (tpl.includes('card-grid') || tpl.includes('command-card')) {
        addSection('card_list', '.card-grid .command-card-main', '卡片列表区，展示多条记录或指令卡片')
      }
      if (tpl.includes('toolbar') || tpl.includes('type-select') || tpl.includes('status-select')) {
        addSection('filters_toolbar', '.toolbar', '筛选/搜索工具栏区域，包括类型筛选、状态筛选、搜索输入等')
      }
      if (tpl.includes('status-tabs') || tpl.includes('el-button-group')) {
        addSection('status_tabs', '.status-tabs', '状态 Tab 区域，用于切换全部/我创建的/订阅等标签')
      }
      if (tpl.includes('page-header') || tpl.includes('page-title')) {
        addSection('title_block', '.page-header', '页面标题与副标题区域')
      }
      if (tpl.includes('pagination-wrapper') || tpl.includes('<el-pagination')) {
        addSection('pagination', '.pagination-wrapper', '分页区域，包含总条数与 el-pagination')
      }
      if (tpl.includes('<el-table')) {
        addSection('table', 'el-table', '表格区域，展示列表数据')
      }
      if (tpl.includes('<el-form')) {
        addSection('form', 'el-form', '表单区域，包含多个输入项/选择项')
      }
      if (tpl.includes('<el-tabs')) {
        addSection('tab_bar', 'el-tabs', '标签页区域，用于不同内容切换')
      }
      if (tpl.includes('command-card-footer') || tpl.includes('meta-left') || tpl.includes('meta-right')) {
        addSection('card_footer', '.command-card-footer', '卡片底部元信息区域，展示创建者、日期、订阅数、状态等')
      }
      const dialogMatch = tpl && (tpl.match(/<(el-dialog|a-modal|van-popup|n-modal|el-drawer|a-drawer)[\s>]/i) || tpl.match(/<([a-z-]+)[^>]*\s+role=["']dialog["']/i) || tpl.match(/class=["'][^"']*dialog[^"']*["']/i))
      const dialogTag = dialogMatch ? (dialogMatch[1] || 'dialog').toLowerCase() : ''
      if (dialogTag) {
        addSection('dialog', dialogTag, '弹窗/对话框区域，根据当前项目使用的 UI 库识别')
      }
    }
    if (sections.length) {
      sectionsByView[v.file] = sections
    }
    const hasDialog = !!(tpl && (/<el-dialog[\s>]|<a-modal[\s>]|van-popup|n-modal|role=["']dialog["']|class=["'][^"']*dialog/.test(tpl)))
    const semanticText = [
      v.name,
      baseName,
      routePath,
      routeTitle,
      menuTitle,
      patterns.join(' '),
      hasDialog ? '弹窗 dialog modal' : ''
    ].filter(Boolean).join(' ')
    semanticViews.push({
      name: v.name,
      hasDialog: !!hasDialog,
      file: v.file,
      routePath,
      routeTitle,
      menuTitle,
      semanticText,
      patterns
    })
  }

  // 扫描「菜单所在文件」：含导航/菜单结构的布局文件（按项目实际内容识别，不写死 UI 库）
  const menuContainers = []
  function hasMenu (code) {
    if (!code) return false
    return /<el-menu[\s>]/.test(code) || /<el-menu-item[\s>]/.test(code) ||
      /<a-menu[\s>]/i.test(code) || /<a-menu-item[\s>]/i.test(code) ||
      /<van-tabbar|el-tabs[\s>]/.test(code) ||
      /<nav[\s>]|role=["']navigation["']/.test(code) ||
      /class=["'][^"']*menu[^"']*["']/.test(code)
  }
  if (hasMenu(appCode)) {
    menuContainers.push({
      file: 'src/App.vue',
      semanticText: '根组件 含导航/菜单'
    })
  }
  const srcDir = path.resolve(projectRoot, 'src')
  try {
    const srcFiles = fs.readdirSync(srcDir) || []
    for (const name of srcFiles) {
      if (!name.endsWith('.vue') || name === 'App.vue') continue
      const fp = path.join(srcDir, name)
      if (!fs.statSync(fp).isFile()) continue
      const code = await safeRead(fp)
      if (hasMenu(code)) {
        const rel = path.join('src', name)
        if (!menuContainers.some(m => m.file === rel)) {
          menuContainers.push({ file: rel, semanticText: `src/${name} 含导航菜单` })
        }
      }
    }
  } catch (e) { /* ignore */ }
  const layoutDir = path.resolve(projectRoot, 'src', 'layout')
  if (fs.existsSync(layoutDir) && fs.statSync(layoutDir).isDirectory()) {
    try {
      const layoutFiles = fs.readdirSync(layoutDir) || []
      for (const name of layoutFiles) {
        if (!name.endsWith('.vue')) continue
        const fp = path.join(layoutDir, name)
        if (!fs.statSync(fp).isFile()) continue
        const code = await safeRead(fp)
        if (hasMenu(code)) {
          const rel = path.join('src', 'layout', name)
          if (!menuContainers.some(m => m.file === rel)) {
            menuContainers.push({ file: rel, semanticText: `layout/${name} 含导航菜单` })
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  const semanticComponents = []
  for (const c of components) {
    const baseName = path.basename(c.file, '.vue')
    const absCompPath = path.resolve(projectRoot, c.file)
    // eslint-disable-next-line no-await-in-loop
    const compCode = await safeRead(absCompPath)
    if (hasMenu(compCode) && !menuContainers.some(m => m.file === c.file)) {
      menuContainers.push({ file: c.file, semanticText: (c.name || c.file) + ' 含导航菜单' })
    }
    const patterns = detectPatterns(compCode, c.file)
    const semanticText = [
      c.name,
      baseName,
      patterns.join(' ')
    ].filter(Boolean).join(' ')
    semanticComponents.push({
      name: c.name,
      file: c.file,
      semanticText,
      patterns
    })
  }

  cached = {
    root: projectRoot,
    framework: 'vue2',
    pkg,
    files: {
      router: 'src/router/index.js',
      store: fs.existsSync(storePath) ? 'src/store/index.js' : null,
      viewsDir: 'src/views',
      componentsDir: fs.existsSync(componentsDir) ? 'src/components' : null
    },
    views,
    routes,
    semantic: {
      views: semanticViews,
      components: semanticComponents,
      sectionsByView,
      menuContainers
    }
  }
  cachedAt = now
  return cached
}

module.exports = {
  analyze
}

