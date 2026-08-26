<template>
  <div class="page-dev-editor">
    <el-card class="page-card">
      <div slot="header" class="card-header">
        <div class="left">
          <span class="title">云编译器（当前工程在线编辑）</span>
          <span class="sub">仅供开发自用，左侧展示 server 与 src 下的工程文件层级结构。</span>
        </div>
      </div>

      <div class="editor-layout">
        <div class="pane pane-left" :style="{ flexBasis: leftWidth + 'px' }">
          <div class="file-list">
            <div class="file-list-title">项目文件（工程根目录）</div>
            <div v-if="filesLoading" class="file-list-empty file-list-loading">
              <i class="el-icon-loading" /> 正在加载文件列表...
            </div>
            <template v-else-if="filesLoadError">
              <div class="file-list-empty file-list-error">
                {{ filesLoadError }}
              </div>
              <el-button type="text" size="small" class="file-list-retry" @click="fetchFiles">
                重试
              </el-button>
            </template>
            <el-tree
              v-else-if="fileTree.length"
              :data="fileTree"
              node-key="id"
              :props="treeProps"
              highlight-current
              default-expand-all
              class="file-tree"
              :render-content="renderTreeNode"
              @node-click="handleNodeClick"
            />
            <div v-else class="file-list-empty">
              暂无可编辑文件（请确认后端服务已启动且工程根目录下存在 .js/.vue/.ts/.json 文件）
            </div>
          </div>
        </div>

        <div class="pane-resizer" @mousedown="startDrag('left', $event)"></div>

        <div class="pane pane-middle">
          <div class="pane-middle-inner">
            <div class="editor-panel">
              <div class="editor-header">
                <span class="editor-path">{{ currentPath || '请选择左侧文件' }}</span>
                <div class="editor-actions">
                  <el-input
                    v-model="searchText"
                    size="mini"
                    placeholder="查找"
                    class="toolbar-input"
                    @keyup.enter.native="handleFindNext"
                  />
                  <el-input
                    v-model="replaceText"
                    size="mini"
                    placeholder="替换为"
                    class="toolbar-input"
                    @keyup.enter.native="handleReplaceAll"
                  />
                  <el-button size="mini" @click="handleFindNext" :disabled="!searchText">查找</el-button>
                  <el-button size="mini" @click="handleReplaceAll" :disabled="!searchText">全部替换</el-button>
                  <el-button
                    size="mini"
                    :disabled="!currentPath || formatting"
                    :loading="formatting"
                    @click="handleFormat"
                  >
                    格式化
                  </el-button>
                </div>
              </div>
              <div v-if="loading" class="editor-loading">
                <el-spinner /> 正在加载文件内容...
              </div>
              <div v-else-if="!currentPath" class="editor-empty">
                <div class="editor-empty-title">欢迎使用云编译器</div>
                <div class="editor-empty-desc">
                  在左侧选择任意一个文件开始编辑当前工程的代码。
                </div>
                <div class="editor-empty-tips">
                  - 左边是完整的项目文件树（根目录、server、src 等）<br>
                  - 右边支持代码高亮、查找/替换、自动保存和一键格式化
                </div>
              </div>
              <codemirror
                v-else
                ref="cmEditor"
                v-model="content"
                class="editor-codemirror"
                :options="cmOptions"
                :style="{ height: '100%' }"
              />
              <div v-if="error" class="editor-error">
                {{ error }}
              </div>
            </div>

            <div v-show="showTerminal" class="terminal-panel">
              <div class="terminal-tabs">
                <div
                  v-for="tab in terminalTabs"
                  :key="tab.id"
                  :class="['terminal-tab', { active: tab.id === activeTerminalId }]"
                  @click="activeTerminalId = tab.id"
                >
                  <span class="terminal-tab-title">{{ tab.title }}</span>
                  <i
                    class="el-icon-close terminal-tab-close"
                    v-if="terminalTabs.length > 1"
                    @click.stop="closeTerminal(tab.id)"
                  />
                </div>
                <div class="terminal-tab add" @click="addTerminal">
                  <i class="el-icon-plus" />
                </div>
              </div>
              <div ref="terminalBody" class="terminal-body">
                <pre class="terminal-log">
{{ activeTerminal && activeTerminal.log ? activeTerminal.log : '在这里运行命令，例如：npm run dev' }}
                </pre>
              </div>
              <div class="terminal-input-bar">
                <el-input
                  v-model="terminalCommand"
                  size="mini"
                  placeholder="在此输入命令，例如 npm run dev（当前为本地模拟输出）"
                  @keyup.enter.native="runTerminalCommand"
                />
                <el-button size="mini" @click="runTerminalCommand">运行</el-button>
              </div>
            </div>
          </div>
        </div>

        <div class="pane-resizer" @mousedown="startDrag('right', $event)"></div>

        <div class="pane pane-right" :style="{ flexBasis: rightWidth + 'px' }">
          <div class="chat-panel">
            <div class="chat-header">
              <span class="chat-title">AI 助手 · 无代码开发</span>
              <span class="chat-sub">问答 / 生成页面 / 修改代码</span>
            </div>
            <div ref="chatBody" class="chat-body">
              <div
                v-for="(msg, idx) in chatMessages"
                :key="idx"
                class="chat-item"
                :class="`is-${msg.role}`"
              >
                <div class="chat-bubble">
                  <!-- 加速器：发送需求后实时显示 分析→规划→生成→应用 进度，减轻等待焦虑 -->
                  <div
                    v-if="msg.role === 'assistant' && msg.meta && msg.meta.progress"
                    class="engine-accelerator"
                  >
                    <span class="accelerator-label">
                      <i class="el-icon-loading" /> 加速中
                    </span>
                    <div class="accelerator-track">
                      <div
                        v-for="step in [{ n: 1, label: '分析' }, { n: 2, label: '规划' }, { n: 3, label: '生成' }, { n: 4, label: '应用' }]"
                        :key="step.n"
                        class="accelerator-step"
                        :class="{ done: (msg.meta.engineStepIndex || 0) >= step.n, current: (msg.meta.engineStepIndex || 0) === step.n - 1 }"
                      >
                        <i v-if="(msg.meta.engineStepIndex || 0) >= step.n" class="el-icon-check" />
                        <i v-else-if="(msg.meta.engineStepIndex || 0) === step.n - 1" class="el-icon-loading accelerator-step-loading" />
                        <span v-else class="step-dot" />
                        {{ step.label }}
                      </div>
                    </div>
                  </div>
                  <div v-if="msg.role === 'assistant' && msg.meta && msg.meta.kind" class="chat-tag">
                    {{ msg.meta.kind === 'qa' ? '问答' : msg.meta.kind === 'modify_existing' ? '改代码' : '生成页面' }}
                  </div>
                  <!-- AI-UI：助手消息用 Markdown + 代码高亮 + ECharts 图表渲染 -->
                  <chat-content
                    v-if="msg.role === 'assistant'"
                    :content="msg.content || ''"
                    :streaming="!!(msg.meta && msg.meta.streaming)"
                  />
                  <div v-else class="chat-text">{{ msg.content }}</div>
                  <!-- 思维引擎：推流展示思考过程 -->
                  <div v-if="msg.role === 'assistant' && msg.meta && (msg.meta.reasoningStream != null && msg.meta.reasoningStream !== '')" class="think-reasoning-stream">
                    <span class="think-reasoning-label">💭 思考过程</span>
                    <pre class="think-reasoning-pre">{{ msg.meta.reasoningStream }}</pre>
                  </div>
                  <!-- Cursor 式：在「正在生成代码」下方显示 Thinking + 流式生成过程 -->
                  <div v-if="msg.role === 'assistant' && msg.meta && msg.meta.codegenThinking" class="codegen-thinking">
                    <span class="codegen-thinking-label"><i class="el-icon-loading" /> Thinking{{ getThinkingSeconds(msg) > 0 ? ' · ' + getThinkingSeconds(msg) + 's' : '' }}</span>
                    <pre class="codegen-stream-pre"><code>{{ msg.meta.codegenStreamingContent || '' }}</code></pre>
                  </div>
                  <!-- 思考/规划/生成等待阶段：显示加载动画，避免用户以为卡住 -->
                  <div v-if="msg.role === 'assistant' && msg.meta && msg.meta.progress && !msg.meta.needsClarification" class="engine-waiting-hint">
                    <i class="el-icon-loading" />
                    <span>{{ getEngineWaitingLabel(msg) }}</span>
                  </div>
                  <div v-if="msg.meta && msg.meta.reverted" class="chat-note">
                    本次改动已回退
                  </div>
                </div>
              </div>
            </div>
            <!-- 同意/撤回 放在输入框上方，与 Cursor 一致 -->
            <div v-if="pendingChangeMessage" class="chat-actions-bar">
              <span class="chat-actions-label">有未确认的代码改动</span>
              <el-button
                size="mini"
                type="primary"
                plain
                @click="confirmChange(pendingChangeMessage)"
              >
                同意更改
              </el-button>
              <el-button
                size="mini"
                type="danger"
                plain
                :loading="pendingChangeMessage.meta && pendingChangeMessage.meta.reverting"
                @click="revertChange(pendingChangeMessage)"
              >
                回退此次更改
              </el-button>
            </div>
            <div v-if="lastMessageNeedsClarification" class="chat-clarification-hint">
              <span class="chat-clarification-hint-text">💬 请在此回答确认问题或继续输入，与思维引擎对话</span>
            </div>
            <div class="chat-input-bar">
              <el-input
                ref="chatInputRef"
                v-model="chatInput"
                class="chat-main-input"
                type="textarea"
                size="mini"
                :autosize="{ minRows: 1, maxRows: 4 }"
                resize="none"
                :placeholder="chatInputPlaceholder"
                @keyup.enter.native.exact.prevent="handleSendChat"
              />
              <div class="chat-toolbar">
                <el-select
                  v-model="agentMode"
                  size="mini"
                  class="chat-select"
                  placeholder="Agent"
                >
                  <el-option label="Panda Agent" value="default" />
                  <el-option label="Planner" value="planner" />
                  <el-option label="Q&A" value="qa_only" />
                </el-select>
                <el-select
                  v-model="chatModel"
                  size="mini"
                  class="chat-select"
                  placeholder="模型"
                >
                  <el-option label="Auto" value="deepseek-chat" />
                  <el-option label="Reasoner" value="deepseek-reasoner" />
                </el-select>
                <div class="chat-icons">
                  <el-upload
                    class="chat-icon-btn"
                    action=""
                    :auto-upload="false"
                    :file-list="chatFiles"
                    :multiple="true"
                    :show-file-list="false"
                    :on-change="handleFileChange"
                    :on-remove="handleFileRemove"
                  >
                    <i class="el-icon-picture-outline" />
                  </el-upload>
                  <i class="el-icon-mic chat-icon-btn" />
                  <el-button
                    type="primary"
                    size="mini"
                    class="chat-send-btn"
                    :loading="chatSending"
                    :disabled="!chatInput.trim()"
                    @click="handleSendChat"
                  >
                    发送
                  </el-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="status-bar">
        <div class="status-left" @click="toggleTerminal">
          <span class="status-icon">
            <i :class="showTerminal ? 'el-icon-caret-down' : 'el-icon-caret-up'" />
            <i class="el-icon-warning-outline status-icon-warning" />
          </span>
          <span class="status-text">终端</span>
        </div>
        <div class="status-right">
          <span class="status-item">Dev Editor</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script>
import ChatContent from '@/components/ChatContent.vue'

export default {
  name: 'DevEditor',
  components: { ChatContent },
  data () {
    return {
      files: [],
      fileTree: [],
      filesLoading: true,
      filesLoadError: '',
      currentPath: '',
      content: '',
      loading: false,
      saving: false,
      error: '',
      searchText: '',
      replaceText: '',
      lastSearchIndex: null,
      formatting: false,
      autoSaveTimer: null,
      chatMessages: [],
      chatInput: '',
      chatSending: false,
      agentMode: 'default',
      chatModel: 'deepseek-chat',
      chatFiles: [],
      lastTargetViewFile: '',
      pandaSessionId: '',
      leftWidth: 260,
      rightWidth: 280,
      draggingSide: null,
      dragStartX: 0,
      dragStartLeft: 0,
      dragStartRight: 0,
      showTerminal: false,
      terminalTabs: [
        { id: '1', title: '终端 1', log: '', running: false }
      ],
      activeTerminalId: '1',
      nextTerminalId: 2,
      terminalCommand: '',
      terminalTimers: Object.create(null),
      thinkingTimerTick: 0,
      thinkingTimerId: null,
      treeProps: {
        label: 'label',
        children: 'children'
      },
      cmOptions: {
        tabSize: 2,
        lineNumbers: true,
        lineWrapping: false,
        theme: 'material',
        mode: 'text/plain',
        styleActiveLine: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        autoCloseTags: true,
        extraKeys: {}
      }
    }
  },
  computed: {
    activeTerminal () {
      return this.terminalTabs.find(t => t.id === this.activeTerminalId) || this.terminalTabs[0] || null
    },
    // 最近一条可同意/回退的助手消息（用于输入框上方操作栏，与 Cursor 一致）
    pendingChangeMessage () {
      const list = this.chatMessages || []
      for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i]
        if (msg.role !== 'assistant' || !msg.meta) continue
        if (msg.meta.kind === 'qa') continue
        if (msg.meta.reverted) continue
        if (!Array.isArray(msg.meta.changed) || !msg.meta.changed.length) continue
        const hasPath = msg.meta.changed.some(c => (c.path || c.viewFile || c.file))
        if (hasPath) return msg
      }
      return null
    },
    // 最后一条助手消息是否为「需要确认」——展示再次提问/继续输入提示，与思维引擎澄清能力一致
    lastMessageNeedsClarification () {
      const list = this.chatMessages || []
      for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i]
        if (msg.role !== 'assistant') return false
        return !!(msg.meta && msg.meta.needsClarification)
      }
      return false
    },
    chatInputPlaceholder () {
      return this.lastMessageNeedsClarification
        ? '请回答上面的确认问题，或继续描述您的需求…（回车发送）'
        : 'Plan, @ for context, / for commands'
    }
  },
  created () {
    this.fetchFiles()
    // 需要在 created 里绑定 extraKeys 以访问组件 this
    this.cmOptions.extraKeys = {
      'Ctrl-Space': cm => {
        if (cm && cm.showHint) {
          cm.showHint()
        }
      }
    }
  },
  beforeDestroy () {
    Object.keys(this.terminalTimers).forEach(id => {
      clearInterval(this.terminalTimers[id])
    })
    if (this.thinkingTimerId) {
      clearInterval(this.thinkingTimerId)
      this.thinkingTimerId = null
    }
  },
  watch: {
    content () {
      this.scheduleAutoSave()
    }
  },
  methods: {
    getCodeMirror () {
      return this.$refs.cmEditor && this.$refs.cmEditor.codemirror
    },
    activeTerminalSafe () {
      return this.terminalTabs.find(t => t.id === this.activeTerminalId) || this.terminalTabs[0] || null
    },
    startDrag (side, event) {
      event.preventDefault()
      this.draggingSide = side
      this.dragStartX = event.clientX
      this.dragStartLeft = this.leftWidth
      this.dragStartRight = this.rightWidth
      document.body && (document.body.style.userSelect = 'none')
      document.body && (document.body.style.cursor = 'col-resize')
      document.addEventListener('mousemove', this.handleDragging)
      document.addEventListener('mouseup', this.stopDrag)
    },
    handleDragging (event) {
      if (!this.draggingSide) return
      const dx = event.clientX - this.dragStartX
      const minWidth = 180
      const maxWidth = this.draggingSide === 'right' ? 420 : 600
      if (this.draggingSide === 'left') {
        let next = this.dragStartLeft + dx
        if (next < minWidth) next = minWidth
        if (next > maxWidth) next = maxWidth
        this.leftWidth = next
      } else if (this.draggingSide === 'right') {
        let next = this.dragStartRight - dx
        if (next < minWidth) next = minWidth
        if (next > maxWidth) next = maxWidth
        this.rightWidth = next
      }
    },
    stopDrag () {
      if (!this.draggingSide) return
      this.draggingSide = null
      document.removeEventListener('mousemove', this.handleDragging)
      document.removeEventListener('mouseup', this.stopDrag)
      if (document.body) {
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
    },
    async fetchFiles () {
      this.filesLoadError = ''
      this.filesLoading = true
      try {
        const res = await fetch('/api/dev/files')
        const data = await res.json().catch(() => ({}))
        if (res.ok && data && Array.isArray(data.files)) {
          this.files = data.files
          this.buildFileTree(data.files)
          this.error = ''
        } else {
          this.filesLoadError = (data && data.message) || '获取文件列表失败'
        }
      } catch (e) {
        this.filesLoadError = e.message || '获取文件列表失败（请确认后端服务已启动，如 npm run server）'
      } finally {
        this.filesLoading = false
      }
    },
    buildFileTree (files) {
      const root = []
      const map = {}
      files.forEach(f => {
        const parts = f.path.split('/')
        let parent = root
        let curKey = ''
        parts.forEach((seg, idx) => {
          curKey = curKey ? `${curKey}/${seg}` : seg
          if (!map[curKey]) {
            const node = {
              id: curKey,
              label: seg,
              children: [],
              isDir: idx !== parts.length - 1
            }
            // 最后一段是文件，挂上 path 方便点击
            if (idx === parts.length - 1) {
              node.path = f.path
              node.isDir = false
              const dotIndex = f.path.lastIndexOf('.')
              if (dotIndex !== -1) {
                node.ext = f.path.slice(dotIndex + 1)
              }
            }
            map[curKey] = node
            parent.push(node)
          }
          parent = map[curKey].children
        })
      })
      // 递归排序：目录在前，之后文件，按名称排序
      const sortNodes = nodes => {
        if (!Array.isArray(nodes)) return
        nodes.sort((a, b) => {
          const aDir = !!a.isDir
          const bDir = !!b.isDir
          if (aDir !== bDir) return aDir ? -1 : 1
          return a.label.localeCompare(b.label)
        })
        nodes.forEach(n => sortNodes(n.children))
      }
      sortNodes(root)
      this.fileTree = root
    },
    renderTreeNode (h, { data }) {
      const isDir = data.isDir
      const label = data.label
      let iconClass = 'icon-file-generic'
      let iconText = ''
      if (isDir) {
        iconClass = 'icon-folder'
        iconText = ''
      } else if (data.ext === 'vue') {
        iconClass = 'icon-file-vue'
        iconText = 'V'
      } else if (data.ext === 'js' || data.ext === 'ts') {
        iconClass = 'icon-file-js'
        iconText = 'JS'
      } else if (data.ext === 'json') {
        iconClass = 'icon-file-json'
        iconText = '{}'
      }
      return h('span', { class: 'tree-node' }, [
        h('span', { class: ['file-icon', iconClass] }, iconText),
        h('span', { class: 'file-label' }, label)
      ])
    },
    handleNodeClick (data) {
      if (data && data.path) {
        this.handleSelectFile(data.path)
      }
    },
    scrollChatToBottom () {
      this.$nextTick(() => {
        const el = this.$refs.chatBody
        if (el) {
          el.scrollTop = el.scrollHeight
        }
      })
    },
    focusChatInput () {
      this.$nextTick(() => {
        const ref = this.$refs.chatInputRef
        if (!ref || !ref.$el) return
        const textarea = ref.$el.querySelector('textarea')
        if (textarea) {
          textarea.focus()
        }
      })
    },
    startThinkingTimer () {
      if (this.thinkingTimerId) return
      this.thinkingTimerId = setInterval(() => {
        const hasAny = (this.chatMessages || []).some(m => m.meta && m.meta.codegenThinking)
        if (!hasAny) {
          clearInterval(this.thinkingTimerId)
          this.thinkingTimerId = null
          return
        }
        this.thinkingTimerTick = Date.now()
      }, 500)
    },
    getThinkingSeconds (msg) {
      if (!msg.meta || msg.meta.codegenThinkingStartedAt == null) return 0
      const now = this.thinkingTimerTick || Date.now()
      return Math.floor((now - msg.meta.codegenThinkingStartedAt) / 1000)
    },
    getEngineWaitingLabel (msg) {
      const idx = (msg.meta && msg.meta.engineStepIndex != null) ? msg.meta.engineStepIndex : 0
      const labels = ['正在分析项目…', '正在规划改动…', '正在生成代码…', '正在应用改动…']
      return labels[Math.min(idx, labels.length - 1)] || '处理中…'
    },
    handleFileChange (file, fileList) {
      this.chatFiles = fileList || []
    },
    handleFileRemove (file, fileList) {
      this.chatFiles = fileList || []
    },
    toggleTerminal () {
      this.showTerminal = !this.showTerminal
    },
    addTerminal () {
      const id = String(this.nextTerminalId++)
      const tab = { id, title: `终端 ${id}`, log: '' }
      this.terminalTabs.push(tab)
      this.activeTerminalId = id
    },
    closeTerminal (id) {
      if (this.terminalTabs.length === 1) return
      const idx = this.terminalTabs.findIndex(t => t.id === id)
      if (idx === -1) return
      this.terminalTabs.splice(idx, 1)
      if (this.activeTerminalId === id) {
        const next = this.terminalTabs[idx] || this.terminalTabs[idx - 1] || this.terminalTabs[0]
        this.activeTerminalId = next.id
      }
    },
    scrollTerminalToBottom () {
      this.$nextTick(() => {
        const el = this.$refs.terminalBody
        if (el) {
          el.scrollTop = el.scrollHeight
        }
      })
    },
    pollTerminal (id) {
      if (this.terminalTimers[id]) {
        clearInterval(this.terminalTimers[id])
      }
      this.terminalTimers[id] = setInterval(async () => {
        try {
          const res = await fetch(`/api/dev/terminal/status?id=${encodeURIComponent(id)}`)
          const data = await res.json()
          const term = this.terminalTabs.find(t => t.id === id)
          if (!term) return
          if (!res.ok || !data || !data.ok) {
            term.running = false
            term.log = (term.log || '') + (term.log ? '\n' : '') + ((data && data.message) || '终端状态获取失败')
            clearInterval(this.terminalTimers[id])
            delete this.terminalTimers[id]
            this.scrollTerminalToBottom()
            return
          }
          term.log = data.log || ''
          term.running = !!data.running
          this.scrollTerminalToBottom()
          if (!term.running) {
            clearInterval(this.terminalTimers[id])
            delete this.terminalTimers[id]
          }
        } catch (e) {
          const term = this.terminalTabs.find(t => t.id === id)
          if (term) {
            term.running = false
          }
          clearInterval(this.terminalTimers[id])
          delete this.terminalTimers[id]
        }
      }, 1000)
    },
    runTerminalCommand () {
      const cmd = (this.terminalCommand || '').trim()
      if (!cmd) return
      const term = this.activeTerminal
      if (!term) return
      if (term.running) {
        term.log = (term.log || '') + (term.log ? '\n' : '') + '[该终端已有命令在运行，可新建终端窗口]'
        this.scrollTerminalToBottom()
        this.terminalCommand = ''
        return
      }
      term.log = ''
      term.running = true
      const id = term.id
      this.terminalCommand = ''
      fetch('/api/dev/terminal/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, command: cmd })
      }).then(async res => {
        const data = await res.json()
        if (!res.ok || !data || !data.ok) {
          term.running = false
          term.log = (term.log || '') + (term.log ? '\n' : '') + ((data && data.message) || '启动终端失败')
          this.scrollTerminalToBottom()
          return
        }
        this.pollTerminal(id)
      }).catch(e => {
        term.running = false
        term.log = (term.log || '') + (term.log ? '\n' : '') + (e.message || '启动终端失败')
        this.scrollTerminalToBottom()
      })
    },
    confirmChange (msg) {
      if (!msg || !msg.meta) return
      this.$set(msg.meta, 'confirmed', true)
    },
    async revertChange (msg) {
      if (!msg || !msg.meta || !Array.isArray(msg.meta.changed)) return
      const paths = msg.meta.changed
        .map(c => (c.path || c.viewFile || c.file || '').trim())
        .filter(Boolean)
      const bakFiles = paths.map(p => p.endsWith('.bak') ? p : p + '.bak')
      if (!bakFiles.length) return
      this.$set(msg.meta, 'reverting', true)
      try {
        const res = await fetch('/api/dev/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: bakFiles })
        })
        const data = await res.json()
        if (!res.ok || !data || !data.ok) {
          const m = (data && data.message) || '回退失败，请查看 server 日志'
          this.$message.error(m)
          return
        }
        this.$set(msg.meta, 'reverted', true)
        this.$message.success('本次改动已根据 .bak 备份回退')
      } catch (e) {
        this.$message.error(e.message || '回退失败')
      } finally {
        this.$set(msg.meta, 'reverting', false)
      }
    },
    async handleSendChat () {
      const text = (this.chatInput || '').trim()
      if (!text) return
      const userMsg = { role: 'user', content: text }
      this.chatMessages.push(userMsg)
      this.chatInput = ''
      this.chatSending = true
      this.scrollChatToBottom()
      try {
        const attachments = (this.chatFiles || []).map(f => ({
          name: f.name,
          size: f.size,
          type: (f.raw && f.raw.type) || ''
        }))
        const progressMsg = {
          role: 'assistant',
          content: '正在连接引擎…',
          meta: { kind: 'qa', progress: true, engineStepIndex: 0 }
        }
        this.chatMessages.push(progressMsg)
        this.scrollChatToBottom()
        const appendContent = (line) => {
          progressMsg.content = (progressMsg.content || '') + (progressMsg.content ? '\n' : '') + line
          this.$forceUpdate()
          this.$nextTick(() => this.scrollChatToBottom())
        }
        const setContent = (txt) => {
          progressMsg.content = txt
          this.$forceUpdate()
          this.$nextTick(() => this.scrollChatToBottom())
        }
        let changed = []
        const connectTimeoutMs = 90000
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), connectTimeoutMs)
        try {
          const history = (this.chatMessages || [])
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content && !(m.meta && m.meta.progress))
            .slice(-16)
            .map(m => ({
              role: m.role,
              content: String(m.content).slice(0, 4000)
            }))
          // 去掉刚 push 的当前用户句，避免与 message 重复
          if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === text) {
            history.pop()
          }
          const context = {
            activeFile: this.currentPath || '',
            note: '来源：DevEditor',
            agentMode: this.agentMode,
            model: this.chatModel,
            attachments,
            // 记忆上一轮已选中的目标视图文件，用于后续「继续优化」「再调一下」这类无页名指令
            preferredFile: this.lastTargetViewFile || '',
            // Panda / 多轮上下文：近期对话历史
            history,
            sessionId: this.pandaSessionId || (this.pandaSessionId = 'sess_' + Date.now().toString(16))
          }
          if (this.lastMessageNeedsClarification) {
            const lastAssistant = (this.chatMessages || []).slice().reverse().find(m => m.role === 'assistant')
            if (lastAssistant && lastAssistant.meta && lastAssistant.meta.originalMessage != null && lastAssistant.meta.clarificationQuestion != null) {
              context.replyToClarification = {
                originalMessage: lastAssistant.meta.originalMessage,
                clarificationQuestion: lastAssistant.meta.clarificationQuestion
              }
            }
          }
          const engineRes = await fetch('/api/engine/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              stream: true,
              context
            }),
            signal: abortController.signal
          })
          clearTimeout(timeoutId)
          if (!engineRes.ok || !engineRes.body) {
            setContent((await engineRes.json().catch(() => ({}))).message || '执行失败，请查看 server 日志')
            this.$set(progressMsg.meta, 'progress', false)
            return
          }
          const reader = engineRes.body.getReader()
          const decoder = new TextDecoder('utf-8')
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split(/\n/)
            buffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data: ')) continue
              try {
                const payload = JSON.parse(trimmed.slice(6))
                const ev = payload.event
                clearTimeout(timeoutId)
                if (ev === 'started') {
                  // 首条消息：只显示一行简短提示，其余细节交给右侧进度条展示
                  setContent(payload.message || '正在连接引擎…')
                  this.$set(progressMsg.meta, 'engineStepIndex', 0)
                } else if (ev === 'step') {
                  // 细粒度 step 事件（例如「继续规划」「判断是否满足」）不再逐条输出到气泡里，
                  // 仅通过右侧进度条展示阶段变化，避免日志过长。
                } else if (ev === 'analyze') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 1)
                  // 分析阶段：仅输出一行总结，视图/路由列表不再逐项展开
                  appendContent('\n📂 分析项目\n' + (payload.summary || ''))
                } else if (ev === 'kind') {
                  this.$set(progressMsg.meta, 'kind', payload.kind || 'qa')
                  this.$set(progressMsg.meta, 'engineStepIndex', 2)
                } else if (ev === 'think_reasoning') {
                  if (payload.reasoning) appendContent('\n💭 思考过程\n' + payload.reasoning + '\n')
                  this.$forceUpdate()
                } else if (ev === 'think_reasoning_chunk') {
                  const cur = progressMsg.meta.reasoningStream != null ? progressMsg.meta.reasoningStream : ''
                  this.$set(progressMsg.meta, 'reasoningStream', cur + (payload.chunk || ''))
                  this.$forceUpdate()
                  this.$nextTick(() => this.scrollChatToBottom())
                } else if (ev === 'clarification') {
                  this.$set(progressMsg.meta, 'needsClarification', true)
                  this.$set(progressMsg.meta, 'originalMessage', text)
                  this.$set(progressMsg.meta, 'clarificationQuestion', payload.question || '')
                  appendContent('\n❓ 需要您的确认后再执行\n')
                  this.$forceUpdate()
                } else if (ev === 'panda_round') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 2)
                  appendContent(`\n🦞 Panda 第 ${payload.round || '?'} 轮` + (payload.mode === 'plan' ? '（Plan）' : ''))
                } else if (ev === 'panda_tool_start') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 3)
                  const argPreview = payload.args ? JSON.stringify(payload.args).slice(0, 120) : ''
                  appendContent(`\n🔧 ${payload.name || 'tool'} ${argPreview}`)
                } else if (ev === 'panda_tool_end') {
                  const ok = payload.ok !== false
                  appendContent(`\n${ok ? '✓' : '✗'} ${payload.name || 'tool'} ${ok ? '' : (payload.preview || '')}`.trim())
                  if (payload.meta && payload.meta.file) {
                    this.lastTargetViewFile = payload.meta.file
                    if (payload.meta.changed && this.currentPath && (
                      this.currentPath === payload.meta.file ||
                      this.currentPath.endsWith('/' + payload.meta.file) ||
                      payload.meta.file.endsWith(this.currentPath)
                    )) {
                      // 当前打开文件被改了，尝试刷新
                      if (typeof this.loadFile === 'function') {
                        this.loadFile(this.currentPath)
                      } else if (typeof this.openFile === 'function') {
                        this.openFile(this.currentPath)
                      }
                    }
                  }
                } else if (ev === 'answer_chunk') {
                  if ((progressMsg.meta.engineStepIndex || 0) < 3) this.$set(progressMsg.meta, 'engineStepIndex', 3)
                  if (typeof payload.content === 'string') progressMsg.content += payload.content
                  this.$forceUpdate()
                  this.$nextTick(() => this.scrollChatToBottom())
                } else if (ev === 'answer_done') {
                  this.$set(progressMsg.meta, 'streaming', false)
                  this.$set(progressMsg.meta, 'engineStepIndex', 4)
                  if (progressMsg.meta.needsClarification) {
                    this.$nextTick(() => this.focusChatInput())
                  }
                } else if (ev === 'plan') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 2)
                  // 规划阶段：只展示总体摘要与首个目标页面，不再罗列所有 action 细节
                  appendContent('\n📋 规划改动\n' + (payload.summary || ''))
                  if (payload.actions && payload.actions.length) {
                    const firstModify = payload.actions.find(a => a.type === 'modify_view' && a.file && typeof a.file === 'string' && a.file.endsWith('.vue'))
                    if (firstModify && firstModify.file) {
                      this.lastTargetViewFile = firstModify.file
                      appendContent('当前目标页面：' + firstModify.file)
                    }
                  }
                } else if (ev === 'satisfaction_check') {
                  if (payload.satisfied && payload.summary) {
                    appendContent('\n✓ 已满足用户需求\n  ' + payload.summary)
                  } else if (payload.nextInstruction) {
                    appendContent('\n→ 下一步：' + (payload.nextInstruction || '').slice(0, 80) + (payload.reasoning ? '\n  ' + payload.reasoning : ''))
                  }
                  this.$forceUpdate()
                } else if (ev === 'codegen_start') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 3)
                  this.$set(progressMsg.meta, 'codegenThinking', true)
                  this.$set(progressMsg.meta, 'codegenThinkingStartedAt', Date.now())
                  this.$set(progressMsg.meta, 'codegenStreamingContent', '')
                  this.startThinkingTimer()
                  // 代码生成阶段：只输出一行简短提示，具体 diff 通过代码预览或文件跳转查看
                  appendContent('\n📝 ' + (payload.summary || '正在生成代码…') + (payload.count ? `（共 ${payload.count} 项）` : ''))
                } else if (ev === 'codegen_chunk') {
                  if (typeof payload.chunk === 'string') {
                    if (!progressMsg.meta.codegenThinking) {
                      this.$set(progressMsg.meta, 'codegenThinking', true)
                      this.$set(progressMsg.meta, 'codegenThinkingStartedAt', progressMsg.meta.codegenThinkingStartedAt || Date.now())
                      this.startThinkingTimer()
                    }
                    const cur = progressMsg.meta.codegenStreamingContent != null ? progressMsg.meta.codegenStreamingContent : ''
                    this.$set(progressMsg.meta, 'codegenStreamingContent', cur + payload.chunk)
                    this.$forceUpdate()
                    this.$nextTick(() => this.scrollChatToBottom())
                  }
                } else if (ev === 'codegen_skipped') {
                  this.$set(progressMsg.meta, 'codegenThinking', false)
                  appendContent('\n⏭ 已跳过（样式保护）：' + (payload.file || '') + (payload.message ? '\n  ' + payload.message : ''))
                } else if (ev === 'codegen_file') {
                  this.$set(progressMsg.meta, 'codegenThinking', false)
                  this.$set(progressMsg.meta, 'engineStepIndex', 3)
                  // 生成结果：只提示生成了哪个文件，不再在聊天气泡里展开大段代码
                  appendContent('\n📝 生成代码：' + (payload.file || payload.viewName || ''))
                } else if (ev === 'apply') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 4)
                  const ok = payload && (payload.buildOk !== false)
                  if (ok) {
                    // 构建通过：正常展示应用结果
                    appendContent('\n✅ 应用结果\n' + (payload.summary || ''))
                  } else {
                    // 构建失败：明确提示失败原因与自动回滚，避免用户误以为卡住或成功
                    const err = (payload.buildError || '').slice(0, 300)
                    let text = '\n❌ 应用失败\n' + (payload.summary || '构建失败，本次改动已自动回滚，不影响当前运行页面。')
                    if (err) {
                      text += '\n\n构建错误（截断展示）：\n' + err
                    }
                    appendContent(text)
                    if (this.$message) {
                      this.$message.error('本次改动构建失败，已自动回滚，详情见上方日志。')
                    }
                  }
                } else if (ev === 'done') {
                  this.$set(progressMsg.meta, 'engineStepIndex', 4)
                  changed = payload.changed || []
                } else if (ev === 'error') appendContent('\n❌ ' + (payload.message || '执行失败'))
              } catch (e) { /* ignore */ }
            }
          }
          const tailLines = buffer.split(/\n/).map(l => l.trim()).filter(l => l.startsWith('data: '))
          for (const line of tailLines) {
            try {
              const payload = JSON.parse(line.slice(6))
              if (payload.event === 'done') changed = payload.changed || []
              if (payload.event === 'error') appendContent('\n❌ ' + (payload.message || '执行失败'))
            } catch (e) {}
          }
          clearTimeout(timeoutId)
          this.$set(progressMsg.meta, 'progress', false)
          this.$set(progressMsg.meta, 'changed', changed)
          this.scrollChatToBottom()
        } catch (e) {
          clearTimeout(timeoutId)
          const isAbort = e && e.name === 'AbortError'
          setContent(isAbort ? '连接超时（90 秒内未收到数据），请确认后端已启动：npm run server' : (e.message || '请求失败，请检查本地服务'))
          this.$set(progressMsg.meta, 'progress', false)
        }
        if (Array.isArray(changed) && changed.length) {
          const candidates = changed.map(f => f.path || f.viewFile || f.file || '').filter(Boolean)
          const vueFile = candidates.find(p => p.endsWith('.vue'))
          const p = vueFile || candidates[0]
          if (p) this.handleSelectFile(p)
        }
        this.scrollChatToBottom()
      } catch (e) {
        this.chatMessages.push({
          role: 'assistant',
          content: e.message || '请求失败，请检查本地服务',
          meta: { kind: 'error' }
        })
        this.scrollChatToBottom()
      } finally {
        this.chatSending = false
      }
    },
    scheduleAutoSave () {
      if (!this.currentPath) return
      if (this.autoSaveTimer) {
        clearTimeout(this.autoSaveTimer)
      }
      // 简单防抖：停止输入 1 秒后自动保存
      this.autoSaveTimer = setTimeout(() => {
        this.handleSave(true)
      }, 1000)
    },
    handleFindNext () {
      const cm = this.getCodeMirror()
      if (!cm || !this.searchText) return
      const doc = cm.getDoc()
      const text = doc.getValue()
      if (!text) return
      const target = this.searchText
      let fromIndex = typeof this.lastSearchIndex === 'number' ? this.lastSearchIndex + 1 : 0
      let idx = text.indexOf(target, fromIndex)
      if (idx === -1 && fromIndex > 0) {
        idx = text.indexOf(target, 0)
      }
      if (idx === -1) return
      const from = cm.posFromIndex(idx)
      const to = cm.posFromIndex(idx + target.length)
      doc.setSelection(from, to)
      cm.scrollIntoView({ from, to }, 100)
      this.lastSearchIndex = idx
    },
    handleReplaceAll () {
      const cm = this.getCodeMirror()
      if (!cm || !this.searchText) return
      const doc = cm.getDoc()
      const text = doc.getValue()
      if (!text) return
      const replaced = text.split(this.searchText).join(this.replaceText || '')
      if (replaced !== text) {
        doc.setValue(replaced)
        this.content = replaced
        this.lastSearchIndex = null
      }
    },
    async handleFormat () {
      if (!this.currentPath || !this.content) return
      this.formatting = true
      this.error = ''
      try {
        const res = await fetch('/api/dev/format', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: this.currentPath,
            content: this.content
          })
        })
        const data = await res.json()
        if (!res.ok || !data || !data.ok) {
          const msg = (data && data.message) || '格式化失败'
          this.error = msg
          this.$message.error(msg)
        } else if (typeof data.content === 'string') {
          this.content = data.content
          const cm = this.getCodeMirror()
          if (cm) {
            cm.getDoc().setValue(data.content)
          }
          this.$message.success('格式化完成')
        }
      } catch (e) {
        this.error = e.message || '格式化失败'
        this.$message.error(this.error)
      } finally {
        this.formatting = false
      }
    },
    async handleSelectFile (path) {
      this.currentPath = path
      this.error = ''
      this.loading = true
      try {
        const res = await fetch(`/api/dev/file?path=${encodeURIComponent(path)}`)
        const data = await res.json()
        if (res.ok && data && typeof data.content === 'string') {
          this.content = data.content
          // 根据文件后缀动态设置高亮模式
          const ext = path.split('.').pop()
          if (ext === 'vue') {
            this.cmOptions.mode = 'text/x-vue'
          } else if (ext === 'js' || ext === 'ts') {
            this.cmOptions.mode = 'javascript'
          } else if (ext === 'json') {
            this.cmOptions.mode = 'application/json'
          } else if (ext === 'css' || ext === 'scss' || ext === 'less') {
            this.cmOptions.mode = 'css'
          } else if (ext === 'html') {
            this.cmOptions.mode = 'htmlmixed'
          } else {
            this.cmOptions.mode = 'text/plain'
          }
        } else {
          this.content = ''
          this.error = (data && data.message) || '读取文件失败'
        }
      } catch (e) {
        this.content = ''
        this.error = e.message || '读取文件失败'
      } finally {
        this.loading = false
      }
    },
    async handleSave (silent) {
      if (!this.currentPath) return
      this.saving = true
      this.error = ''
      try {
        const res = await fetch('/api/dev/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: this.currentPath,
            content: this.content
          })
        })
        const data = await res.json()
        if (!res.ok || !data || !data.ok) {
          this.error = (data && data.message) || '保存失败'
          this.$message.error(this.error)
        } else {
          if (!silent) {
            this.$message.success('保存成功（已写入服务器文件，并自动备份 .bak）')
          }
        }
      } catch (e) {
        this.error = e.message || '保存失败'
        this.$message.error(this.error)
      } finally {
        this.saving = false
      }
    }
  }
}
</script>

<style scoped>
.page-dev-editor {
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
  flex-direction: column;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.sub {
  font-size: 12px;
  color: #8c8c8c;
  margin-top: 4px;
}

.editor-layout {
  margin-top: 8px;
  display: flex;
  height: 700px;
}

.pane {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pane-left {
  flex-shrink: 0;
  min-width: 200px;
  overflow: hidden;
}

.pane-middle {
  flex: 1 1 auto;
  min-width: 320px;
  min-height: 0;
}

.pane-middle-inner {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-resizer {
  flex: 0 0 4px;
  cursor: col-resize;
  background: transparent;
}

.pane-resizer:hover {
  background: #e4e7ed;
}

.file-list {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fff;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.file-list-title {
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid #ebeef5;
  background: #fafafa;
}

.file-tree {
  flex: 1;
  padding: 4px 0;
  overflow: auto;
}

.file-list-empty {
  padding: 12px;
  font-size: 12px;
  color: #909399;
}

.file-list-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.file-list-error {
  color: #f56c6c;
}

.file-list-retry {
  margin: 0 12px 8px;
  padding: 0 8px;
}

.editor-panel {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fff;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #ebeef5;
  background: #fafafa;
}

.editor-path {
  font-size: 12px;
  color: #606266;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-input {
  width: 130px;
}

.editor-textarea {
  flex: 1;
  width: 100%;
  border: none;
  padding: 10px;
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: none;
  outline: none;
  box-sizing: border-box;
}

.editor-codemirror {
  flex: 1;
  min-height: 0;
  border: none;
  height: 100%;
}

.editor-codemirror >>> .CodeMirror {
  height: 100%;
  font-size: 12px;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #909399;
  font-size: 13px;
  text-align: center;
}

.editor-empty-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}

.editor-empty-desc {
  margin-bottom: 8px;
}

.editor-empty-tips {
  line-height: 1.8;
}

.chat-panel {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fff;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-header {
  padding: 8px 10px;
  border-bottom: 1px solid #ebeef5;
  background: #fafafa;
}

.chat-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.chat-sub {
  display: block;
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

.chat-body {
  flex: 1 1 0;
  min-height: 0;
  height: 0;
  padding: 8px 10px;
  overflow-y: auto;
  overflow-x: hidden;
  background: #fff;
  -webkit-overflow-scrolling: touch;
}

.chat-item {
  margin-bottom: 8px;
  display: flex;
}

.chat-item.is-user {
  justify-content: flex-end;
}

.chat-item.is-assistant {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 100%;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.6;
}

.chat-item.is-user .chat-bubble {
  background: #409eff;
  color: #fff;
}

.chat-item.is-assistant .chat-bubble {
  background: #f5f7fa;
  color: #303133;
}

.chat-tag {
  font-size: 11px;
  color: #909399;
  margin-bottom: 2px;
}

/* 加速器：游戏式进度条，发送需求后立即显示各阶段 */
.engine-accelerator {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: linear-gradient(135deg, #e8f4ff 0%, #f0f7ff 100%);
  border: 1px solid #b3d8ff;
  border-radius: 6px;
  font-size: 11px;
}
.accelerator-label {
  color: #409eff;
  font-weight: 600;
  white-space: nowrap;
}
.accelerator-label .el-icon-loading {
  margin-right: 4px;
  font-size: 12px;
}
.accelerator-track {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.accelerator-step {
  display: flex;
  align-items: center;
  gap: 3px;
  color: #909399;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.2s, background 0.2s;
}
.accelerator-step.current {
  color: #409eff;
  background: rgba(64, 158, 255, 0.12);
  animation: accelerator-pulse 1s ease-in-out infinite;
}
.accelerator-step.done {
  color: #67c23a;
}
.accelerator-step.done .el-icon-check {
  font-size: 12px;
}
.accelerator-step .step-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c0c4cc;
}
.accelerator-step.current .step-dot {
  background: #409eff;
}
.accelerator-step-loading {
  font-size: 12px;
  margin-right: 2px;
}
@keyframes accelerator-pulse {
  50% { opacity: 0.85; }
}
.engine-waiting-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: #0369a1;
  background: rgba(3, 105, 161, 0.08);
  border-radius: 6px;
}
.engine-waiting-hint .el-icon-loading {
  font-size: 14px;
}

/* 思维引擎：推流展示思考过程 */
.think-reasoning-stream {
  margin: 8px 0;
  padding: 10px 12px;
  background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%);
  border: 1px solid #fde047;
  border-radius: 8px;
}
.think-reasoning-label {
  display: block;
  font-size: 12px;
  color: #854d0e;
  font-weight: 600;
  margin-bottom: 6px;
}
.think-reasoning-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  background: #1c1917;
  color: #e7e5e4;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Cursor 式：Thinking + 流式代码过程 */
.codegen-thinking {
  margin: 8px 0;
  padding: 10px 12px;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #bae6fd;
  border-radius: 8px;
}
.codegen-thinking-label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: #0369a1;
  font-weight: 600;
  margin-bottom: 8px;
}
.codegen-thinking-label .el-icon-loading {
  margin-right: 6px;
  font-size: 14px;
}
.codegen-stream-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 280px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.4;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
}
.codegen-stream-pre code {
  background: none;
  padding: 0;
}

.chat-text {
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

.chat-actions-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: #f0f7ff;
  border-top: 1px solid #dcdfe6;
  font-size: 12px;
}
.chat-actions-bar .chat-actions-label {
  color: #606266;
  margin-right: auto;
}
.chat-clarification-hint {
  padding: 6px 10px;
  background: #f0f9ff;
  border-top: 1px solid #e0f2fe;
}
.chat-clarification-hint-text {
  font-size: 12px;
  color: #0369a1;
}
.chat-input-bar {
  border-top: 1px solid #ebeef5;
  padding: 6px 8px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-select {
  width: 100px;
}

.chat-main-input {
  flex: 1;
}

.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-main-input >>> .el-textarea__inner {
  min-height: 28px;
  line-height: 1.6;
}

.chat-icons {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.chat-icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid #dcdfe6;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #909399;
  cursor: pointer;
}

.chat-icon-btn:hover {
  color: #409eff;
  border-color: #409eff;
}

.chat-send-btn {
  padding: 0 10px;
}

.chat-actions-inline {
  margin-top: 4px;
  display: flex;
  gap: 6px;
}

.chat-note {
  margin-top: 4px;
  font-size: 11px;
  color: #67c23a;
}

.terminal-panel {
  flex: 0 0 180px;
  margin-top: 8px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #1e1e1e;
  color: #e5e5e5;
  display: flex;
  flex-direction: column;
  font-size: 12px;
}

.terminal-tabs {
  display: flex;
  align-items: center;
  height: 28px;
  border-bottom: 1px solid #2d2d2d;
}

.terminal-tab {
  padding: 0 10px;
  display: flex;
  align-items: center;
  cursor: pointer;
  color: #ccc;
  border-right: 1px solid #2d2d2d;
}

.terminal-tab.active {
  background: #252526;
  color: #fff;
}

.terminal-tab.add {
  border-right: none;
}

.terminal-tab-title {
  margin-right: 4px;
}

.terminal-tab-close {
  font-size: 10px;
}

.terminal-body {
  flex: 1;
  padding: 6px 8px;
  overflow-y: auto;
}

.terminal-log {
  margin: 0;
  white-space: pre-wrap;
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
}

.terminal-input-bar {
  padding: 6px 8px;
  border-top: 1px solid #2d2d2d;
  display: flex;
  align-items: center;
  gap: 6px;
}

.terminal-input-bar .el-input {
  flex: 1;
}

.status-bar {
  margin-top: 8px;
  height: 26px;
  background: #f5f7fa;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  font-size: 12px;
  color: #606266;
}

.status-left {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.status-icon {
  display: inline-flex;
  align-items: center;
  margin-right: 4px;
}

.status-icon-warning {
  margin-left: 2px;
}

.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-item {
  color: #909399;
}

.tree-node {
  display: inline-flex;
  align-items: center;
}

.file-icon {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  margin-right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.icon-folder {
  background: linear-gradient(135deg, #ffe7a3, #ffbb66);
}

.icon-file-vue {
  background: linear-gradient(135deg, #8fd58a, #5ec8b5);
}

.icon-file-js {
  background: linear-gradient(135deg, #fff2a1, #ffcd7a);
  color: #333;
}

.icon-file-json {
  background: linear-gradient(135deg, #a6c8ff, #8ea8ff);
}

.icon-file-generic {
  background: #d9d9d9;
}

.editor-loading {
  padding: 12px;
  font-size: 12px;
  color: #606266;
}

.editor-error {
  padding: 6px 10px;
  font-size: 12px;
  color: #f56c6c;
  border-top: 1px solid #fde2e2;
  background: #fef0f0;
}
</style>

<!-- 额外的全局样式，确保自定义文件类型图标一定显示出来 -->
<style>
.page-dev-editor .file-icon {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  margin-right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
}
.page-dev-editor .icon-folder {
  background: linear-gradient(135deg, #ffe7a3, #ffbb66);
}
.page-dev-editor .icon-file-vue {
  background: linear-gradient(135deg, #8fd58a, #5ec8b5);
}
.page-dev-editor .icon-file-js {
  background: linear-gradient(135deg, #fff2a1, #ffcd7a);
  color: #333;
}
.page-dev-editor .icon-file-json {
  background: linear-gradient(135deg, #a6c8ff, #8ea8ff);
}
.page-dev-editor .icon-file-generic {
  background: #d9d9d9;
}
</style>

