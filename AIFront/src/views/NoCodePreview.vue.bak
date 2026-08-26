<template>
  <div class="page-no-code-preview">
    <el-card class="page-card">
      <div slot="header" class="card-header">
        <div class="left">
          <span class="title">页面预览</span>
          <span class="sub" v-if="page"> {{ page.name }} </span>
        </div>
        <div class="right">
          <el-button size="small" @click="handleBack">返回</el-button>
          <el-button size="small" type="text" @click="handleCopyLink">复制链接</el-button>
          <el-button size="small" type="primary" @click="handleOpenNewWindow">新窗口打开</el-button>
        </div>
      </div>

      <div v-if="!page" class="empty">
        <el-empty description="未找到对应的生成记录，请返回重新生成。" />
      </div>

      <div v-else class="preview-wrap">
        <iframe class="preview-iframe" :srcdoc="srcdoc" frameborder="0" />
      </div>
    </el-card>
  </div>
</template>

<script>
import { getNoCodePage } from '@/utils/nocodeStorage'

export default {
  name: 'NoCodePreview',
  data () {
    return {
      page: null,
      srcdoc: ''
    }
  },
  created () {
    this.load()
  },
  watch: {
    '$route.params.id' () {
      this.load()
    }
  },
  methods: {
    load () {
      const id = this.$route.params.id
      const page = getNoCodePage(id)
      this.page = page
      this.srcdoc = page ? this.buildSrcdoc(page) : ''
      // 尝试设置当前窗口标题
      if (page && page.name) {
        document.title = `预览 - ${page.name}`
      }
    },
    buildSrcdoc (page) {
      const css = (page.css || '').trim()
      const html = (page.html || '').trim()
      const vueCode = (page.vueCode || '').trim()
      const title = page.name || '页面预览'
      const scriptEnd = '</' + 'script>'
      const hasVueCode = vueCode && vueCode.includes('<template>') && vueCode.includes(scriptEnd)
      const htmlIsPlaceholder = !html || html.length < 120 || /^<div\s+id=["']?app["']?\s*>\s*<\/div>\s*$/i.test(html.replace(/\s+/g, ' '))
      if (hasVueCode && (!html || htmlIsPlaceholder)) {
        return this.buildSrcdocFromVueCode(title, vueCode, css)
      }
      if (html && !htmlIsPlaceholder) {
        return this.buildSrcdocHtmlOnly(title, html, css)
      }
      if (hasVueCode) {
        return this.buildSrcdocFromVueCode(title, vueCode, css)
      }
      return this.buildSrcdocHtmlOnly(title, '<div style="padding:24px;color:#666;font-size:14px;">本次生成未包含可预览内容。</div>', css)
    },
    buildSrcdocHtmlOnly (title, html, css) {
      const safeTitle = this.escape(title || '页面预览')
      return `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <link rel="stylesheet" href="https://unpkg.com/element-ui@2.15.14/lib/theme-chalk/index.css" />
    <style>${css}</style>
  </head>
  <body style="margin:0;min-height:100%;">
    ${html}
  </body>
</html>
      `.trim()
    },
    buildSrcdocFromVueCode (title, vueCode, extraCss) {
      const scriptClose = '<' + '/script>'
      const reTemplate = /<template[^>]*>([\s\S]*?)<\/template>/i
      const reScript = new RegExp('<script[^>]*>([\\s\\S]*?)' + scriptClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const reStyle = /<style[^>]*>([\s\S]*?)<\/style>/i
      const templateMatch = vueCode.match(reTemplate)
      const scriptMatch = vueCode.match(reScript)
      const styleMatch = vueCode.match(reStyle)
      const template = (templateMatch && templateMatch[1] ? templateMatch[1].trim() : '') || '<div>无模板</div>'
      let scriptBody = (scriptMatch && scriptMatch[1] ? scriptMatch[1].trim() : '') || '{}'
      const styleContent = (styleMatch && styleMatch[1] ? styleMatch[1].trim() : '') || ''
      scriptBody = scriptBody.replace(/^\s*import\s+[\s\S]*?['"]\s*;?\s*$/gm, '').replace(/\bexport\s+default\s+/, 'window.__VUE_COMPONENT__ = ')
      const scriptEscaped = scriptBody.replace(new RegExp(scriptClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<\\/script>')
      let templateEscaped = template
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(new RegExp(scriptClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '\\x3c/script>')
      const safeTitle = this.escape(title || '页面预览')
      const parts = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
        '<title>', safeTitle, '</title>',
        '<link rel="stylesheet" href="https://unpkg.com/element-ui@2.15.14/lib/theme-chalk/index.css"/><style>', styleContent, '</style><style>', extraCss, '</style></head>',
        '<body style="margin:0;min-height:100%;"><div id="app"></div>',
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/vue/2.7.16/vue.min.js">', scriptClose,
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/element-ui/2.15.14/index.js">', scriptClose,
        '<script>window.__VUE_TEMPLATE__ = \'', templateEscaped, '\';', scriptClose,
        '<script>', scriptEscaped, scriptClose,
        '<script>(function(){if(typeof Vue==="undefined"||typeof ELEMENT==="undefined")return;Vue.use(ELEMENT);var opts=window.__VUE_COMPONENT__||{};new Vue(Object.assign({},opts,{el:"#app",template:window.__VUE_TEMPLATE__}));})();', scriptClose,
        '</body></html>'
      ]
      return parts.join('')
    },
    escape (s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    },
    handleBack () {
      this.$router.push('/no-code')
    },
    handleOpenNewWindow () {
      const id = this.$route.params.id
      const url = `${window.location.origin}/no-code/preview/${id}`
      window.open(url, '_blank')
    },
    handleCopyLink () {
      const id = this.$route.params.id
      const url = `${window.location.origin}/no-code/preview/${id}`
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          this.$message.success('已复制预览链接')
        })
      } else {
        const input = document.createElement('input')
        input.value = url
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        document.body.removeChild(input)
        this.$message.success('已复制预览链接')
      }
    }
  }
}
</script>

<style scoped>
.page-no-code-preview {
  padding: 10px;
}

.page-card {
  border-radius: 4px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.sub {
  font-size: 12px;
  color: #8c8c8c;
}

.preview-wrap {
  height: calc(100vh - 210px);
  min-height: 560px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}

.preview-iframe {
  width: 100%;
  height: 100%;
}

.empty {
  padding: 40px 0;
}
</style>

