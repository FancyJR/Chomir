/**
 * 轻量项目快照（对齐「懂项目」感，非 AST CodeGraph）
 * 注入 Env：顶层目录、package scripts、菜单/路由摘要
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const cache = new Map() // root -> { at, text }
const TTL = 20000

async function buildProjectSnapshot (projectRoot) {
  const root = path.resolve(projectRoot)
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < TTL) return hit.text

  const lines = []
  try {
    const top = fs.readdirSync(root)
      .filter(n => !n.startsWith('.') && n !== 'node_modules' && n !== 'dist' && n !== 'panda-code')
      .slice(0, 24)
    lines.push('Top-level: ' + top.join(', '))
  } catch (e) { /* ignore */ }

  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
    const scripts = Object.keys(pkg.scripts || {}).slice(0, 12)
    if (scripts.length) lines.push('npm scripts: ' + scripts.join(', '))
    const deps = Object.keys(Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {})).slice(0, 20)
    if (deps.length) lines.push('key deps: ' + deps.join(', '))
  } catch (e) { /* ignore */ }

  try {
    const analyzer = require('../analyzer')
    const info = await analyzer.analyze()
    const menus = (info.menus || []).slice(0, 16)
    if (menus.length) {
      lines.push(
        'Menus→routes: ' +
        menus.map(m => (m.title || '') + '→' + (m.index || '')).filter(Boolean).join('; ')
      )
    }
    const routes = (info.routes || []).slice(0, 20)
    if (routes.length) {
      lines.push('Routes: ' + routes.map(r => r.path + (r.metaTitle ? '(' + r.metaTitle + ')' : '')).join(', '))
    }
    const views = (info.views || []).slice(0, 25)
    if (views.length) {
      lines.push('Views: ' + views.map(v => v.file || v.name).join(', '))
    }
  } catch (e) {
    // fallback: list views dir
    try {
      const views = fs.readdirSync(path.join(root, 'src', 'views'))
        .filter(f => f.endsWith('.vue'))
        .slice(0, 20)
      if (views.length) lines.push('Views: ' + views.map(v => 'src/views/' + v).join(', '))
    } catch (e2) { /* ignore */ }
  }

  lines.push('Hint: 无完整 CodeGraph；深入结构用 glob/grep 或并行 Agent(Explore)。以上为启动快照，may or may not relate to the task.')
  const text = lines.join('\n')
  cache.set(root, { at: Date.now(), text })
  return text
}

module.exports = {
  buildProjectSnapshot
}
