/**
 * Auto mode denial tracking（对齐 panda-code/utils/permissions/denialTracking.ts）
 */

const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20
}

/** @type {Map<string, { consecutiveDenials: number, totalDenials: number }>} */
const bySession = new Map()

function createDenialTrackingState () {
  return { consecutiveDenials: 0, totalDenials: 0 }
}

function getState (sessionId) {
  const key = String(sessionId || '') || '__default__'
  if (!bySession.has(key)) bySession.set(key, createDenialTrackingState())
  return bySession.get(key)
}

function setState (sessionId, state) {
  const key = String(sessionId || '') || '__default__'
  bySession.set(key, state)
}

function recordDenial (sessionId) {
  const prev = getState(sessionId)
  const next = {
    consecutiveDenials: prev.consecutiveDenials + 1,
    totalDenials: prev.totalDenials + 1
  }
  setState(sessionId, next)
  return next
}

function recordSuccess (sessionId) {
  const prev = getState(sessionId)
  if (prev.consecutiveDenials === 0) return prev
  const next = {
    consecutiveDenials: 0,
    totalDenials: prev.totalDenials
  }
  setState(sessionId, next)
  return next
}

function shouldFallbackToPrompting (state) {
  const s = state || createDenialTrackingState()
  return (
    s.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    s.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}

function resetDenialTracking (sessionId) {
  if (sessionId == null) bySession.clear()
  else bySession.delete(String(sessionId) || '__default__')
}

module.exports = {
  DENIAL_LIMITS,
  createDenialTrackingState,
  getState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
  resetDenialTracking
}
