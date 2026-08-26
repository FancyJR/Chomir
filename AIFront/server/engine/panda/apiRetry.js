/**
 * API 传输层重试（对齐 panda-code services/api/withRetry.ts）
 * 指数退避；仅瞬时错误重试。用户取消 / PROMPT_TOO_LONG / 4xx（非 429）不重试。
 */

const DEFAULT_MAX_RETRIES = parseInt(process.env.PANDA_API_MAX_RETRIES, 10) || 10
const BASE_DELAY_MS = parseInt(process.env.PANDA_API_RETRY_BASE_MS, 10) || 500

function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('已取消'))
      return
    }
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        reject(new Error('已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function isRetryableError (err) {
  if (!err) return false
  if (err.code === 'ABORTED' || err.message === '已取消') return false
  if (err.code === 'PROMPT_TOO_LONG') return false
  const status = err.status || err.statusCode || 0
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) return true
  if (status >= 400 && status < 500) return false
  const msg = String(err.message || err)
  if (/timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket/i.test(msg)) return true
  if (/大模型请求超时/.test(msg)) return true
  return false
}

function getRetryDelay (attempt) {
  const exp = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * 200)
  return Math.min(30000, exp + jitter)
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, signal?: AbortSignal, onRetry?: function }} [opts]
 * @returns {Promise<T>}
 */
async function withApiRetry (fn, opts = {}) {
  const max = opts.maxRetries != null ? opts.maxRetries : DEFAULT_MAX_RETRIES
  let lastErr
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isRetryableError(e) || attempt >= max) throw e
      const delay = getRetryDelay(attempt + 1)
      if (typeof opts.onRetry === 'function') {
        try { opts.onRetry({ attempt: attempt + 1, max, delay, error: e }) } catch (e2) { /* ignore */ }
      }
      await sleep(delay, opts.signal)
    }
  }
  throw lastErr
}

module.exports = {
  withApiRetry,
  isRetryableError,
  getRetryDelay,
  DEFAULT_MAX_RETRIES,
  BASE_DELAY_MS
}
