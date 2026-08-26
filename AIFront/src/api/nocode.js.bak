import { generatePageFromInputs } from '@/utils/nocodeGenerator'

// 通过后端代理调用大模型，避免浏览器直连 DeepSeek 时的 CORS/预检问题
export async function generateNoCodePage (payload) {
  const safePayload = payload || {}
  try {
    const res = await fetch('/api/nocode/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safePayload)
    })
    const data = await res.json()
    if (res.ok && data && (data.html !== undefined || data.vueCode !== undefined)) {
      return {
        vueCode: data.vueCode || '',
        html: data.html || '',
        css: data.css || '',
        meta: data.meta || { provider: 'deepseek-chat' }
      }
    }
    // 接口返回非 2xx 或格式不对，记下错误信息，但仍用本地模板填充预览
    const errMsg = (data && data.message) ? data.message : (`HTTP ${res.status}`)
    console.warn('[nocode] 后端返回异常', res.status, errMsg, data && data.error)
    const local = generatePageFromInputs(safePayload)
    return {
      _fallback: true,
      _error: errMsg,
      _errorCode: data && data.error,
      vueCode: '',
      html: local.html,
      css: local.css,
      meta: { provider: 'local-template', ...(local.meta || {}) }
    }
  } catch (e) {
    console.warn('[nocode] 请求后端失败，使用本地模板', e)
  }
  const local = generatePageFromInputs(safePayload)
  return {
    _fallback: true,
    _error: (e && e.message) || '网络异常',
    vueCode: '',
    html: local.html,
    css: local.css,
    meta: { provider: 'local-template', ...(local.meta || {}) }
  }
}
