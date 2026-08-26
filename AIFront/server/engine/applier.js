/**
 * 补丁应用器（applier）
 *
 * 职责：
 * - 根据 codegen 生成的文件描述（files），真正把变更写入工程目录
 * - 负责：
 *   - 新增视图文件（type: 'view'）
 *   - 修改现有文件（type: 'modify'，写入前会做 .bak 备份）
 *   - 自动更新 router/index.js 中的 import 与 routes 配置
 *   - 自动在 App.vue 左侧菜单中追加对应的菜单项
 * - 写入 .vue 文件时，会调用 processVueContentStripVerticalWritingMode 做兜底处理，
 *   避免样式修改后出现标题竖排等影响可用性的情况。
 * - 写入前还会调用 style-preserve 的 applyPreserveToVueContent，按视图配置自动补全
 *   必须保留的样式（如配色、卡片高度、元信息等），避免引擎优化后页面变黑白或布局错乱。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')
const { processVueContentStripVerticalWritingMode } = require('./codegen')
const { applyPreserveToVueContent } = require('./style-preserve')

const BUILD_TIMEOUT_MS = 90000

function runBuild (projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('构建超时（' + (BUILD_TIMEOUT_MS / 1000) + 's）'))
    }, BUILD_TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, code, signal, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function apply (files, projectInfo) {
  if (!Array.isArray(files) || !files.length) return { changed: [], buildOk: true }
  const projectRoot = projectInfo.root
  const viewsDir = path.resolve(projectRoot, 'src', 'views')
  const routerPath = path.resolve(projectRoot, 'src', 'router', 'index.js')
  const appPath = path.resolve(projectRoot, 'src', 'App.vue')
  let routerCode = ''
  let appCode = ''
  let appChanged = false
  try {
    routerCode = await fsp.readFile(routerPath, 'utf8')
  } catch (e) {
    routerCode = ''
  }
  try {
    appCode = await fsp.readFile(appPath, 'utf8')
  } catch (e) {
    appCode = ''
  }

  const changed = []
  /** 本次写入中做了 .bak 备份的 .vue 相对路径，用于构建失败时回滚 */
  const backedUpVuePaths = []
  /** 本次新增的 .vue 路径（相对），用于决定是否跑构建校验 */
  const newViewPaths = []

  for (const file of files) {
    if (file.type === 'view') {
      const viewFileName = `${file.viewName}.vue`
      const viewFilePath = path.resolve(viewsDir, viewFileName)
      await fsp.mkdir(viewsDir, { recursive: true })
      await fsp.writeFile(viewFilePath, file.vueCode, 'utf8')
      const rel = path.relative(projectRoot, viewFilePath)
      changed.push({ file: rel })
      newViewPaths.push(rel)

      if (file.routePath && routerCode) {
        const importLine = `const ${file.viewName} = () => import('@/views/${viewFileName}')`
        if (!routerCode.includes(importLine)) {
          const insertPos = routerCode.indexOf('export default new Router')
          if (insertPos !== -1) {
            routerCode =
              routerCode.slice(0, insertPos) +
              importLine +
              '\n' +
              routerCode.slice(insertPos)
          }
        }

        if (!routerCode.includes(`path: '${file.routePath}'`)) {
          const routesStart = routerCode.indexOf('routes: [')
          if (routesStart !== -1) {
            const insertPos = routerCode.indexOf(']', routesStart)
            if (insertPos !== -1) {
              const routeBlock = `,
    {
      path: '${file.routePath}',
      component: ${file.viewName},
      meta: { title: '${file.routeTitle || file.viewName}' }
    }`
              routerCode =
                routerCode.slice(0, insertPos) +
                routeBlock +
                routerCode.slice(insertPos)
            }
          }
        }
      }

      // 自动为新视图挂到 App.vue 左侧菜单
      if (file.routePath && appCode) {
        const menuIndexStr = `index="${file.routePath}"`
        if (!appCode.includes(menuIndexStr)) {
          const menuEnd = appCode.indexOf('</el-menu>')
          if (menuEnd !== -1) {
            const title = file.routeTitle || file.viewName || file.routePath.replace(/^\//, '')
            const lower = title.toLowerCase()
            const iconClass =
              title.includes('统计') || lower.includes('chart') || lower.includes('data')
                ? 'el-icon-data-analysis'
                : 'el-icon-document'
            const menuItem = `
          <el-menu-item index="${file.routePath}">
            <i class="${iconClass}"></i>
            <span slot="title">${title}</span>
          </el-menu-item>`
            appCode =
              appCode.slice(0, menuEnd) +
              menuItem +
              '\n' +
              appCode.slice(menuEnd)
            appChanged = true
          }
        }
      }
    } else if (file.type === 'modify') {
      const targetPath = path.resolve(projectRoot, file.file)
      // 写入前对 .vue：竖排兜底 + 样式保留（自动补全关键选择器/配色，避免优化后变黑白、卡片高度不一）
      let contentToWrite = file.newContent
      if (path.extname(file.file) === '.vue') {
        contentToWrite = processVueContentStripVerticalWritingMode(contentToWrite)
        contentToWrite = applyPreserveToVueContent(contentToWrite, file.file)
      }
      // 简单备份一下原文件
      try {
        if (fs.existsSync(targetPath)) {
          const bakPath = targetPath + '.bak'
          await fsp.copyFile(targetPath, bakPath)
          changed.push({ file: path.relative(projectRoot, bakPath) })
          if (path.extname(file.file) === '.vue') {
            backedUpVuePaths.push(file.file)
          }
        }
      } catch (e) {
        // 备份失败不阻塞后续写入
      }
      await fsp.writeFile(targetPath, contentToWrite, 'utf8')
      changed.push({ file: path.relative(projectRoot, targetPath) })
    }
  }

  if (routerCode) {
    await fsp.writeFile(routerPath, routerCode, 'utf8')
    changed.push({ file: path.relative(projectRoot, routerPath) })
  }

  if (appCode && appChanged) {
    await fsp.writeFile(appPath, appCode, 'utf8')
    changed.push({ file: path.relative(projectRoot, appPath) })
  }

  let buildOk = true
  let buildError = null
  const rolledBack = []
  /** 回滚前读出的「失败内容」，供上层做自动修复重试；key 为相对路径 */
  const rolledBackContent = {}

  if (backedUpVuePaths.length > 0 || newViewPaths.length > 0) {
    try {
      const buildResult = await runBuild(projectRoot)
      if (!buildResult.ok) {
        buildOk = false
        buildError = (buildResult.stderr || buildResult.stdout || '').trim() || '构建失败'
        for (const rel of backedUpVuePaths) {
          const targetPath = path.resolve(projectRoot, rel)
          const bakPath = targetPath + '.bak'
          try {
            if (fs.existsSync(bakPath)) {
              try {
                const brokenContent = await fsp.readFile(targetPath, 'utf8')
                rolledBackContent[rel] = brokenContent
              } catch (e) {
                // 读失败则只回滚不提供内容
              }
              await fsp.copyFile(bakPath, targetPath)
              rolledBack.push(rel)
              console.log('[applier] 构建失败已回滚:', rel)
            }
          } catch (e) {
            console.error('[applier] 回滚失败', rel, e.message)
          }
        }
      }
    } catch (e) {
      buildOk = false
      buildError = e.message || '构建校验执行失败'
      for (const rel of backedUpVuePaths) {
        const targetPath = path.resolve(projectRoot, rel)
        const bakPath = targetPath + '.bak'
        try {
          if (fs.existsSync(bakPath)) {
            try {
              const brokenContent = await fsp.readFile(targetPath, 'utf8')
              rolledBackContent[rel] = brokenContent
            } catch (err) {
              // ignore
            }
            await fsp.copyFile(bakPath, targetPath)
            rolledBack.push(rel)
          }
        } catch (err) {
          console.error('[applier] 回滚失败', rel, err.message)
        }
      }
    }
  }

  return { changed, buildOk, buildError: buildError || undefined, rolledBack, rolledBackContent }
}

module.exports = {
  apply
}

