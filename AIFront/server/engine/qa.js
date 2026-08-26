/* 问答模块：针对「只聊天/提问」类输入，结合项目上下文做回答 */

const { callDeepseekJson, callDeepseekStream } = require('./shared-llm')

async function answerQuestion (question, projectInfo, context, hint) {
  const history = Array.isArray(context && context.history) ? context.history : (context && context.chatHistory) || []
  const historyText = (history || [])
    .filter(m => m && m.role && m.content)
    .slice(-12)
    .map(m => `${m.role}: ${String(m.content).slice(0, 1500)}`)
    .join('\n')

  const systemPrompt = [
    '你是一个内置在前端项目里的智能助手，负责回答开发者和最终用户的问题。',
    '项目技术栈：Vue2 + ElementUI + Vue Router。',
    '',
    '当问题与页面结构、交互或代码相关时，请结合项目上下文回答；',
    '当问题是业务/常识提问时，就像普通聊天机器人一样回答即可。',
    '请结合「近期对话历史」理解指代（例如「刚才那个」「再改一下」）。',
    '',
    '你需要输出 JSON：{ "answer": "..." }，不要额外文本。',
    '',
    '项目结构（只读）：',
    JSON.stringify(projectInfo, null, 2),
    '',
    '调用方上下文（只读）：',
    JSON.stringify(Object.assign({}, context || {}, { history: undefined, chatHistory: undefined }), null, 2),
    '',
    '近期对话历史：',
    historyText || '(无)',
    '',
    '可能的额外提示（router 的 qaHint）：',
    hint || ''
  ].join('\n')

  const userPrompt = [
    '用户提问：',
    question
  ].join('\n')

  const data = await callDeepseekJson(systemPrompt, userPrompt)
  if (!data || typeof data.answer !== 'string') {
    // 降级处理：避免直接 500，把原始结果截断后返回
    if (data && typeof data === 'object') {
      return (data.answer && String(data.answer)) ||
        `模型没有返回规范的 answer 字段，原始结果片段：${JSON.stringify(data).slice(0, 200)}`
    }
    return '模型暂时没有给出有效回答，请稍后再试。'
  }
  return data.answer
}

/**
 * 流式问答：逐块产出回答文本，用于前端实时展示
 * @param {string} question
 * @param {object} projectInfo
 * @param {object} context
 * @param {string} hint
 * @yields {string}
 */
async function * answerQuestionStream (question, projectInfo, context, hint) {
  const history = Array.isArray(context && context.history) ? context.history : (context && context.chatHistory) || []
  const historyText = (history || [])
    .filter(m => m && m.role && m.content)
    .slice(-12)
    .map(m => `${m.role}: ${String(m.content).slice(0, 1500)}`)
    .join('\n')

  const systemPrompt = [
    '你是一个内置在前端项目里的智能助手，负责回答开发者和最终用户的问题。',
    '项目技术栈：Vue2 + ElementUI + Vue Router。',
    '',
    '当问题与页面结构、交互或代码相关时，请结合项目上下文回答；',
    '当问题是业务/常识提问时，就像普通聊天机器人一样回答即可。',
    '请结合「近期对话历史」理解指代（例如「刚才那个」「再改一下」）。',
    '',
    '请直接输出回答内容，不要输出 JSON，不要用代码块包裹。',
    '',
    '项目结构（只读）：',
    JSON.stringify(projectInfo, null, 2),
    '',
    '调用方上下文（只读）：',
    JSON.stringify(Object.assign({}, context || {}, { history: undefined, chatHistory: undefined }), null, 2),
    '',
    '近期对话历史：',
    historyText || '(无)',
    '',
    '可能的额外提示（router 的 qaHint）：',
    hint || ''
  ].join('\n')

  const userPrompt = [
    '用户提问：',
    question
  ].join('\n')

  yield * callDeepseekStream(systemPrompt, userPrompt)
}

module.exports = {
  answerQuestion,
  answerQuestionStream
}

