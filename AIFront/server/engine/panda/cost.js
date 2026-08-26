/**
 * Token / 费用追踪（对标 panda-code cost-tracker 精简）
 */

/** sessionId -> usage */
const bySession = new Map()

function addUsage (sessionId, usage, model) {
  if (!sessionId || !usage) return getUsage(sessionId)
  const prev = bySession.get(sessionId) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    rounds: 0,
    model: model || ''
  }
  prev.prompt_tokens += usage.prompt_tokens || 0
  prev.completion_tokens += usage.completion_tokens || 0
  prev.total_tokens += usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
  prev.rounds += 1
  if (model) prev.model = model
  // DeepSeek 粗算（可被 env 覆盖）
  const inPrice = parseFloat(process.env.CLAW_PRICE_IN || '0.000001') // $/token 示意
  const outPrice = parseFloat(process.env.CLAW_PRICE_OUT || '0.000002')
  prev.est_cost_usd = Number(
    ((prev.prompt_tokens * inPrice) + (prev.completion_tokens * outPrice)).toFixed(6)
  )
  bySession.set(sessionId, prev)
  return prev
}

function getUsage (sessionId) {
  return bySession.get(sessionId) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    rounds: 0,
    est_cost_usd: 0,
    model: ''
  }
}

function resetUsage (sessionId) {
  bySession.delete(sessionId)
}

function formatUsage (u) {
  u = u || {}
  return [
    `model: ${u.model || '-'}`,
    `rounds: ${u.rounds || 0}`,
    `prompt: ${u.prompt_tokens || 0}`,
    `completion: ${u.completion_tokens || 0}`,
    `total: ${u.total_tokens || 0}`,
    `est_cost_usd: ${u.est_cost_usd || 0}`
  ].join('\n')
}

module.exports = {
  addUsage,
  getUsage,
  resetUsage,
  formatUsage
}
