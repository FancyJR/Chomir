/**
 * 多轮续跑门控（对齐 panda-code query.ts：Stop blocking / Keep working）
 * 无工具时默认结束；未完成工作 → 注入 meta 并继续。
 * 禁止「只分析不动手」空转续跑（同一原因只催一次）。
 */

function incompleteTodos (todos) {
  if (!Array.isArray(todos) || !todos.length) return []
  return todos.filter(t => {
    const s = String((t && t.status) || 'pending')
    return s !== 'completed' && s !== 'cancelled'
  })
}

function isKeepGoingMessage (text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (/^(继续|接着|接着做|往下做|keep\s*going|continue|go\s*on|resume)([。.！!？?\s]|$)/i.test(t)) return true
  if (t.length <= 20 && /^(继续|接着干|继续吧|继续做)$/i.test(t)) return true
  return /(继续完成|接着改|继续修|别停|继续做完|接着完成)/i.test(t)
}

/** 长篇空转分析（反复「让我重新想」却不 call 工具） */
function looksLikeRumination (text) {
  const t = String(text || '')
  if (t.length < 500) return false
  const markers = (t.match(/让我重新|我重新|换个思路|我实在找不到|现在我完全理解|我决定采取|真正的 bug|等等[！!]|再审视|再想一想|算了[，,]/gi) || []).length
  const acted = /(edit_file|write_file|apply_patch|edit_lines|agent_verify|\bAgent\b|已修改|已写入|已修复)/i.test(t)
  return markers >= 3 && !acted
}

function looksLikePrematureDone (assistantText, runtime) {
  const t = String(assistantText || '')
  if (!t.trim()) return true
  if (incompleteTodos(runtime.todos).length) return true
  const claimed = /(已完成|已修好|已经改好|搞定了|修复完成|全部完成|可以了|没问题了|done\.?$|fixed|all set)/i.test(t)
  const verified = !!(runtime && runtime.didVerify) && !(runtime && runtime.verifyFailed)
  if (claimed && runtime && runtime.changedFiles && runtime.changedFiles.length >= 1 && !verified) {
    return true
  }
  return false
}

function formatIncompleteTodos (todos) {
  return incompleteTodos(todos)
    .map(t => `- [${t.status || 'pending'}] ${t.id || '?'}: ${t.content || ''}`)
    .join('\n')
}

/**
 * @returns {{ continue: boolean, reason: string, message: string } | null}
 */
function decideContinueWithoutTools (opts) {
  const {
    assistantText,
    runtime,
    continueCount,
    maxContinues
  } = opts
  const maxC = maxContinues != null ? maxContinues : 8
  if (continueCount >= maxC) return null

  const lastReason = runtime && runtime.lastContinueReason

  // 空转分析：最多催一次立刻用工具；再次仍无工具则停止
  if (looksLikeRumination(assistantText)) {
    if (lastReason === 'force_tool' || continueCount >= 1) return null
    return {
      continue: true,
      reason: 'force_tool',
      message: [
        '【系统】检测到长篇分析却未调用工具。',
        '下一轮必须立刻调用 edit_file / read_file / Agent(Verify) 之一，禁止再输出大段推理。',
        '若无需改码，用一两句话结束即可。'
      ].join('\n')
    }
  }

  function once (reason, message) {
    if (lastReason === reason) return null
    return { continue: true, reason, message }
  }

  // 写码空转（反复 read 同文件）被熔断后：最多催一次动手改，再空转则结束
  if (runtime && runtime.readLoopBlocked) {
    if (lastReason === 'read_loop_break') {
      runtime.readLoopBlocked = false
      return null
    }
    return {
      continue: true,
      reason: 'read_loop_break',
      message: [
        '【系统 · 打断读循环】你已反复读取同一文件，引擎已熔断再读。',
        '下一轮必须 edit_file/write_file/apply_patch，或用一两句话问清用户要改什么。',
        '禁止再 read_file 该路径，禁止「先读原始文件确认」空转。'
      ].join('\n')
    }
  }

  if (runtime && runtime.pendingDiagErrors && continueCount < maxC) {
    const hit = once('pending_diagnostics', [
      '【系统续跑 · new-diagnostics】有诊断 error。',
      runtime.pendingDiagSummary ? String(runtime.pendingDiagSummary).slice(0, 1200) : '',
      '请立刻 edit_file 修复，不要长篇分析。'
    ].filter(Boolean).join('\n'))
    if (hit) return hit
  }

  if (runtime && runtime.pendingCommandFail && continueCount < maxC) {
    const maxHeal = parseInt(process.env.PANDA_MAX_HEALING, 10) || 3
    const heals = runtime.healCount || 0
    if (heals >= maxHeal) {
      // 硬中断自愈：不再续跑；提示 undo（无 claude-fix 临时分支神话）
      runtime.pendingCommandFail = false
      return once('heal_exhausted', [
        '【系统 · 自愈上限】bash/build 已失败 ' + heals + ' 次（MAX_HEALING=' + maxHeal + '）。',
        runtime.pendingCommandSummary ? String(runtime.pendingCommandSummary).slice(0, 800) : '',
        '停止自动续跑。请诚实说明阻塞；必要时用 undo_file 回退最近改动，勿继续盲目改。'
      ].filter(Boolean).join('\n'))
    }
    const hit = once('command_fail', [
      '【系统续跑 · 命令失败】自愈 ' + heals + '/' + maxHeal + '。',
      runtime.pendingCommandSummary ? String(runtime.pendingCommandSummary).slice(0, 1200) : '',
      '请根据 stderr 用 edit_file 修复后重跑命令；不要空谈。'
    ].filter(Boolean).join('\n'))
    if (hit) return hit
  }

  // 失败熔断续跑（同指纹未达硬上限时催换策略）
  try {
    const fuse = require('./failureFuse')
    if (fuse.shouldForceContinue(runtime) && continueCount < maxC) {
      const hit = once('failure_fuse', fuse.continueMessage(runtime))
      if (hit) return hit
    }
  } catch (e) { /* ignore */ }

  if (runtime && runtime.lastEditFailed && continueCount < 3) {
    const hit = once('edit_failed', '【系统续跑】写文件失败。请 read_file 后精确 edit，禁止空转分析。')
    if (hit) return hit
  }

  if (runtime && runtime.verifyFailed && continueCount < maxC) {
    const attempts = runtime.verifyAttempts || 0
    const hard = process.env.PANDA_VERIFY_HARD === '1' || process.env.CLAW_VERIFY_HARD === '1'
    if (attempts >= 2 || !hard) {
      // soft 默认：不强制续跑；hard 模式下两次后也放行
      runtime.verifyFailed = false
      return once('verify_exhausted', [
        '【系统】Verify FAIL（soft：不强制续跑）。请诚实说明阻塞，或自行 bash/grep 自证后收工。',
        hard && attempts >= 2 ? '（HARD 模式已重试 ' + attempts + ' 次）' : ''
      ].filter(Boolean).join(' '))
    }
    const hit = once('verify_failed', '【系统续跑 · verify FAIL】请修代码并再次 Agent(Verify)，不要空谈。')
    if (hit) return hit
  }

  const pending = incompleteTodos(runtime.todos)
  if (pending.length) {
    const hit = once('incomplete_todos', [
      '【系统续跑】未完成 todos：',
      formatIncompleteTodos(runtime.todos),
      '请用工具推进并勾选，禁止只分析。'
    ].join('\n'))
    if (hit) return hit
  }

  const vp = require('./verifyPolicy')
  const needVerify = vp.requiresAgentVerify(runtime, runtime && runtime.lastUserGoal)
  const hardVerify = process.env.PANDA_VERIFY_HARD === '1' || process.env.CLAW_VERIFY_HARD === '1'
  if (looksLikePrematureDone(assistantText, runtime) && runtime.changedFiles && runtime.changedFiles.length) {
    if (needVerify && hardVerify && (!runtime.didVerify || runtime.verifyFailed)) {
      const hit = once('needs_verify', '【系统续跑】请立刻 Agent(Verify) 或继续 edit，禁止长篇复盘。')
      if (hit) return hit
    }
  }

  if (
    needVerify &&
    runtime &&
    runtime.changedFiles &&
    runtime.changedFiles.length >= 1 &&
    !runtime.didVerify &&
    continueCount < 1
  ) {
    return {
      continue: true,
      reason: 'changed_unverified',
      message: '【系统续跑】已改文件但未验证。请 Agent(Verify) 或继续 edit；不要输出长分析。'
    }
  }

  const reasoning = String(opts.reasoning || '').trim()
  const noVisibleOutput = !String(assistantText || '').trim()
  const finishReason = String(opts.finishReason || '')

  // deepseek-v4-flash 等推理模型：completion 预算常被 reasoning_content 吃光，导致无 tool_calls
  if (noVisibleOutput && reasoning.length > 200 && continueCount < Math.min(maxC, 6)) {
    if (finishReason === 'length' || reasoning.length > 1500) {
      return {
        continue: true,
        reason: 'reasoning_budget',
        message: [
          '【系统续跑 · 推理占满 token】上一轮只有思考、没有工具调用。',
          '下一轮必须立刻 write_file / edit_file / read_file；禁止再写长段推理。',
          '大任务先写最小可运行版本，再迭代补全。'
        ].join('\n')
      }
    }
  }

  if (noVisibleOutput && continueCount < 3) {
    return {
      continue: true,
      reason: 'empty_output',
      message: '【系统续跑】上一轮无输出。请用工具推进。'
    }
  }

  return null
}

function keepGoingUserNudge (originalUserGoal) {
  return [
    '【Keep going】用户要求继续。接着做，不要重复开场白。',
    '原始目标回顾：' + String(originalUserGoal || '').slice(0, 500),
    'Prefer tools over analysis. Keep working until done.'
  ].join('\n')
}

module.exports = {
  incompleteTodos,
  isKeepGoingMessage,
  looksLikePrematureDone,
  looksLikeRumination,
  decideContinueWithoutTools,
  keepGoingUserNudge,
  formatIncompleteTodos
}
