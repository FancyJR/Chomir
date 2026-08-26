<template>
  <div class="page-orchestration">
    <!-- 顶部工具栏 -->
    <div class="orch-toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">
          <i class="el-icon-connection"></i>
          编排设计器
        </span>
        <el-divider direction="vertical" />
        <el-input
          v-model="flowName"
          size="small"
          placeholder="编排名称"
          class="flow-name-input"
        />
      </div>
      <div class="toolbar-right">
        <el-button size="small" icon="el-icon-refresh-left" :disabled="!undoStack.length" @click="undo">撤销</el-button>
        <el-button size="small" icon="el-icon-refresh-right" :disabled="!redoStack.length" @click="redo">重做</el-button>
        <el-divider direction="vertical" />
        <el-button size="small" icon="el-icon-refresh" @click="resetCanvas">重置画布</el-button>
        <el-button size="small" icon="el-icon-download" @click="exportJson">导出 JSON</el-button>
        <el-button size="small" icon="el-icon-upload2" @click="importJson">导入 JSON</el-button>
        <el-divider direction="vertical" />
        <el-button size="small" icon="el-icon-video-play" type="success" @click="runFlow">运行</el-button>
        <el-button size="small" icon="el-icon-check" type="primary" @click="saveFlow">保存</el-button>
      </div>
    </div>

    <div class="orch-body">
      <!-- 左侧节点面板 -->
      <div class="node-palette">
        <div class="palette-header">
          <span>节点组件</span>
        </div>
        <div class="palette-search">
          <el-input
            v-model="paletteKeyword"
            size="mini"
            placeholder="搜索节点"
            prefix-icon="el-icon-search"
            clearable
          />
        </div>
        <div class="palette-groups">
          <div
            v-for="group in filteredPaletteGroups"
            :key="group.name"
            class="palette-group"
          >
            <div class="group-title">{{ group.name }}</div>
            <div
              v-for="node in group.nodes"
              :key="node.type"
              class="palette-node"
              draggable="true"
              @dragstart="onDragStart($event, node)"
              @click="addNodeFromPalette(node)"
            >
              <span :class="['node-dot', node.color]"></span>
              <span class="node-label">{{ node.label }}</span>
              <i class="el-icon-plus node-add-icon"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- 中间画布 -->
      <div
        class="canvas-wrap"
        ref="canvasWrap"
        @dragover.prevent
        @drop="onDrop"
        @mousedown="onCanvasMouseDown"
        @mousemove="onCanvasMouseMove"
        @mouseup="onCanvasMouseUp"
        @click="onCanvasClick"
      >
        <!-- 网格背景 -->
        <div class="grid-bg" :style="gridStyle"></div>

        <!-- SVG 连线层 -->
        <svg class="edge-layer" :width="canvasW" :height="canvasH">
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="10"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#38bdf8" />
            </marker>
          </defs>
          <!-- 已保存的连线 -->
          <g v-for="edge in edges" :key="edge.id">
            <!-- 透明加宽命中层，便于点击/双击 -->
            <path
              :d="edgePath(edge)"
              class="edge-path-hit"
              @mousedown.stop="selectEdge(edge)"
              @dblclick.stop="deleteEdge(edge)"
            />
            <!-- 可视连线 -->
            <path
              :d="edgePath(edge)"
              class="edge-path"
              :class="{ 'is-selected': selectedEdgeId === edge.id }"
            />
            <!-- 连线条件标签 -->
            <text
              v-if="edge.label"
              :x="edgeLabelPos(edge).x"
              :y="edgeLabelPos(edge).y"
              class="edge-label"
            >{{ edge.label }}</text>
          </g>
          <!-- 正在拖拽的连线 -->
          <path
            v-if="draggingEdge"
            :d="draggingEdgePath"
            class="edge-path is-dragging"
          />
        </svg>

        <!-- 节点层 -->
        <div
          v-for="node in nodes"
          :key="node.id"
          class="flow-node"
          :class="{
            'is-selected': selectedNodeId === node.id,
            'is-running': runningNodeId === node.id
          }"
          :style="nodeStyle(node)"
          @mousedown.stop="onNodeMouseDown($event, node)"
          @dblclick.stop="openNodeEditor(node)"
          @click.stop="selectNode(node)"
        >
          <div class="node-header" :class="node.color">
            <span class="node-icon"><i :class="node.icon"></i></span>
            <span class="node-title">{{ node.label }}</span>
            <span class="node-del" @click.stop="deleteNode(node)">
              <i class="el-icon-close"></i>
            </span>
          </div>
          <div class="node-body">
            <div class="node-desc">{{ node.description || '双击编辑节点配置' }}</div>
            <!-- 绑定能力徽章 -->
            <div class="node-bind" v-if="node.bind && node.bind.resourceName">
              <span class="bind-badge" :class="'bind-' + node.bind.kind">
                <i :class="bindIcon(node.bind.kind)"></i>
                <span class="bind-name">{{ node.bind.resourceName }}</span>
                <span class="bind-ver" v-if="node.bind.resourceVersion">{{ node.bind.resourceVersion }}</span>
              </span>
            </div>
            <div class="node-config" v-if="node.config && node.config.length">
              <div
                v-for="cfg in node.config"
                :key="cfg.key"
                class="config-item"
              >
                <span class="config-key">{{ cfg.label }}:</span>
                <span class="config-val">{{ cfg.value }}</span>
              </div>
            </div>
          </div>
          <!-- 连接点 -->
          <div
            class="port port-in"
            :data-node-id="node.id"
            @mousedown.stop="startEdge($event, node, 'in')"
          ></div>
          <div
            class="port port-out"
            :data-node-id="node.id"
            @mousedown.stop="startEdge($event, node, 'out')"
          ></div>
        </div>

        <!-- 空状态 -->
        <div v-if="!nodes.length" class="canvas-empty">
          <i class="el-icon-connection"></i>
          <p>从左侧拖拽节点到画布，或点击节点添加</p>
          <p class="sub">拖动节点右下角连接点可建立连线</p>
        </div>

        <!-- 缩放控制 -->
        <div class="zoom-controls">
          <el-button-group size="mini">
            <el-button icon="el-icon-zoom-out" @click.stop="zoomOut" />
            <el-button class="zoom-percent" @click.stop="zoomReset">{{ Math.round(zoom * 100) }}%</el-button>
            <el-button icon="el-icon-zoom-in" @click.stop="zoomIn" />
          </el-button-group>
          <el-button size="mini" icon="el-icon-full-screen" title="适应画布" @click.stop="fitCanvas" />
        </div>

        <!-- 小地图 -->
        <div class="minimap" v-if="minimapVisible && nodes.length">
          <div class="minimap-header">
            <span>导航</span>
            <i class="el-icon-close" @click.stop="minimapVisible = false"></i>
          </div>
          <div class="minimap-body" ref="minimapBody" @click.stop="onMinimapClick">
            <svg :width="minimapW" :height="minimapH">
              <rect
                v-for="node in nodes"
                :key="'mm-' + node.id"
                :x="node.x * minimapScale"
                :y="node.y * minimapScale"
                :width="160 * minimapScale"
                :height="60 * minimapScale"
                :fill="NODE_COLORS[node.color] || '#38bdf8'"
                :opacity="selectedNodeId === node.id ? 1 : 0.7"
                rx="2"
              />
              <line
                v-for="edge in edges"
                :key="'mme-' + edge.id"
                :x1="(nodeById(edge.from).x + 160) * minimapScale"
                :y1="(nodeById(edge.from).y + 30) * minimapScale"
                :x2="nodeById(edge.to).x * minimapScale"
                :y2="(nodeById(edge.to).y + 30) * minimapScale"
                stroke="#38bdf8"
                stroke-width="1"
                opacity="0.5"
              />
            </svg>
            <!-- 视口框 -->
            <div
              class="minimap-viewport"
              :style="minimapViewportStyle"
            ></div>
          </div>
        </div>

        <!-- 底部统计栏 -->
        <div class="canvas-stats">
          <span class="stat-chip"><i class="el-icon-s-grid"></i> 节点 {{ nodes.length }}</span>
          <span class="stat-chip"><i class="el-icon-connection"></i> 连线 {{ edges.length }}</span>
          <span class="stat-chip" :class="{ 'has-warn': orphanNodes.length }">
            <i class="el-icon-warning-outline"></i>
            {{ orphanNodes.length ? orphanNodes.length + ' 个未连接节点' : '拓扑完整' }}
          </span>
        </div>
      </div>

      <!-- 右侧属性面板 -->
      <div class="property-panel">
        <div class="panel-header">
          <span>属性配置</span>
        </div>
        <div v-if="selectedNode" class="panel-body">
          <div class="prop-section">
            <div class="prop-title">节点信息</div>
            <el-form label-width="70px" size="mini">
              <el-form-item label="名称">
                <el-input v-model="selectedNode.label" />
              </el-form-item>
              <el-form-item label="类型">
                <el-input :value="selectedNode.type" disabled />
              </el-form-item>
              <el-form-item label="描述">
                <el-input
                  v-model="selectedNode.description"
                  type="textarea"
                  :rows="2"
                />
              </el-form-item>
            </el-form>
          </div>
          <div class="prop-section" v-if="selectedNode.bind">
            <div class="prop-title">能力绑定</div>
            <el-form label-width="70px" size="mini">
              <el-form-item :label="bindLabel(selectedNode)">
                <el-select
                  v-model="selectedNode.bind.resourceId"
                  placeholder="请选择"
                  style="width: 100%"
                  @change="onBindChange(selectedNode, $event)"
                >
                  <el-option
                    v-for="opt in bindOptions(selectedNode)"
                    :key="opt.id"
                    :label="opt.name"
                    :value="opt.id"
                  >
                    <span>{{ opt.name }}</span>
                    <span class="bind-opt-desc">{{ opt.desc }}</span>
                  </el-option>
                </el-select>
              </el-form-item>
              <div class="bind-detail" v-if="boundResource(selectedNode)">
                <div class="bind-detail-row">
                  <span class="bind-detail-label">版本</span>
                  <span class="bind-detail-val">{{ boundResource(selectedNode).version }}</span>
                </div>
                <div class="bind-detail-row" v-if="boundResource(selectedNode).server">
                  <span class="bind-detail-label">Server</span>
                  <span class="bind-detail-val">{{ boundResource(selectedNode).server }}</span>
                </div>
                <div class="bind-detail-row">
                  <span class="bind-detail-label">说明</span>
                  <span class="bind-detail-val">{{ boundResource(selectedNode).desc }}</span>
                </div>
              </div>
            </el-form>
          </div>
          <div class="prop-section" v-if="selectedNode.config && selectedNode.config.length">
            <div class="prop-title">参数配置</div>
            <el-form label-width="70px" size="mini">
              <el-form-item
                v-for="cfg in selectedNode.config"
                :key="cfg.key"
                :label="cfg.label"
              >
                <el-input v-model="cfg.value" />
              </el-form-item>
            </el-form>
          </div>
          <div class="prop-actions">
            <el-button size="mini" type="danger" plain @click="deleteNode(selectedNode)">
              删除节点
            </el-button>
          </div>
        </div>
        <div v-else-if="selectedEdge" class="panel-body">
          <div class="prop-section">
            <div class="prop-title">连线信息</div>
            <el-form label-width="70px" size="mini">
              <el-form-item label="来源">
                <el-input :value="nodeName(selectedEdge.from)" disabled />
              </el-form-item>
              <el-form-item label="目标">
                <el-input :value="nodeName(selectedEdge.to)" disabled />
              </el-form-item>
              <el-form-item label="条件">
                <el-input v-model="selectedEdge.label" placeholder="连线条件（可选）" />
              </el-form-item>
            </el-form>
          </div>
          <div class="prop-actions">
            <el-button size="mini" type="danger" plain @click="deleteEdge(selectedEdge)">
              删除连线
            </el-button>
          </div>
        </div>
        <div v-else class="panel-body panel-empty">
          <i class="el-icon-mouse"></i>
          <p>选中节点或连线后<br />在此编辑属性</p>
        </div>
      </div>
    </div>

    <!-- 节点编辑弹窗 -->
    <el-dialog
      title="编辑节点"
      :visible.sync="editorVisible"
      width="480px"
      custom-class="node-editor-dialog"
    >
      <el-form v-if="editingNode" label-width="80px" size="small">
        <el-form-item label="节点名称">
          <el-input v-model="editingNode.label" />
        </el-form-item>
        <el-form-item label="节点类型">
          <el-input :value="editingNode.type" disabled />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editingNode.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="editingNode.bind" :label="bindLabel(editingNode)">
          <el-select
            v-model="editingNode.bind.resourceId"
            placeholder="请选择"
            style="width: 100%"
            @change="onBindChange(editingNode, $event)"
          >
            <el-option
              v-for="opt in bindOptions(editingNode)"
              :key="opt.id"
              :label="opt.name"
              :value="opt.id"
            >
              <span>{{ opt.name }}</span>
              <span class="bind-opt-desc">{{ opt.desc }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <template v-if="editingNode.config && editingNode.config.length">
          <el-form-item
            v-for="cfg in editingNode.config"
            :key="cfg.key"
            :label="cfg.label"
          >
            <el-input v-model="cfg.value" />
          </el-form-item>
        </template>
      </el-form>
      <div slot="footer">
        <el-button size="small" @click="editorVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="confirmNodeEdit">确定</el-button>
      </div>
    </el-dialog>

    <!-- 导入 JSON 弹窗 -->
    <el-dialog
      title="导入编排 JSON"
      :visible.sync="importVisible"
      width="560px"
    >
      <el-input
        v-model="importText"
        type="textarea"
        :rows="10"
        placeholder='{"name":"编排名称","nodes":[...],"edges":[...]}'
      />
      <div slot="footer">
        <el-button size="small" @click="importVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="doImport">导入</el-button>
      </div>
    </el-dialog>

    <!-- 运行日志面板 -->
    <div class="run-log-panel" :class="{ 'is-open': logVisible }">
      <div class="run-log-header" @click="logVisible = !logVisible">
        <span class="log-title">
          <i class="el-icon-document"></i>
          运行日志
          <el-tag v-if="runLogs.length" size="mini" :type="runStatusTag" class="log-status-tag">
            {{ runStatusText }}
          </el-tag>
        </span>
        <span class="log-actions">
          <el-button size="mini" icon="el-icon-delete" @click.stop="clearLogs">清空</el-button>
          <i :class="['el-icon-arrow-down', 'log-toggle', { 'is-open': logVisible }]"></i>
        </span>
      </div>
      <div class="run-log-body" v-if="logVisible">
        <div v-if="!runLogs.length" class="log-empty">
          <i class="el-icon-document"></i>
          <p>点击「运行」后，这里将展示每个节点的执行过程与结果</p>
        </div>
        <div v-else class="log-list">
          <div
            v-for="(log, idx) in runLogs"
            :key="idx"
            class="log-item"
            :class="'log-' + log.level"
          >
            <span class="log-time">{{ log.time }}</span>
            <span class="log-icon"><i :class="logIcon(log.level)"></i></span>
            <span class="log-msg">{{ log.message }}</span>
            <span v-if="log.duration" class="log-duration">{{ log.duration }}ms</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
let nodeSeq = 0
let edgeSeq = 0

const PALETTE_GROUPS = [
  {
    name: '触发',
    nodes: [
      { type: 'trigger', label: '开始', icon: 'el-icon-video-play', color: 'green', description: '流程入口触发节点' },
      { type: 'schedule', label: '定时触发', icon: 'el-icon-time', color: 'green', description: '按计划定时执行', config: [{ key: 'cron', label: 'Cron 表达式', value: '0 0 * * *' }] }
    ]
  },
  {
    name: '处理',
    nodes: [
      { type: 'http', label: 'HTTP 请求', icon: 'el-icon-connection', color: 'blue', description: '发起 HTTP 请求', config: [{ key: 'url', label: 'URL', value: 'https://api.example.com' }, { key: 'method', label: '方法', value: 'GET' }] },
      { type: 'transform', label: '数据转换', icon: 'el-icon-sort', color: 'purple', description: '转换数据结构', config: [{ key: 'mapping', label: '映射规则', value: '{}' }] },
      { type: 'condition', label: '条件判断', icon: 'el-icon-s-check', color: 'orange', description: '根据条件分支', config: [{ key: 'expr', label: '条件表达式', value: 'value > 100' }] },
      { type: 'code', label: '代码执行', icon: 'el-icon-edit-outline', color: 'blue', description: '执行自定义代码', config: [{ key: 'lang', label: '语言', value: 'javascript' }] }
    ]
  },
  {
    name: '智能体',
    nodes: [
      { type: 'agent', label: '智能体调用', icon: 'el-icon-user', color: 'purple', description: '调用已注册的智能体执行任务', bind: { kind: 'agent', label: '绑定智能体', placeholder: '选择智能体' } },
      { type: 'agent-group', label: '智能体编排', icon: 'el-icon-s-grid', color: 'purple', description: '多智能体协同编排', bind: { kind: 'agent', label: '绑定智能体组', placeholder: '选择智能体组' } }
    ]
  },
  {
    name: '能力绑定',
    nodes: [
      { type: 'skill', label: 'Skill 调用', icon: 'el-icon-magic-stick', color: 'cyan', description: '绑定并调用团队 Skill 能力', bind: { kind: 'skill', label: '绑定 Skill', placeholder: '选择 Skill' } },
      { type: 'mcp', label: 'MCP 工具', icon: 'el-icon-connection', color: 'blue', description: '绑定 MCP Server 工具', bind: { kind: 'mcp', label: '绑定 MCP 工具', placeholder: '选择 MCP Server / Tool' } },
      { type: 'harness', label: 'Harness 执行', icon: 'el-icon-set-up', color: 'orange', description: '绑定 Harness 基础能力执行', bind: { kind: 'harness', label: '绑定 Harness', placeholder: '选择 Harness' } }
    ]
  },
  {
    name: '输出',
    nodes: [
      { type: 'message', label: '发送消息', icon: 'el-icon-chat-dot-round', color: 'cyan', description: '发送通知消息', config: [{ key: 'channel', label: '渠道', value: 'email' }, { key: 'to', label: '接收人', value: 'admin@example.com' }] },
      { type: 'database', label: '数据库操作', icon: 'el-icon-database', color: 'green', description: '读写数据库', config: [{ key: 'sql', label: 'SQL', value: 'SELECT * FROM table' }] },
      { type: 'end', label: '结束', icon: 'el-icon-circle-close', color: 'red', description: '流程结束节点' }
    ]
  }
]

// 可绑定的企业级能力资源（模拟数据）
const BINDABLE_RESOURCES = {
  agent: [
    { id: 'agent-1', name: '数据分析师', desc: '擅长数据清洗与可视化', version: 'v2.1' },
    { id: 'agent-2', name: '代码审查员', desc: '代码质量与安全审查', version: 'v1.8' },
    { id: 'agent-3', name: '运维助手', desc: '部署与故障排查', version: 'v3.0' }
  ],
  skill: [
    { id: 'skill-1', name: 'vue2-style', desc: 'Vue2 样式修改规范', version: 'v1.0' },
    { id: 'skill-2', name: 'safe-edit', desc: '安全编辑规范', version: 'v1.2' },
    { id: 'skill-3', name: 'code-review', desc: '代码评审流程', version: 'v2.0' }
  ],
  mcp: [
    { id: 'mcp-1', name: 'github / create_issue', desc: '创建 GitHub Issue', server: 'github', version: 'v1.4' },
    { id: 'mcp-2', name: 'filesystem / read', desc: '读取文件系统', server: 'filesystem', version: 'v1.0' },
    { id: 'mcp-3', name: 'database / query', desc: '数据库查询', server: 'database', version: 'v2.2' }
  ],
  harness: [
    { id: 'harness-1', name: 'CI 流水线', desc: '持续集成构建', version: 'v1.0' },
    { id: 'harness-2', name: '部署网关', desc: '多环境部署', version: 'v2.0' },
    { id: 'harness-3', name: '监控告警', desc: '指标监控与告警', version: 'v1.5' }
  ]
}

const NODE_COLORS = {
  green: '#34d399',
  blue: '#38bdf8',
  purple: '#a78bfa',
  orange: '#fb923c',
  cyan: '#22d3ee',
  red: '#f87171'
}

export default {
  name: 'OrchestrationBuilder',
  data () {
    return {
      flowName: '我的编排流程',
      nodes: [],
      edges: [],
      paletteKeyword: '',
      selectedNodeId: null,
      selectedEdgeId: null,
      canvasW: 1200,
      canvasH: 800,
      // 拖拽节点
      draggingNodeType: null,
      // 节点移动
      movingNode: null,
      moveOffsetX: 0,
      moveOffsetY: 0,
      // 连线拖拽
      draggingEdge: null,
      draggingEdgePath: '',
      edgeMouseX: 0,
      edgeMouseY: 0,
      // 编辑
      editorVisible: false,
      editingNode: null,
      // 可绑定的企业级能力资源
      bindableResources: BINDABLE_RESOURCES,
      // 导入导出
      importVisible: false,
      importText: '',
      // 运行
      runningNodeId: null,
      // 撤销 / 重做
      undoStack: [],
      redoStack: [],
      undoLimit: 50,
      // 缩放
      zoom: 1,
      // 小地图
      minimapVisible: true,
      minimapW: 200,
      minimapH: 150,
      minimapScale: 0.2,
      // 节点颜色映射（暴露给模板）
      NODE_COLORS,
      // 运行日志
      logVisible: false,
      runLogs: [],
      runStatusTag: 'info',
      runStatusText: '待运行'
    }
  },
  computed: {
    filteredPaletteGroups () {
      const kw = this.paletteKeyword.trim().toLowerCase()
      if (!kw) return PALETTE_GROUPS
      return PALETTE_GROUPS
        .map(g => ({
          ...g,
          nodes: g.nodes.filter(n => n.label.toLowerCase().includes(kw) || n.type.toLowerCase().includes(kw))
        }))
        .filter(g => g.nodes.length)
    },
    selectedNode () {
      return this.nodes.find(n => n.id === this.selectedNodeId) || null
    },
    selectedEdge () {
      return this.edges.find(e => e.id === this.selectedEdgeId) || null
    },
    gridStyle () {
      const size = Math.max(8, Math.round(20 * this.zoom))
      return {
        backgroundSize: size + 'px ' + size + 'px'
      }
    },
    orphanNodes () {
      const linked = new Set()
      this.edges.forEach(e => {
        if (e && e.from) linked.add(e.from)
        if (e && e.to) linked.add(e.to)
      })
      // 单节点不算孤儿；只有「存在连线拓扑但未参与」才标未连接
      if (!this.edges.length) return []
      return this.nodes.filter(n => !linked.has(n.id))
    },
    minimapViewportStyle () {
      const scale = this.minimapScale || 0.2
      return {
        left: '0px',
        top: '0px',
        width: Math.min(this.minimapW, (this.canvasW || 0) * scale) + 'px',
        height: Math.min(this.minimapH, (this.canvasH || 0) * scale) + 'px'
      }
    }
  },
  mounted () {
    this.resizeCanvas()
    window.addEventListener('resize', this.resizeCanvas)
    this.loadDemoFlow()
  },
  beforeDestroy () {
    window.removeEventListener('resize', this.resizeCanvas)
  },
  methods: {
    nodeById (id) {
      return this.nodes.find(n => n.id === id) || { id: id || '', x: 0, y: 0 }
    },
    logIcon (level) {
      const map = {
        success: 'el-icon-success',
        error: 'el-icon-error',
        warning: 'el-icon-warning',
        info: 'el-icon-info',
        running: 'el-icon-loading'
      }
      return map[level] || 'el-icon-info'
    },
    zoomIn () {
      this.zoom = Math.min(2, Math.round((this.zoom + 0.1) * 10) / 10)
    },
    zoomOut () {
      this.zoom = Math.max(0.5, Math.round((this.zoom - 0.1) * 10) / 10)
    },
    zoomReset () {
      this.zoom = 1
    },
    fitCanvas () {
      if (!this.nodes.length) {
        this.zoomReset()
        return
      }
      const maxX = Math.max(...this.nodes.map(n => n.x + 160), 1)
      const maxY = Math.max(...this.nodes.map(n => n.y + 60), 1)
      const sx = (this.canvasW - 40) / maxX
      const sy = (this.canvasH - 40) / maxY
      this.zoom = Math.max(0.5, Math.min(1.5, Math.round(Math.min(sx, sy, 1) * 10) / 10))
    },
    onMinimapClick (e) {
      const body = this.$refs.minimapBody
      const wrap = this.$refs.canvasWrap
      if (!body || !wrap) return
      const rect = body.getBoundingClientRect()
      const x = (e.clientX - rect.left) / (this.minimapScale || 0.2)
      const y = (e.clientY - rect.top) / (this.minimapScale || 0.2)
      wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2)
      wrap.scrollTop = Math.max(0, y - wrap.clientHeight / 2)
    },
    resizeCanvas () {
      const wrap = this.$refs.canvasWrap
      if (!wrap) return
      this.canvasW = wrap.clientWidth
      this.canvasH = wrap.clientHeight
    },
    // ---------- 节点操作 ----------
    onDragStart (e, node) {
      this.draggingNodeType = node
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('text/plain', node.type)
    },
    onDrop (e) {
      const node = this.draggingNodeType
      if (!node) return
      const rect = this.$refs.canvasWrap.getBoundingClientRect()
      const x = e.clientX - rect.left - 80
      const y = e.clientY - rect.top - 30
      this.addNode(node, x, y)
      this.draggingNodeType = null
    },
    addNodeFromPalette (node) {
      const rect = this.$refs.canvasWrap.getBoundingClientRect()
      const x = rect.width / 2 - 80 + (Math.random() * 60 - 30)
      const y = rect.height / 2 - 30 + (Math.random() * 60 - 30)
      this.addNode(node, x, y)
    },
    addNode (node, x, y) {
      nodeSeq++
      const id = 'node-' + nodeSeq
      const newNode = {
        id,
        type: node.type,
        label: node.label,
        icon: node.icon,
        color: node.color,
        description: node.description,
        config: node.config ? node.config.map(c => ({ ...c })) : [],
        bind: node.bind ? { ...node.bind, resourceId: '', resourceName: '' } : null,
        x: Math.max(0, x),
        y: Math.max(0, y)
      }
      this.snapshot()
      this.nodes.push(newNode)
      this.selectedNodeId = id
      this.selectedEdgeId = null
    },
    // 绑定资源相关
    bindIcon (kind) {
      const map = {
        agent: 'el-icon-user',
        skill: 'el-icon-magic-stick',
        mcp: 'el-icon-connection',
        harness: 'el-icon-set-up'
      }
      return map[kind] || 'el-icon-link'
    },
    bindKindOf (node) {
      return node && node.bind ? node.bind.kind : null
    },
    bindOptions (node) {
      const kind = this.bindKindOf(node)
      if (!kind) return []
      return this.bindableResources[kind] || []
    },
    bindLabel (node) {
      if (!node || !node.bind) return ''
      return node.bind.label || '绑定能力'
    },
    bindPlaceholder (node) {
      if (!node || !node.bind) return '选择能力'
      return node.bind.placeholder || '选择能力'
    },
    onBindChange (node, resourceId) {
      const kind = this.bindKindOf(node)
      const res = (this.bindableResources[kind] || []).find(r => r.id === resourceId)
      if (res) {
        node.bind.resourceId = res.id
        node.bind.resourceName = res.name
        node.bind.resourceDesc = res.desc
        node.bind.resourceVersion = res.version
        node.bind.resourceServer = res.server || ''
        // 同步更新节点标题与描述，便于画布直观展示
        node.label = res.name
        if (res.desc) node.description = res.desc
      } else {
        node.bind.resourceId = ''
        node.bind.resourceName = ''
        node.bind.resourceDesc = ''
        node.bind.resourceVersion = ''
        node.bind.resourceServer = ''
      }
    },
    boundResource (node) {
      if (!node || !node.bind || !node.bind.resourceId) return null
      const kind = this.bindKindOf(node)
      return (this.bindableResources[kind] || []).find(r => r.id === node.bind.resourceId) || null
    },
    nodeStyle (node) {
      return {
        left: node.x + 'px',
        top: node.y + 'px'
      }
    },
    onNodeMouseDown (e, node) {
      this.selectedNodeId = node.id
      this.selectedEdgeId = null
      this.movingNode = node
      this.moveOffsetX = e.clientX - node.x
      this.moveOffsetY = e.clientY - node.y
    },
    onCanvasMouseMove (e) {
      if (this.movingNode) {
        const rect = this.$refs.canvasWrap.getBoundingClientRect()
        this.movingNode.x = Math.max(0, Math.min(e.clientX - rect.left - this.moveOffsetX, this.canvasW - 160))
        this.movingNode.y = Math.max(0, Math.min(e.clientY - rect.top - this.moveOffsetY, this.canvasH - 60))
      }
      if (this.draggingEdge) {
        this.updateDraggingEdge(e)
      }
    },
    onCanvasMouseUp () {
      if (this.movingNode) {
        this.snapshot()
      }
      this.movingNode = null
      if (this.draggingEdge) {
        this.finishEdge()
      }
    },
    onCanvasMouseDown () {
      // 点击空白取消选中
    },
    onCanvasClick () {
      this.selectedNodeId = null
      this.selectedEdgeId = null
    },
    selectNode (node) {
      this.selectedNodeId = node.id
      this.selectedEdgeId = null
    },
    deleteNode (node) {
      this.snapshot()
      this.nodes = this.nodes.filter(n => n.id !== node.id)
      this.edges = this.edges.filter(e => e.from !== node.id && e.to !== node.id)
      if (this.selectedNodeId === node.id) this.selectedNodeId = null
    },
    openNodeEditor (node) {
      this.editingNode = node
      this.editorVisible = true
    },
    confirmNodeEdit () {
      this.snapshot()
      this.editorVisible = false
      this.$message.success('节点已更新')
    },
    // ---------- 连线操作 ----------
    startEdge (e, node, port) {
      this.draggingEdge = { from: node.id, to: null, port }
      this.updateDraggingEdge(e)
    },
    updateDraggingEdge (e) {
      const rect = this.$refs.canvasWrap.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      this.edgeMouseX = mouseX
      this.edgeMouseY = mouseY
      const fromNode = this.nodes.find(n => n.id === this.draggingEdge.from)
      if (!fromNode) return
      const fromX = fromNode.x + 160
      const fromY = fromNode.y + 30
      this.draggingEdgePath = this.buildPath(fromX, fromY, mouseX, mouseY)
    },
    finishEdge () {
      // 检查是否落在某个节点的输入端口上
      const target = this.findNodeAtPort(this.draggingEdge.from)
      if (target && target.id !== this.draggingEdge.from) {
        const exists = this.edges.some(e => e.from === this.draggingEdge.from && e.to === target.id)
        if (!exists) {
          this.snapshot()
          edgeSeq++
          this.edges.push({
            id: 'edge-' + edgeSeq,
            from: this.draggingEdge.from,
            to: target.id,
            label: ''
          })
          this.$message.success('连线已建立')
        } else {
          this.$message.warning('该连线已存在')
        }
      }
      this.draggingEdge = null
      this.draggingEdgePath = ''
    },
    findNodeAtPort (fromId) {
      // 检查鼠标位置是否落在某个节点的输入端口（左侧）附近
      // 输入端口实际位于节点左上角 (n.x - 7, n.y + 30)
      const hit = this.nodes.find(n => {
        if (n.id === fromId) return false
        const portX = n.x - 7
        const portY = n.y + 30
        const dx = this.edgeMouseX - portX
        const dy = this.edgeMouseY - portY
        return Math.abs(dx) < 40 && Math.abs(dy) < 40
      })
      return hit || null
    },
    edgePath (edge) {
      const fromNode = this.nodes.find(n => n.id === edge.from)
      const toNode = this.nodes.find(n => n.id === edge.to)
      if (!fromNode || !toNode) return ''
      const fromX = fromNode.x + 160
      const fromY = fromNode.y + 30
      const toX = toNode.x
      const toY = toNode.y + 30
      return this.buildPath(fromX, fromY, toX, toY)
    },
    edgeLabelPos (edge) {
      const fromNode = this.nodes.find(n => n.id === edge.from)
      const toNode = this.nodes.find(n => n.id === edge.to)
      if (!fromNode || !toNode) return { x: 0, y: 0 }
      return {
        x: (fromNode.x + 160 + toNode.x) / 2,
        y: (fromNode.y + 30 + toNode.y + 30) / 2 - 6
      }
    },
    buildPath (x1, y1, x2, y2) {
      const dx = Math.max(40, Math.abs(x2 - x1) / 2)
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    },
    selectEdge (edge) {
      this.selectedEdgeId = edge.id
      this.selectedNodeId = null
    },
    deleteEdge (edge) {
      this.snapshot()
      this.edges = this.edges.filter(e => e.id !== edge.id)
      if (this.selectedEdgeId === edge.id) this.selectedEdgeId = null
    },
    nodeName (id) {
      const n = this.nodes.find(n => n.id === id)
      return n ? n.label : id
    },
    // ---------- 撤销 / 重做 ----------
    snapshot () {
      this.undoStack.push({
        nodes: JSON.parse(JSON.stringify(this.nodes)),
        edges: JSON.parse(JSON.stringify(this.edges))
      })
      if (this.undoStack.length > this.undoLimit) {
        this.undoStack.shift()
      }
      this.redoStack = []
    },
    undo () {
      if (!this.undoStack.length) return
      const prev = this.undoStack.pop()
      this.redoStack.push({
        nodes: JSON.parse(JSON.stringify(this.nodes)),
        edges: JSON.parse(JSON.stringify(this.edges))
      })
      this.nodes = prev.nodes
      this.edges = prev.edges
      this.selectedNodeId = null
      this.selectedEdgeId = null
      this.$message.success('已撤销')
    },
    redo () {
      if (!this.redoStack.length) return
      const next = this.redoStack.pop()
      this.undoStack.push({
        nodes: JSON.parse(JSON.stringify(this.nodes)),
        edges: JSON.parse(JSON.stringify(this.edges))
      })
      this.nodes = next.nodes
      this.edges = next.edges
      this.selectedNodeId = null
      this.selectedEdgeId = null
      this.$message.success('已重做')
    },
    // ---------- 画布操作 ----------
    resetCanvas () {
      this.$confirm('确定清空当前画布吗？', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.snapshot()
        this.nodes = []
        this.edges = []
        this.selectedNodeId = null
        this.selectedEdgeId = null
        this.$message.success('画布已清空')
      }).catch(() => {})
    },
    // ---------- 导入导出 ----------
    exportJson () {
      const data = {
        name: this.flowName,
        nodes: this.nodes,
        edges: this.edges
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = (this.flowName || '编排') + '.json'
      a.click()
      URL.revokeObjectURL(url)
      this.$message.success('已导出 JSON')
    },
    importJson () {
      this.importText = ''
      this.importVisible = true
    },
    doImport () {
      try {
        const data = JSON.parse(this.importText)
        if (!data.nodes || !Array.isArray(data.nodes)) {
          throw new Error('缺少 nodes 字段')
        }
        this.nodes = data.nodes
        this.edges = data.edges || []
        if (data.name) this.flowName = data.name
        this.importVisible = false
        this.$message.success('导入成功')
      } catch (e) {
        this.$message.error('JSON 格式错误：' + e.message)
      }
    },
    // ---------- 运行 / 保存 ----------
    runFlow () {
      if (!this.nodes.length) {
        this.$message.warning('画布为空，请先添加节点')
        return
      }
      const startNode = this.nodes.find(n => n.type === 'trigger') || this.nodes[0]
      this.$message.info('开始运行编排流程...')
      this.animateRun(startNode.id)
    },
    // 分支并行执行：BFS 层级遍历，汇合节点等待所有前驱完成
    animateRun (startId) {
      // 计算每个节点的入度（前驱数量）
      const indegree = {}
      this.nodes.forEach(n => { indegree[n.id] = 0 })
      this.edges.forEach(e => { indegree[e.to] = (indegree[e.to] || 0) + 1 })

      // 记录每个节点已完成的入边数
      const doneCount = {}
      this.nodes.forEach(n => { doneCount[n.id] = 0 })

      const visited = {}
      const queue = [startId]
      visited[startId] = true

      const step = () => {
        if (!queue.length) {
          this.runningNodeId = null
          this.$message.success('编排流程执行完成')
          return
        }
        // 当前层节点
        const current = queue.splice(0, queue.length)
        current.forEach(nodeId => {
          const node = this.nodes.find(n => n.id === nodeId)
          if (node) {
            this.$message({ message: '执行节点：' + node.label, type: 'success', duration: 700 })
          }
        })
        // 高亮当前层最后一个节点（视觉反馈）
        this.runningNodeId = current[current.length - 1]

        // 收集下一层：所有出边目标，且满足汇合条件（所有前驱已完成）
        const nextLayer = []
        current.forEach(nodeId => {
          const outEdges = this.edges.filter(e => e.from === nodeId)
          outEdges.forEach(e => {
            doneCount[e.to] = (doneCount[e.to] || 0) + 1
            if (!visited[e.to] && doneCount[e.to] >= indegree[e.to]) {
              visited[e.to] = true
              nextLayer.push(e.to)
            }
          })
        })

        if (nextLayer.length) {
          setTimeout(() => {
            queue.push(...nextLayer)
            step()
          }, 700)
        } else {
          setTimeout(() => {
            this.runningNodeId = null
            this.$message.success('编排流程执行完成')
          }, 700)
        }
      }

      step()
    },
    saveFlow () {
      if (!this.nodes.length) {
        this.$message.warning('画布为空，无法保存')
        return
      }
      this.$message.success('编排已保存：' + this.flowName)
    },
    // ---------- 演示数据 ----------
    loadDemoFlow () {
      nodeSeq = 0
      edgeSeq = 0
      const trigger = { id: 'node-1', type: 'trigger', label: '开始', icon: 'el-icon-video-play', color: 'green', description: '流程入口触发节点', config: [], x: 60, y: 120 }
      const http = { id: 'node-2', type: 'http', label: 'HTTP 请求', icon: 'el-icon-connection', color: 'blue', description: '发起 HTTP 请求', config: [{ key: 'url', label: 'URL', value: 'https://api.example.com' }, { key: 'method', label: '方法', value: 'GET' }], x: 320, y: 100 }
      const condition = { id: 'node-3', type: 'condition', label: '条件判断', icon: 'el-icon-s-check', color: 'orange', description: '根据条件分支', config: [{ key: 'expr', label: '条件表达式', value: 'code === 200' }], x: 580, y: 100 }
      const message = { id: 'node-4', type: 'message', label: '发送消息', icon: 'el-icon-chat-dot-round', color: 'cyan', description: '发送通知消息', config: [{ key: 'channel', label: '渠道', value: 'email' }, { key: 'to', label: '接收人', value: 'admin@example.com' }], x: 840, y: 60 }
      const database = { id: 'node-5', type: 'database', label: '数据库操作', icon: 'el-icon-database', color: 'green', description: '读写数据库', config: [{ key: 'sql', label: 'SQL', value: 'INSERT INTO log' }], x: 840, y: 200 }
      const end = { id: 'node-6', type: 'end', label: '结束', icon: 'el-icon-circle-close', color: 'red', description: '流程结束节点', config: [], x: 1100, y: 130 }
      nodeSeq = 6
      this.nodes = [trigger, http, condition, message, database, end]
      this.edges = [
        { id: 'edge-1', from: 'node-1', to: 'node-2', label: '' },
        { id: 'edge-2', from: 'node-2', to: 'node-3', label: '' },
        { id: 'edge-3', from: 'node-3', to: 'node-4', label: '成功' },
        { id: 'edge-4', from: 'node-3', to: 'node-5', label: '失败' },
        { id: 'edge-5', from: 'node-4', to: 'node-6', label: '' },
        { id: 'edge-6', from: 'node-5', to: 'node-6', label: '' }
      ]
      edgeSeq = 6
    }
  }
}
</script>

<style scoped>
/* ============ 深色科技主题 ============ */
.page-orchestration {
  height: calc(100vh - 84px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #0b1220 0%, #0f172a 50%, #111a2e 100%);
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  overflow: hidden;
}

/* ---------- 顶部工具栏 ---------- */
.orch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toolbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  background: linear-gradient(90deg, #22d3ee, #3b82f6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.toolbar-title i {
  -webkit-text-fill-color: #22d3ee;
  color: #22d3ee;
  font-size: 18px;
}
.flow-name-input {
  width: 180px;
}
.orch-toolbar .el-divider--vertical {
  background: rgba(255, 255, 255, 0.15);
}

/* ---------- 主体三栏布局 ---------- */
.orch-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  min-height: 0;
  position: relative;
}

/* ---------- 左侧节点面板 ---------- */
.node-palette {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  overflow: hidden;
}
.palette-header {
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}
.palette-search {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.palette-groups {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.palette-group {
  margin-bottom: 10px;
}
.group-title {
  font-size: 11px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 6px 8px;
}
.palette-node {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: grab;
  transition: all 0.2s ease;
}
.palette-node:hover {
  background: rgba(56, 189, 248, 0.1);
  border-color: rgba(56, 189, 248, 0.4);
  transform: translateX(2px);
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.15);
}
.node-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px currentColor;
}
.node-dot.green { background: #34d399; color: #34d399; }
.node-dot.blue { background: #38bdf8; color: #38bdf8; }
.node-dot.purple { background: #a78bfa; color: #a78bfa; }
.node-dot.orange { background: #fb923c; color: #fb923c; }
.node-dot.cyan { background: #22d3ee; color: #22d3ee; }
.node-dot.red { background: #f87171; color: #f87171; }
.node-label {
  flex: 1;
  font-size: 13px;
  color: #e2e8f0;
}
.node-add-icon {
  color: #64748b;
  font-size: 14px;
  transition: all 0.2s;
}
.palette-node:hover .node-add-icon {
  color: #38bdf8;
}

/* ---------- 中间画布 ---------- */
.canvas-wrap {
  flex: 1;
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #0d1526;
  border: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 0;
}
.grid-bg {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px);
  background-size: 20px 20px;
}
.edge-layer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;
}
.edge-path {
  fill: none;
  stroke: rgba(148, 163, 184, 0.5);
  stroke-width: 2;
  stroke-linecap: round;
  transition: stroke 0.2s, filter 0.2s;
}
.edge-path.is-selected {
  stroke: #38bdf8;
  filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.6));
}
.edge-path.is-dragging {
  stroke: #38bdf8;
  stroke-dasharray: 6 4;
  filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.6));
}
.edge-path-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 12;
  pointer-events: stroke;
  cursor: pointer;
}
.edge-label {
  fill: #94a3b8;
  font-size: 11px;
  pointer-events: none;
  text-anchor: middle;
}

/* ---------- 流程节点 ---------- */
.flow-node {
  position: absolute;
  width: 160px;
  background: rgba(30, 41, 59, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  cursor: move;
  transition: box-shadow 0.2s, border-color 0.2s, transform 0.1s;
  user-select: none;
}
.flow-node:hover {
  border-color: rgba(56, 189, 248, 0.5);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(56, 189, 248, 0.15);
}
.flow-node.is-selected {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.3), 0 8px 28px rgba(0, 0, 0, 0.5);
}
.flow-node.is-running {
  border-color: #34d399;
  box-shadow: 0 0 20px rgba(52, 211, 153, 0.5);
  animation: nodePulse 1.2s ease-in-out infinite;
}
@keyframes nodePulse {
  0%, 100% { box-shadow: 0 0 12px rgba(52, 211, 153, 0.3); }
  50% { box-shadow: 0 0 28px rgba(52, 211, 153, 0.7); }
}
.node-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 11px 11px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
}
.node-header.green { background: linear-gradient(135deg, #059669, #34d399); }
.node-header.blue { background: linear-gradient(135deg, #0284c7, #38bdf8); }
.node-header.purple { background: linear-gradient(135deg, #7c3aed, #a78bfa); }
.node-header.orange { background: linear-gradient(135deg, #ea580c, #fb923c); }
.node-header.cyan { background: linear-gradient(135deg, #0891b2, #22d3ee); }
.node-header.red { background: linear-gradient(135deg, #dc2626, #f87171); }
.node-icon {
  font-size: 13px;
  display: flex;
  align-items: center;
}
.node-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-del {
  opacity: 0;
  cursor: pointer;
  font-size: 12px;
  transition: opacity 0.2s;
  padding: 2px;
}
.flow-node:hover .node-del {
  opacity: 0.8;
}
.node-del:hover {
  opacity: 1;
}
.node-body {
  padding: 8px 10px;
}
.node-desc {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.4;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-bind {
  margin-bottom: 6px;
}
.bind-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 20px;
  background: rgba(56, 189, 248, 0.15);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.3);
}
.bind-badge.bind-command {
  background: rgba(167, 139, 250, 0.15);
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.3);
}
.bind-badge.bind-flow {
  background: rgba(52, 211, 153, 0.15);
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.3);
}
.bind-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bind-ver {
  opacity: 0.7;
}
.node-config {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.config-item {
  display: flex;
  gap: 4px;
  font-size: 10px;
  color: #94a3b8;
}
.config-key {
  color: #64748b;
}
.config-val {
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 连接点 ---------- */
.port {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #1e293b;
  border: 2px solid #38bdf8;
  cursor: crosshair;
  transition: all 0.2s;
  z-index: 3;
}
.port:hover {
  background: #38bdf8;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.8);
  transform: scale(1.2);
}
.port-in {
  left: -7px;
  top: 50%;
  transform: translateY(-50%);
}
.port-out {
  right: -7px;
  top: 50%;
  transform: translateY(-50%);
}
.port-in:hover { transform: translateY(-50%) scale(1.2); }
.port-out:hover { transform: translateY(-50%) scale(1.2); }

/* ---------- 空状态 ---------- */
.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #64748b;
  pointer-events: none;
}
.canvas-empty i {
  font-size: 48px;
  color: rgba(56, 189, 248, 0.4);
}
.canvas-empty p {
  font-size: 14px;
  margin: 0;
}
.canvas-empty p.sub {
  font-size: 12px;
  color: #475569;
}

/* ---------- 缩放控制 ---------- */
.zoom-controls {
  position: absolute;
  bottom: 230px;
  right: 16px;
  display: flex;
  gap: 8px;
  z-index: 5;
}
.zoom-percent {
  min-width: 56px;
  text-align: center;
}

/* ---------- 小地图 ---------- */
.minimap {
  position: absolute;
  bottom: 48px;
  right: 16px;
  width: 200px;
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 6;
}
.minimap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: #94a3b8;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.minimap-header i {
  cursor: pointer;
  color: #64748b;
}
.minimap-header i:hover {
  color: #f87171;
}
.minimap-body {
  position: relative;
  padding: 8px;
}
.minimap-viewport {
  position: absolute;
  border: 1px solid #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  pointer-events: none;
}

/* ---------- 底部统计栏 ---------- */
.canvas-stats {
  position: absolute;
  bottom: 12px;
  left: 12px;
  display: flex;
  gap: 8px;
  z-index: 5;
}
.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #94a3b8;
  padding: 4px 12px;
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.stat-chip i {
  color: #38bdf8;
}
.stat-chip.has-warn {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.3);
}
.stat-chip.has-warn i {
  color: #fbbf24;
}

/* ---------- 右侧属性面板 ---------- */
.property-panel {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  overflow: hidden;
}
.panel-header {
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #64748b;
  text-align: center;
}
.panel-empty i {
  font-size: 40px;
  color: rgba(56, 189, 248, 0.3);
}
.panel-empty p {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.prop-section {
  margin-bottom: 16px;
}
.prop-title {
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.prop-actions {
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.bind-detail {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.bind-detail-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.bind-detail-label {
  color: #64748b;
  flex-shrink: 0;
}
.bind-detail-val {
  color: #cbd5e1;
  word-break: break-all;
}
.bind-opt-desc {
  float: right;
  color: #64748b;
  font-size: 12px;
}

/* ---------- 运行日志面板 ---------- */
.run-log-panel {
  position: absolute;
  bottom: 12px;
  right: 12px;
  width: 380px;
  max-height: 320px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  z-index: 7;
  display: flex;
  flex-direction: column;
}
.run-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}
.log-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}
.log-title i {
  color: #38bdf8;
}
.log-status-tag {
  margin-left: 4px;
}
.log-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-toggle {
  color: #64748b;
  transition: transform 0.2s;
}
.log-toggle.is-open {
  transform: rotate(180deg);
}
.run-log-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 80px;
}
.log-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: #64748b;
  text-align: center;
}
.log-empty i {
  font-size: 32px;
  color: rgba(56, 189, 248, 0.3);
}
.log-empty p {
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}
.log-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.log-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 3px solid transparent;
}
.log-item.log-info {
  border-left-color: #38bdf8;
}
.log-item.log-success {
  border-left-color: #34d399;
}
.log-item.log-warn {
  border-left-color: #fbbf24;
}
.log-item.log-error {
  border-left-color: #f87171;
}
.log-time {
  color: #64748b;
  font-size: 11px;
  flex-shrink: 0;
  font-family: 'SF Mono', Consolas, monospace;
}
.log-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
.log-item.log-info .log-icon { color: #38bdf8; }
.log-item.log-success .log-icon { color: #34d399; }
.log-item.log-warn .log-icon { color: #fbbf24; }
.log-item.log-error .log-icon { color: #f87171; }
.log-msg {
  flex: 1;
  color: #cbd5e1;
  line-height: 1.4;
  word-break: break-all;
}
.log-duration {
  color: #64748b;
  font-size: 11px;
  flex-shrink: 0;
}

/* ---------- 深色主题下覆盖 ElementUI 组件 ---------- */
.page-orchestration ::v-deep .el-input__inner,
.page-orchestration ::v-deep .el-textarea__inner {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.12);
  color: #e2e8f0;
}
.page-orchestration ::v-deep .el-input__inner::placeholder,
.page-orchestration ::v-deep .el-textarea__inner::placeholder {
  color: #64748b;
}
.page-orchestration ::v-deep .el-input__inner:focus,
.page-orchestration ::v-deep .el-textarea__inner:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.15);
}
.page-orchestration ::v-deep .el-input.is-disabled .el-input__inner {
  background: rgba(255, 255, 255, 0.03);
  color: #64748b;
}
.page-orchestration ::v-deep .el-button {
  border-color: rgba(255, 255, 255, 0.15);
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.04);
}
.page-orchestration ::v-deep .el-button:hover {
  border-color: #38bdf8;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
}
.page-orchestration ::v-deep .el-button--primary {
  background: linear-gradient(135deg, #22d3ee, #3b82f6);
  border-color: transparent;
  color: #fff;
}
.page-orchestration ::v-deep .el-button--primary:hover {
  background: linear-gradient(135deg, #38bdf8, #60a5fa);
  color: #fff;
  box-shadow: 0 0 16px rgba(56, 189, 248, 0.4);
}
.page-orchestration ::v-deep .el-button--success {
  background: linear-gradient(135deg, #34d399, #10b981);
  border-color: transparent;
  color: #fff;
}
.page-orchestration ::v-deep .el-button--success:hover {
  background: linear-gradient(135deg, #6ee7b7, #34d399);
  color: #fff;
  box-shadow: 0 0 16px rgba(52, 211, 153, 0.4);
}
.page-orchestration ::v-deep .el-button--danger.is-plain {
  background: rgba(248, 113, 113, 0.1);
  border-color: rgba(248, 113, 113, 0.4);
  color: #f87171;
}
.page-orchestration ::v-deep .el-button--danger.is-plain:hover {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}
.page-orchestration ::v-deep .el-button.is-disabled {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(255, 255, 255, 0.06);
  color: #475569;
}
.page-orchestration ::v-deep .el-button-group .el-button:first-child {
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
}
.page-orchestration ::v-deep .el-button-group .el-button:last-child {
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
}
.page-orchestration ::v-deep .el-form-item__label {
  color: #94a3b8;
}
.page-orchestration ::v-deep .el-select .el-input__inner {
  background: rgba(255, 255, 255, 0.05);
}
.page-orchestration ::v-deep .el-divider--vertical {
  background: rgba(255, 255, 255, 0.15);
}

/* ---------- 节点编辑弹窗 ---------- */
.node-editor-dialog {
  background: #1e293b;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.node-editor-dialog ::v-deep .el-dialog__title {
  color: #e2e8f0;
}
.node-editor-dialog ::v-deep .el-dialog__header {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.node-editor-dialog ::v-deep .el-dialog__body {
  color: #cbd5e1;
}
.node-editor-dialog ::v-deep .el-dialog__headerbtn .el-dialog__close {
  color: #94a3b8;
}
.node-editor-dialog ::v-deep .el-dialog__headerbtn:hover .el-dialog__close {
  color: #f87171;
}
.node-editor-dialog ::v-deep .el-input__inner,
.node-editor-dialog ::v-deep .el-textarea__inner {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.12);
  color: #e2e8f0;
}
.node-editor-dialog ::v-deep .el-form-item__label {
  color: #94a3b8;
}

/* ---------- 滚动条 ---------- */
.page-orchestration ::v-deep .palette-groups::-webkit-scrollbar,
.page-orchestration ::v-deep .panel-body::-webkit-scrollbar,
.page-orchestration ::v-deep .run-log-body::-webkit-scrollbar {
  width: 6px;
}
.page-orchestration ::v-deep .palette-groups::-webkit-scrollbar-thumb,
.page-orchestration ::v-deep .panel-body::-webkit-scrollbar-thumb,
.page-orchestration ::v-deep .run-log-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
.page-orchestration ::v-deep .palette-groups::-webkit-scrollbar-track,
.page-orchestration ::v-deep .panel-body::-webkit-scrollbar-track,
.page-orchestration ::v-deep .run-log-body::-webkit-scrollbar-track {
  background: transparent;
}
</style>
