<template>
  <div class="chat-content">
    <!-- 流式输出时仅展示纯文本 + 光标，避免解析闪烁 -->
    <template v-if="streaming">
      <span class="chat-text-plain">{{ content }}</span>
      <span class="chat-stream-cursor">|</span>
    </template>
    <!-- 稳定后：Markdown 段落 + 代码块（高亮）+ 图表（ECharts） -->
    <template v-else>
      <template v-for="(seg, idx) in segments">
        <div
          v-if="seg.type === 'md'"
          :key="'md-' + idx"
          class="chat-md"
          v-html="seg.html"
        />
        <div
          v-else-if="seg.type === 'code'"
          :key="'code-' + idx"
          class="chat-code-wrap"
        >
          <span v-if="seg.lang" class="chat-code-lang">{{ seg.lang }}</span>
          <pre class="chat-code-pre"><code class="hljs" v-html="seg.highlighted"></code></pre>
        </div>
        <div
          v-else-if="seg.type === 'chart'"
          :key="'chart-' + idx"
          class="chat-chart-wrap"
        >
          <div :ref="'chart' + idx" class="chat-chart-container" />
        </div>
      </template>
    </template>
  </div>
</template>

<script>
import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import DOMPurify from 'dompurify'
import * as echarts from 'echarts'

// 引擎输出使用：单换行转 <br>，GFM 表格/列表
marked.setOptions({ breaks: true, gfm: true })

// 仅允许的标签，用于 Markdown 输出安全
const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'span', 'div']

function sanitize (html) {
  if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ['href', 'target', 'rel'] })
  }
  return html
}

function highlightCode (code, lang) {
  try {
    if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return hljs.highlightAuto(code).value
  } catch (e) {
    return hljs.highlight(code, { language: 'plaintext' }).value
  }
}

// 判断是否为 ECharts 配置（JSON 且含 xAxis/series 或 title + series）
function isEChartsOption (code, lang) {
  const lower = (code || '').trim()
  if (lang === 'echarts' || lang === 'chart') return true
  if (lang !== 'json' && lang !== 'javascript' && lang !== 'js') return false
  return (lower.includes('"xAxis"') || lower.includes("'xAxis'")) &&
    (lower.includes('"series"') || lower.includes("'series'")) ||
    ((lower.includes('"title"') || lower.includes('"series"')) && lower.startsWith('{'))
}

/** 将引擎进度/结果文案转为 Markdown，便于 ChatContent 渲染为标题、列表等 */
function engineOutputToMarkdown (raw) {
  if (!raw || typeof raw !== 'string') return raw
  let s = raw
  // 行首 "· " 或 "  · " 转为 Markdown 列表
  s = s.replace(/\n\s*·\s+/g, '\n- ')
  // 引擎阶段标题（📂📋📝✅❌⏭ 开头的一行）转为三级标题
  s = s.replace(/\n(📂\s*[^\n]+)/g, '\n\n### $1\n')
  s = s.replace(/\n(📋\s*[^\n]+)/g, '\n\n### $1\n')
  s = s.replace(/\n(📝\s*[^\n]+)/g, '\n\n### $1\n')
  s = s.replace(/\n(✅\s*[^\n]+)/g, '\n\n### $1\n')
  s = s.replace(/\n(❌\s*[^\n]+)/g, '\n\n### $1\n')
  s = s.replace(/\n(⏭\s*[^\n]+)/g, '\n\n### $1\n')
  // 无 bullet 的引擎行也转为列表
  s = s.replace(/\n(修改\s+[^\n]+)/g, '\n- $1')
  s = s.replace(/\n(生成第\s+[^\n]+)/g, '\n- $1')
  s = s.replace(/\n(已扫描[^\n]+)/g, '\n- $1')
  s = s.replace(/\n(视图：[^\n]+)/g, '\n- $1')
  s = s.replace(/\n(路由：[^\n]+)/g, '\n- $1')
  s = s.replace(/\n(识别意图[^\n]*)/g, '\n- $1')
  s = s.replace(/\n(规划具体[^\n]*)/g, '\n- $1')
  // 首行「引擎已连接…」加粗
  s = s.replace(/^(\s*引擎已连接[^\n]*)/m, '**$1**')
  // 文件路径 `src/views/xxx.vue` 用行内代码展示
  s = s.replace(/\b(src\/[\w/-]+\.(vue|js|ts))\b/g, '`$1`')
  return s
}

function parseContent (raw) {
  const segments = []
  if (!raw || typeof raw !== 'string') return segments
  const normalized = engineOutputToMarkdown(raw)
  const re = /```(\w*)\n?([\s\S]*?)```/g
  let lastEnd = 0
  let m
  while ((m = re.exec(normalized)) !== null) {
    const before = normalized.slice(lastEnd, m.index).trim()
    if (before) {
      const html = sanitize(marked(before))
      if (html) segments.push({ type: 'md', html })
    }
    const lang = (m[1] || '').toLowerCase()
    const code = m[2].replace(/\n$/, '')
    if (isEChartsOption(code, lang)) {
      try {
        const option = typeof code === 'string' ? JSON.parse(code) : code
        segments.push({ type: 'chart', option })
      } catch (e) {
        segments.push({ type: 'code', lang: lang || 'json', code, highlighted: highlightCode(code, lang || 'json') })
      }
    } else {
      const langHint = lang || 'plaintext'
      segments.push({ type: 'code', lang: langHint, code, highlighted: highlightCode(code, langHint) })
    }
    lastEnd = re.lastIndex
  }
  const rest = normalized.slice(lastEnd).trim()
  if (rest) {
    const html = sanitize(marked(rest))
    if (html) segments.push({ type: 'md', html })
  }
  return segments
}

export default {
  name: 'ChatContent',
  props: {
    content: { type: String, default: '' },
    streaming: { type: Boolean, default: false }
  },
  data () {
    return {
      segments: [],
      chartInstances: []
    }
  },
  watch: {
    content (v) {
      if (!this.streaming) this.segments = parseContent(v || '')
    },
    streaming (v) {
      if (!v && this.content) this.segments = parseContent(this.content)
    }
  },
  mounted () {
    if (!this.streaming && this.content) this.segments = parseContent(this.content)
    this.$nextTick(() => this.initCharts())
  },
  updated () {
    this.$nextTick(() => this.initCharts())
  },
  beforeDestroy () {
    this.chartInstances.forEach(inst => {
      if (inst && inst.dispose) inst.dispose()
    })
    this.chartInstances = []
  },
  methods: {
    initCharts () {
      this.chartInstances.forEach(inst => {
        if (inst && typeof inst.dispose === 'function') inst.dispose()
      })
      this.chartInstances = []
      this.segments.forEach((seg, idx) => {
        if (seg.type !== 'chart' || !seg.option) return
        const ref = this.$refs['chart' + idx]
        const el = Array.isArray(ref) ? ref[0] : ref
        if (!el) return
        const dom = el.$el || el
        if (!dom || typeof dom.appendChild !== 'function') return
        const chart = echarts.init(dom)
        chart.setOption(seg.option)
        this.chartInstances[idx] = chart
      })
    }
  }
}
</script>

<style scoped>
.chat-content {
  word-break: break-word;
}
.chat-text-plain {
  white-space: pre-wrap;
}
.chat-stream-cursor {
  display: inline-block;
  animation: chat-cursor-blink 0.8s step-end infinite;
  color: #409eff;
  margin-left: 1px;
}
@keyframes chat-cursor-blink {
  50% { opacity: 0; }
}

.chat-md >>> p { margin: 0.4em 0; }
.chat-md >>> p:first-child { margin-top: 0; }
.chat-md >>> p:last-child { margin-bottom: 0; }
.chat-md >>> ul, .chat-md >>> ol { margin: 0.5em 0; padding-left: 1.4em; line-height: 1.5; }
.chat-md >>> ul li { margin: 0.25em 0; }
.chat-md >>> code { background: #e8f4ff; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; color: #206bc4; }
.chat-md >>> pre { margin: 0.5em 0; }
.chat-md >>> h1, .chat-md >>> h2, .chat-md >>> h3 { margin: 0.75em 0 0.35em; font-size: 1.05em; font-weight: 600; color: #303133; }
.chat-md >>> h3 { padding: 4px 0; border-bottom: 1px solid #e4e7ed; }
.chat-md >>> a { color: #409eff; }
.chat-md >>> blockquote { border-left: 3px solid #ddd; margin: 0.4em 0; padding-left: 8px; color: #666; }
.chat-md >>> strong { font-weight: 600; }

.chat-code-wrap {
  margin: 6px 0;
  border-radius: 4px;
  overflow: hidden;
  background: #282c34;
  border: 1px solid #e2e8f0;
  max-height: 360px;
  display: flex;
  flex-direction: column;
}
.chat-code-lang {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  color: #909399;
  background: #21252b;
  flex-shrink: 0;
}
.chat-code-pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
  flex: 1;
  min-height: 0;
}
.chat-code-pre code {
  background: none;
  padding: 0;
  color: #abb2bf;
}

.chat-chart-wrap {
  margin: 8px 0;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  background: #fff;
}
.chat-chart-container {
  width: 100%;
  height: 220px;
  min-height: 180px;
}
</style>

<style>
/* highlight.js 主题：与 chat 深色代码块一致 */
.chat-content .hljs { background: transparent; }
</style>
