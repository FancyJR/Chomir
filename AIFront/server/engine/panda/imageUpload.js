/**
 * 图片上传 + 多模态消息构造
 * 仅当「当前可用模型」真正支持 image_url 时才走多模态；否则只落盘 + 纯文本路径。
 */

const fsp = require('fs').promises
const path = require('path')

function uploadsDir (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'uploads')
}

function defaultChatModel () {
  return process.env.DEEPSEEK_MODEL || 'deepseek-chat'
}

/**
 * 视觉模型：仅当显式配置 DEEPSEEK_VISION_MODEL 时启用。
 * 不再默认 deepseek-vl2（很多账号/网关只开放 deepseek-v4-pro / deepseek-v4-flash）。
 */
function defaultVisionModel () {
  const v = String(process.env.DEEPSEEK_VISION_MODEL || '').trim()
  return v || ''
}

function multimodalAllowList () {
  return String(process.env.DEEPSEEK_MULTIMODAL_MODELS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 全局是否允许多模态（默认关：DeepSeek 文本 API 不支持 image_url）
 * 开启方式：
 * - DEEPSEEK_MULTIMODAL=1
 * - 或设置 DEEPSEEK_VISION_MODEL=你的视觉模型名
 * - 或 DEEPSEEK_MULTIMODAL_MODELS=model-a,model-b
 */
function isMultimodalFeatureEnabled () {
  const flag = String(process.env.DEEPSEEK_MULTIMODAL || '').trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false
  if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') return true
  if (defaultVisionModel()) return true
  if (multimodalAllowList().length) return true
  return false
}

/**
 * 当前模型是否接受 OpenAI 风格 image_url。
 * DeepSeek 文本线（chat / reasoner / v4-pro / v4-flash）默认 false。
 */
function modelSupportsMultimodal (model) {
  if (!isMultimodalFeatureEnabled()) return false
  const m = String(model || '').trim().toLowerCase()
  if (!m) return false

  // 明确文本模型
  if (/deepseek-chat|deepseek-reasoner|deepseek-r1|deepseek-v4-pro|deepseek-v4-flash/.test(m)) {
    const allow = multimodalAllowList()
    return allow.some(a => m === a || m.includes(a))
  }

  const allow = multimodalAllowList()
  if (allow.length) {
    return allow.some(a => m === a || m.includes(a))
  }

  const vision = defaultVisionModel().toLowerCase()
  if (vision && (m === vision || m.includes(vision))) return true

  // 非 DeepSeek：常见多模态族
  if (/gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-4|claude-opus|claude-sonnet|qwen-vl|qwen2-vl|qwen2\.5-vl/.test(m)) {
    return true
  }
  // deepseek-vl* 仅当显式配成 VISION_MODEL 或进了 allowlist（上面已覆盖）
  return false
}

async function saveDataUrl (projectRoot, dataUrl, nameHint) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!m) throw new Error('无效图片 dataUrl')
  const mime = m[1]
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8MB')
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const dir = uploadsDir(projectRoot)
  await fsp.mkdir(dir, { recursive: true })
  const file = (nameHint || ('paste_' + Date.now().toString(16))) + '.' + ext
  const abs = path.join(dir, file)
  await fsp.writeFile(abs, buf)
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/')
  return { abs, rel, mime, bytes: buf.length }
}

/**
 * @returns {{ message: object, model: string, saved: Array, textFallback: string, hasImages: boolean, multimodal: boolean }}
 */
async function buildMultimodalUserMessage (projectRoot, text, images) {
  const saved = []
  const content = []
  const textPart = String(text || '').trim() || '请查看图片并结合工程上下文处理我的需求。'
  content.push({ type: 'text', text: textPart })

  for (const img of (images || []).slice(0, 4)) {
    let abs = null
    let mime = img.mime || 'image/png'
    let rel = img.rel || img.path
    if (img.dataUrl) {
      const s = await saveDataUrl(projectRoot, img.dataUrl, img.name && String(img.name).replace(/\.[^.]+$/, ''))
      abs = s.abs
      rel = s.rel
      mime = s.mime
      saved.push(s)
    } else if (rel) {
      abs = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel)
      saved.push({ abs, rel, mime })
    }
    if (!abs) continue
    const b64 = (await fsp.readFile(abs)).toString('base64')
    content.push({
      type: 'image_url',
      image_url: { url: 'data:' + mime + ';base64,' + b64 }
    })
  }

  const hasImageParts = content.some(c => c.type === 'image_url')
  const vision = defaultVisionModel()
  const chat = defaultChatModel()
  // 只有视觉模型名存在且该模型被判定支持多模态时，才真正带 image_url
  const multimodal = !!(hasImageParts && vision && modelSupportsMultimodal(vision))
  const model = multimodal ? vision : chat
  const textFallback = [
    textPart,
    ...saved.map(s => '【附件图片】`' + s.rel + '`'),
    !multimodal && saved.length
      ? '（当前 API/模型不支持多模态 image_url，已保存截图文件；请根据路径与代码判断 UI，勿臆造像素。）'
      : ''
  ].filter(Boolean).join('\n')

  return {
    message: {
      role: 'user',
      content: multimodal ? content : textFallback
    },
    model,
    saved,
    textFallback,
    hasImages: hasImageParts,
    multimodal
  }
}

/** @deprecated 兼容旧调用 */
async function enrichMessageWithImages (projectRoot, message, images) {
  const built = await buildMultimodalUserMessage(projectRoot, message, images)
  return built.textFallback
}

/**
 * 用视觉模型单独描述（仅 multimodal 可用时）；否则返回路径文本。
 */
async function describeImagesAsText (projectRoot, images, hint) {
  const built = await buildMultimodalUserMessage(
    projectRoot,
    hint || '用中文详细描述这张页面截图的 UI。',
    images
  )
  if (!built.hasImages) {
    return { text: built.textFallback, saved: built.saved, description: '' }
  }
  if (!built.multimodal) {
    return { text: built.textFallback, saved: built.saved, description: '' }
  }

  let description = ''
  try {
    const { callDeepseekChat } = require('../shared-llm')
    const desc = await callDeepseekChat({
      model: built.model,
      messages: [built.message],
      max_tokens: 900,
      stream: false
    })
    description = String((desc.message && desc.message.content) || '').trim()
  } catch (e) {
    description = '（视觉模型描述失败：' + (e.message || e) + '。已保存截图文件。）'
  }

  const paths = built.saved.map(s => s.rel).filter(Boolean)
  const text = [
    built.textFallback,
    paths.length ? ('截图文件：' + paths.map(p => '`' + p + '`').join(', ')) : '',
    description ? ('【视觉描述】\n' + description) : ''
  ].filter(Boolean).join('\n\n')

  return { text, saved: built.saved, description }
}

/** 工作台模型选择器 */
function listModelsForUi () {
  const vision = defaultVisionModel()
  const allow = multimodalAllowList()
  const chat = [
    'deepseek-chat',
    'deepseek-reasoner'
  ]
  const visionModels = []
  if (vision) visionModels.push(vision)
  allow.forEach(m => {
    if (m && !visionModels.includes(m) && !chat.includes(m)) visionModels.push(m)
  })
  return {
    chat,
    vision: visionModels,
    multimodalEnabled: isMultimodalFeatureEnabled(),
    defaultVision: vision,
    hint: isMultimodalFeatureEnabled()
      ? (vision
        ? '粘贴截图时请选视觉模型：' + vision
        : '已开启多模态 allowlist：' + (allow.join(', ') || '（空）'))
      : '未配置 DEEPSEEK_VISION_MODEL / DEEPSEEK_MULTIMODAL — 粘贴图仅保存路径，模型看不见像素'
  }
}

module.exports = {
  saveDataUrl,
  buildMultimodalUserMessage,
  enrichMessageWithImages,
  describeImagesAsText,
  modelSupportsMultimodal,
  isMultimodalFeatureEnabled,
  defaultVisionModel,
  defaultChatModel,
  listModelsForUi,
  uploadsDir
}
