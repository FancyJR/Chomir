/**
 * 本地页面截图（对齐 panda-code WebBrowser / Playwright screenshot）
 * 仅允许 localhost / 127.0.0.1，把「页面长什么样」变成像素给 Agent。
 */

const fsp = require('fs').promises
const path = require('path')
const { execSync } = require('child_process')

function findChrome () {
  if (process.env.CHROME_PATH && require('fs').existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  for (const c of candidates) {
    try {
      if (require('fs').existsSync(c)) return c
    } catch (e) { /* ignore */ }
  }
  try {
    const which = execSync('which google-chrome chromium chromium-browser 2>/dev/null | head -1', {
      encoding: 'utf8'
    }).trim()
    if (which) return which
  } catch (e) { /* ignore */ }
  return null
}

function assertLocalUrl (url) {
  let u
  try {
    u = new URL(url)
  } catch (e) {
    throw new Error('无效 URL：' + url)
  }
  const host = (u.hostname || '').toLowerCase()
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('capture_page 仅允许 localhost / 127.0.0.1（安全限制）')
  }
  return u.toString()
}

function defaultBaseUrl () {
  return process.env.CLAW_UI_BASE || process.env.VUE_DEV_SERVER || 'http://127.0.0.1:8080'
}

function resolveCaptureUrl (args) {
  if (args && args.url) return assertLocalUrl(String(args.url))
  const base = defaultBaseUrl().replace(/\/$/, '')
  let route = String((args && (args.route || args.path)) || '/').trim()
  if (!route.startsWith('/')) route = '/' + route
  return assertLocalUrl(base + route)
}

/**
 * @returns {Promise<{ ok: boolean, content: string, meta?: object }>}
 */
async function capturePage (projectRoot, args = {}) {
  let puppeteer
  try {
    puppeteer = require('puppeteer-core')
  } catch (e) {
    return {
      ok: false,
      content: '未安装 puppeteer-core。请在项目根目录执行：npm install puppeteer-core'
    }
  }

  const chrome = findChrome()
  if (!chrome) {
    return {
      ok: false,
      content: '未找到 Chrome/Chromium。请安装 Chrome，或设置环境变量 CHROME_PATH。也可让用户截图后粘贴到聊天（与 panda-code 主路径一致）。'
    }
  }

  const url = resolveCaptureUrl(args)
  const fullPage = args.fullPage !== false
  const width = Math.min(1920, Math.max(320, parseInt(args.width, 10) || 1280))
  const height = Math.min(1200, Math.max(480, parseInt(args.height, 10) || 800))
  const waitMs = Math.min(15000, Math.max(0, parseInt(args.wait_ms, 10) || 800))

  const dir = path.resolve(projectRoot, '.panda', 'uploads')
  await fsp.mkdir(dir, { recursive: true })
  const file = 'capture_' + Date.now().toString(16) + '.png'
  const abs = path.join(dir, file)
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/')

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars']
    })
    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    if (waitMs) await new Promise(r => setTimeout(r, waitMs))

    // WebBrowser 轻交互（对齐上游 click/type 精髓，仅 localhost）
    const actions = Array.isArray(args.actions) ? args.actions : []
    const notes = []
    for (const act of actions.slice(0, 20)) {
      if (!act || typeof act !== 'object') continue
      const type = String(act.type || act.action || '').toLowerCase()
      try {
        if (type === 'click' && act.selector) {
          await page.click(String(act.selector), { delay: 20 })
          notes.push('click ' + act.selector)
        } else if ((type === 'type' || type === 'fill') && act.selector) {
          const text = String(act.text != null ? act.text : act.value || '')
          if (act.clear !== false) await page.click(String(act.selector), { clickCount: 3 }).catch(() => {})
          await page.type(String(act.selector), text, { delay: 10 })
          notes.push('type ' + act.selector + ' len=' + text.length)
        } else if (type === 'press' && act.key) {
          await page.keyboard.press(String(act.key))
          notes.push('press ' + act.key)
        } else if (type === 'wait') {
          const ms = Math.min(10000, Math.max(0, parseInt(act.ms || act.wait_ms, 10) || 500))
          await new Promise(r => setTimeout(r, ms))
          notes.push('wait ' + ms)
        } else if (type === 'waitfor' && act.selector) {
          await page.waitForSelector(String(act.selector), { timeout: 10000 })
          notes.push('waitFor ' + act.selector)
        }
      } catch (e) {
        notes.push('action fail ' + type + ': ' + (e.message || e))
      }
    }
    if (args.click) {
      try {
        await page.click(String(args.click))
        notes.push('click ' + args.click)
      } catch (e) {
        notes.push('click fail: ' + (e.message || e))
      }
    }
    if (args.type_selector && args.type_text != null) {
      try {
        await page.type(String(args.type_selector), String(args.type_text), { delay: 10 })
        notes.push('type ' + args.type_selector)
      } catch (e) {
        notes.push('type fail: ' + (e.message || e))
      }
    }

    await page.screenshot({ path: abs, fullPage, type: 'png' })
    const buf = await fsp.readFile(abs)
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64')

    const imageUpload = require('./imageUpload')
    const mm = imageUpload.isMultimodalFeatureEnabled() &&
      imageUpload.modelSupportsMultimodal(imageUpload.defaultVisionModel())
    return {
      ok: true,
      content: [
        '已截取页面（对齐 panda-code browser screenshot' + (notes.length ? ' + interact' : '') + '）。',
        'url: ' + url,
        'file: ' + rel,
        'size: ' + buf.length + ' bytes',
        'viewport: ' + width + 'x' + height + (fullPage ? ' fullPage' : ''),
        notes.length ? ('actions: ' + notes.join('; ')) : '',
        '',
        mm
          ? '下一轮将把该截图以多模态方式注入，请根据像素判断后再 edit。'
          : '当前 API 不支持多模态：下一轮仅注入截图文件路径（纯文本），请结合代码判断 UI，勿臆造像素。',
        '不要在没看图/没读截图路径的情况下凭空美化。'
      ].filter(Boolean).join('\n'),
      meta: {
        screenshot: rel,
        imageDataUrl: dataUrl,
        mime: 'image/png',
        url,
        visionAttach: true,
        actions: notes
      }
    }
  } catch (e) {
    return {
      ok: false,
      content: '截图失败：' + (e.message || e) +
        '\n请确认 `npm run serve` 已在 ' + defaultBaseUrl() + ' 运行；或让用户截图粘贴到输入框。'
    }
  } finally {
    if (browser) {
      try { await browser.close() } catch (e) { /* ignore */ }
    }
  }
}

/** 从用户话/路由索引猜要截的路径 */
function inferRouteFromMessage (text, projectInfo) {
  const t = String(text || '')
  const map = [
    [/编排|orchestration/i, '/orchestration'],
    [/指令市场|command.?market/i, '/command-market'],
    [/指令详情/i, '/command/detail/1'],
    [/无代码|no-?code/i, '/no-code'],
    [/仪表盘|dashboard/i, '/dashboard'],
    [/期货/i, '/futures-prediction'],
    [/长期记忆/i, '/long-term-memory'],
    [/panda/i, '/panda']
  ]
  for (const [re, route] of map) {
    if (re.test(t)) return route
  }
  const routes = (projectInfo && projectInfo.routes) || []
  for (const r of routes) {
    if (r.path && t.includes(r.path)) return r.path
  }
  return '/'
}

function looksLikeUiPolishRequest (text) {
  return /(丑|难看|不好看|美化|好看|样式|风格|视觉|配色|间距|布局|卡片|首屏|UI|ux|polish|pretty|redesign|改.*颜|换肤)/i.test(String(text || ''))
}

module.exports = {
  capturePage,
  inferRouteFromMessage,
  looksLikeUiPolishRequest,
  defaultBaseUrl,
  findChrome
}
