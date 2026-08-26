const STORAGE_KEY = 'AIFront_NoCodePages_v1'

function safeParse (str, fallback) {
  try {
    return JSON.parse(str)
  } catch (e) {
    return fallback
  }
}

function readAll () {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || '[]'
    const list = safeParse(raw, [])
    return Array.isArray(list) ? list : []
  } catch (e) {
    // 某些浏览器隐私模式下 localStorage 可能不可用，此时直接退回空列表
    return []
  }
}

function writeAll (list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list || []))
  } catch (e) {
    // 存储失败时静默忽略，不影响页面生成功能
  }
}

export function saveNoCodePage (page) {
  const id = page.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const record = {
    id,
    createdAt: page.createdAt || new Date().toISOString(),
    name: page.name || '未命名页面',
    input: page.input || {},
    html: page.html || '',
    css: page.css || '',
    vueCode: page.vueCode || '',
    meta: page.meta || {}
  }

  // localStorage 写入失败不影响返回记录
  const list = readAll()
  const next = [record, ...list.filter(i => i && i.id !== id)]
  writeAll(next)
  return record
}

export function getNoCodePage (id) {
  const list = readAll()
  return list.find(i => String(i.id) === String(id)) || null
}

export function listNoCodePages () {
  return readAll()
}

