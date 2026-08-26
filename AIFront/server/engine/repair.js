/**
 * 构建失败后的自动修复（repair）
 *
 * 当 apply 写入 .vue 后构建失败并回滚时，用当前构建错误 + 失败内容调用模型，
 * 生成修正后的 .vue 内容，供上层再次 apply，直到构建通过或达到最大重试次数。
 */

const { callDeepseekText } = require('./shared-llm')
const { processVueContentStripVerticalWritingMode } = require('./codegen')

const REPAIR_MAX_TOKENS = 8192

/**
 * 根据构建错误信息修复 Vue 文件内容
 * @param {string} filePath - 相对路径，如 src/views/CommandMarket.vue
 * @param {string} brokenContent - 导致构建失败的文件内容（回滚前读出）
 * @param {string} buildError - 构建时的 stderr/stdout 或错误摘要
 * @param {string} [userInstruction] - 用户原始需求，便于模型在修错的同时保留需求
 * @returns {Promise<string>} 修正后的完整 .vue 内容
 */
async function repairVueBuildError (filePath, brokenContent, buildError, userInstruction) {
  const systemPrompt = [
    '你是 Vue 2 单文件组件的修复助手。给定一份导致「构建失败」的 .vue 文件内容和构建错误信息，',
    '你只做最小必要修改使构建通过，并尽量保留用户原本的界面与功能需求。',
    '',
    '硬性规则：',
    '1. 必须输出「完整」单文件：<template>...</template> + <script>...</script> + <style scoped>...</style>，不得省略任一块。',
    '2. 常见构建错误与修复方式：',
    '   - "Expected a pseudo-class or pseudo-element"：通常是 <style> 里选择器写错或规则未闭合。检查：每个规则是否用 } 正确闭合；不要把注释或下一段规则写进上一段的 { } 内；.name-en { ... } 等必须独立闭合。',
    '   - 未闭合的 { }：为缺失的 } 补全，保证括号匹配。',
    '   - 非法选择器：不要出现孤立的冒号或错误伪类，scoped 下穿透用 >>>。',
    '3. 不得删除 template/script 结构；若错误仅在 <style>，只改 style 块。',
    '4. 直接输出修正后的完整 .vue 文件内容，不要用 ```vue 或 ``` 包裹，不要任何解释。',
    '5. 禁止使用 writing-mode: vertical-rl/lr；标题、.name-row/.name-zh/.name-en 保持横向。'
  ].join('\n')

  const userParts = [
    '失败的文件路径：',
    filePath,
    '',
    '构建错误信息：',
    (buildError || '').slice(0, 2000),
    ''
  ]
  if (userInstruction && userInstruction.trim()) {
    userParts.push('用户原始需求（修错时请尽量保留）：', userInstruction.trim(), '')
  }
  userParts.push(
    '导致构建失败的 .vue 文件完整内容：',
    '---BEGIN---',
    brokenContent,
    '---END---',
    '',
    '请只做使构建通过的最小修改，输出修正后的完整 .vue 内容（不要 markdown 代码块）。'
  )

  const userPrompt = userParts.join('\n')

  const text = await callDeepseekText(systemPrompt, userPrompt, { max_tokens: REPAIR_MAX_TOKENS })
  if (!text || typeof text !== 'string') {
    throw new Error('修复接口未返回内容')
  }

  let out = String(text).trim()
  if (/^```\s*vue\s*/i.test(out)) {
    const m = out.match(/^```\s*vue\s*([\s\S]*?)```\s*$/im)
    if (m && m[1]) out = m[1].trim()
    else out = out.replace(/^```\s*vue\s*/i, '').replace(/```\s*$/, '').trim()
  } else if (/^```\s*/.test(out)) {
    const m = out.match(/^```[a-zA-Z]*\s*([\s\S]*?)```\s*$/im)
    if (m && m[1]) out = m[1].trim()
    else out = out.replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  }

  return processVueContentStripVerticalWritingMode(out)
}

module.exports = {
  repairVueBuildError
}
