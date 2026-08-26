/**
 * 何时必须 Agent(Verify)（对齐 panda-code：非琐碎才强制；避免「改个背景色」死锁）
 */

function changedPaths (runtime) {
  return (runtime && runtime.changedFiles || [])
    .map(f => (typeof f === 'string' ? f : (f && (f.file || f.path)) || ''))
    .filter(Boolean)
}

function isStyleOnlyGoal (goal) {
  const g = String(goal || '')
  if (!g.trim()) return false
  // 用户明确只要颜色/背景/太丑换色等，且未要求重构
  if (/(重构|重写|抽离|架构|接口|api|路由|逻辑)/i.test(g)) return false
  return /(背景|白色|黑色|颜色|配色|主题色|太丑|换色|background|color\b|白底|浅色|深色主题)/i.test(g)
}

function isTrivialUiChange (runtime, goal) {
  const paths = changedPaths(runtime)
  const g = goal != null ? goal : (runtime && runtime.lastUserGoal)
  if (isStyleOnlyGoal(g) && paths.length <= 3) return true
  if (paths.length === 0) return true
  if (paths.length <= 2 && paths.every(p => /\.(vue|css|scss|less|sass)$/i.test(p)) && isStyleOnlyGoal(g)) {
    return true
  }
  // 单文件仅样式类改动且目标很短（≤40字）的「改白/改色」
  if (paths.length === 1 && /\.vue$/i.test(paths[0]) && String(g || '').length <= 60 && isStyleOnlyGoal(g)) {
    return true
  }
  return false
}

function requiresAgentVerify (runtime, goal) {
  if (isTrivialUiChange(runtime, goal)) return false
  const paths = changedPaths(runtime)
  if (paths.length >= 3) return true
  if (paths.some(p => /(server\/|api\/|\.js$|\.ts$|router|store)/i.test(p) && !/\.vue$/i.test(p))) {
    return true
  }
  // 非琐碎实现（有改动但不是纯样式口头目标）
  if (paths.length >= 1 && !isStyleOnlyGoal(goal != null ? goal : (runtime && runtime.lastUserGoal))) {
    return paths.length >= 2
  }
  return false
}

module.exports = {
  changedPaths,
  isStyleOnlyGoal,
  isTrivialUiChange,
  requiresAgentVerify
}
