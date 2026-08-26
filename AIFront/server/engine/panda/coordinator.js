/**
 * Coordinator：并行调度多个子代理并汇总（对标 panda-code coordinatorMode 精简版）
 */

const { callDeepseekText } = require('../shared-llm')
const { runExploreAgent, runPlanAgent, runVerifyAgent } = require('./subagents')

/**
 * @param {string} goal
 * @param {string} projectRoot
 * @param {object} [opts]
 * @param {Array} [opts.changedFiles]
 * @param {function} [opts.onProgress]
 */
async function runCoordinator (goal, projectRoot, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const changedFiles = opts.changedFiles || []

  onProgress('coordinator', '并行启动 Explore + Plan…')
  const [explore, plan] = await Promise.all([
    runExploreAgent(goal, projectRoot).catch(e => 'Explore 失败：' + e.message),
    runPlanAgent(goal, projectRoot, '').catch(e => 'Plan 失败：' + e.message)
  ])

  let verify = ''
  if (changedFiles.length) {
    onProgress('coordinator', '检测到已有改动，启动 Verify…')
    verify = await runVerifyAgent(goal, projectRoot, changedFiles).catch(e => 'Verify 失败：' + e.message)
  }

  onProgress('coordinator', '汇总子代理结果…')
  const prompt = [
    '你是 Coordinator。下面是并行子代理的报告，请汇总成给主 Agent 的行动指令：',
    '1) 结论摘要',
    '2) 建议立刻执行的工具步骤（有序列表）',
    '3) 风险与不要做的事',
    '4) 若信息不足，列出需要 ask_user 的问题',
    '',
    '用户目标：' + goal,
    '',
    '=== Explore ===',
    explore,
    '',
    '=== Plan ===',
    plan,
    '',
    changedFiles.length ? ('=== Verify ===\n' + verify) : '(无 Verify)'
  ].join('\n')

  let synthesis = ''
  try {
    synthesis = await callDeepseekText('只输出汇总行动指令，简洁有力。', prompt, { max_tokens: 1500 })
  } catch (e) {
    synthesis = ['【降级汇总】', 'Explore:', explore.slice(0, 2000), 'Plan:', plan.slice(0, 2000)].join('\n')
  }

  return {
    explore,
    plan,
    verify: verify || null,
    synthesis
  }
}

module.exports = {
  runCoordinator
}
