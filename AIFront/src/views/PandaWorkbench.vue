<template>
  <div class="panda-workbench" tabindex="0" @keydown="onWorkbenchKeydown">
    <aside class="panda-sidebar">
      <div class="panda-sidebar-head">
        <div class="panda-brand">
          <span class="panda-brand-mark">✻</span>
          <span>Panda</span>
        </div>
        <button type="button" class="panda-new-btn" @click="createSession">New</button>
      </div>
      <el-input
        v-model="sessionQuery"
        size="mini"
        clearable
        prefix-icon="el-icon-search"
        placeholder="Search"
        class="panda-search"
      />
      <div class="panda-session-list">
        <div
          v-for="s in filteredSessions"
          :key="s.id"
          class="panda-session-item"
          :class="{ active: s.id === sessionId, busy: sending && s.id === sessionId, pending: sessionId === s.id && (!!permission || !!teamPermission) }"
          @click="openSession(s.id)"
        >
          <div class="panda-session-row">
            <div class="panda-session-title">
              <span v-if="sending && s.id === sessionId" class="panda-session-dot">●</span>
              {{ s.title || 'Untitled' }}
            </div>
            <button type="button" class="panda-session-del" title="删除" @click.stop="removeSession(s.id)">×</button>
          </div>
          <div class="panda-session-meta">{{ formatTime(s.updatedAt) }}</div>
          <div v-if="s.lastMessage" class="panda-session-preview">{{ s.lastMessage }}</div>
        </div>
        <div v-if="!filteredSessions.length" class="panda-session-empty">No sessions</div>
      </div>
    </aside>

    <main class="panda-main">
      <header class="panda-topbar">
        <div class="panda-topbar-left">
          <span class="panda-top-title">{{ currentTitle }}</span>
          <span class="panda-top-sub">session</span>
          <span class="panda-bridge-pill" :class="bridgeStatus">{{ bridgeLabel }}</span>
          <span class="panda-chip mode" :class="'mode-' + permissionMode" :title="permissionModeHint">{{ modeCycleLabel }}</span>
          <span v-if="contextPct != null" class="panda-chip context" :class="{ hot: contextPct >= 75 }" :title="'~' + (contextTokens || 0) + ' / ' + (contextLimit || '?') + ' tok'">ctx {{ contextPct }}%</span>
          <span v-if="worktreeInfo.active" class="panda-chip wt" :title="worktreeInfo.path">worktree · {{ worktreeInfo.branch || '…' }}</span>
          <span v-if="compactHint" class="panda-chip compact">{{ compactHint }}</span>
          <span class="panda-chip sandbox" :title="sandboxHint">{{ sandboxLabel }}</span>
          <span class="panda-chip vision" :class="{ on: multimodalEnabled }" :title="visionHint">{{ multimodalEnabled ? 'vision on' : 'vision off' }}</span>
          <span v-if="usage.total_tokens" class="panda-usage">{{ usage.total_tokens }} tok · ${{ usage.est_cost_usd || 0 }}</span>
          <span v-if="vimMode" class="panda-vim-pill on">{{ vimInsert ? 'INSERT' : 'NORMAL' }}</span>
        </div>
        <div class="panda-topbar-right">
          <el-checkbox v-model="verbose" size="mini" class="panda-verbose">详细</el-checkbox>
          <el-select v-model="model" size="mini" style="width: 168px; margin-left: 8px" @change="onModelChange">
            <el-option-group label="文本">
              <el-option v-for="m in chatModels" :key="m" :label="m" :value="m" />
            </el-option-group>
            <el-option-group v-if="visionModels.length" label="视觉（可贴图）">
              <el-option v-for="m in visionModels" :key="'v-' + m" :label="m + ' · vision'" :value="m" />
            </el-option-group>
          </el-select>
          <el-select v-model="activeFile" size="mini" clearable filterable placeholder="目标文件" style="width: 200px; margin-left: 8px">
            <el-option v-for="f in viewFiles" :key="f" :label="f" :value="f" />
          </el-select>
          <button type="button" class="panda-ghost-btn" @click="quick('/help')">/help</button>
        </div>
      </header>

      <div v-if="permissionMode === 'plan' || agentMode === 'plan'" class="panda-plan-banner">
        <span class="panda-plan-mark">⏸</span>
        <div class="panda-plan-text">
          <strong>Plan mode</strong>
          <span>只读探索与规划 · 写业务文件会被拒绝 · Agent 调 exit_plan_mode 批准计划后再实施</span>
        </div>
        <button type="button" class="panda-ghost-btn" @click="leavePlanModeUi">退出 Plan（解锁写入）</button>
      </div>

      <div v-if="lastPlanText" class="panda-plan-panel">
        <div class="panda-plan-panel-head">
          <span>Approved plan</span>
          <button type="button" class="panda-ghost-btn" @click="lastPlanText = ''">关闭</button>
        </div>
        <pre class="panda-plan-body">{{ lastPlanText }}</pre>
      </div>

      <div v-if="todos.length" class="panda-todo-panel">
        <div class="panda-todo-head">
          <span>Tasks</span>
          <span class="panda-todo-count">{{ todoOpenCount }}/{{ todos.length }}</span>
        </div>
        <div v-for="t in todos" :key="t.id" class="panda-todo-item" :class="'st-' + (t.status || 'pending')">
          <span class="panda-todo-mark">{{ todoMark(t.status) }}</span>
          <span class="panda-todo-body">{{ t.content || t.id }}</span>
        </div>
      </div>

      <div ref="scroll" class="panda-messages" @scroll="onScroll">
        <div v-if="!blocks.length" class="panda-hero">
          <div class="panda-hero-mark">✻</div>
          <div class="panda-hero-title">Panda</div>
          <div class="panda-hero-desc">工具循环 · 看见再改 · 多轮做到完</div>
          <div class="panda-hero-hints">
            <button type="button" @click="quick('页面很丑，先 capture_page 看指令市场再改好看')">截图后美化指令市场</button>
            <button type="button" @click="quick('/lsp ' + (activeFile || 'src/views/CommandMarket.vue'))">/lsp 诊断当前文件</button>
            <button type="button" @click="quick('/swarm 分析如何优化指令市场卡片布局与间距')">/swarm 并行分析样式</button>
            <button type="button" @click="quick('/help')">查看斜杠命令</button>
          </div>
          <div class="panda-hero-tip">换任务请 /clear · 美化请 Cmd+V 粘贴截图或 capture_page · Ctrl+O 思考 · Esc 停止</div>
        </div>

        <div v-for="(b, idx) in displayBlocks" :key="b._key || idx" class="panda-row" :class="['type-' + b.type, { turn: isTurnStart(b, idx) }]">
          <div v-if="b.type === 'user'" class="panda-user">
            <span class="panda-gutter panda-prefix">❯&nbsp;</span>
            <div class="panda-user-text">{{ userDisplayText(b) }}</div>
          </div>

          <div v-else-if="b.type === 'thinking'" class="panda-thinking" :class="{ streaming: b.streaming, open: isThinkOpen(b) }">
            <button type="button" class="panda-think-toggle" @click="toggleThink(b._key)">
              <span class="panda-think-label">∴ Thinking{{ b.streaming || isThinkOpen(b) ? '…' : '' }}</span>
              <span class="panda-think-hint">(ctrl+o to {{ isThinkOpen(b) ? 'collapse' : 'expand' }})</span>
            </button>
            <div v-if="isThinkOpen(b)" class="panda-think-body">
              <chat-content :content="b.content" :streaming="!!b.streaming" />
            </div>
            <div v-else-if="b.streaming && thinkPeek(b)" class="panda-think-peek">{{ thinkPeek(b) }}</div>
          </div>

          <div v-else-if="b.type === 'assistant_text'" class="panda-assistant">
            <span class="panda-gutter panda-dot">⏺</span>
            <div class="panda-md-body">
              <chat-content :content="b.content" :streaming="!!b.streaming" />
            </div>
          </div>

          <div
            v-else-if="b.type === 'tool_group'"
            class="panda-tool panda-tool-group"
            :class="{ active: isGroupActive(b), bash: isBashGroup(b) }"
            @click="toggleGroup(b._key)"
          >
            <span
              class="panda-gutter panda-dot"
              :class="{ running: isGroupActive(b), done: !isGroupActive(b) && !groupHasError(b), error: groupHasError(b) }"
            >{{ blinkDot(isGroupActive(b)) }}</span>
            <span v-if="isBashGroup(b)" class="panda-bash-bang">!</span>
            <span class="panda-tool-summary" :class="{ dim: !isGroupActive(b) }">{{ groupLabel(b) }}</span>
            <div v-if="groupOpen[b._key]" class="panda-group-items" @click.stop>
              <div v-for="(it, gi) in b.items" :key="gi" class="panda-group-item">
                <div class="panda-group-item-head">
                  <span class="panda-result-prefix">  ⎿&nbsp;</span>
                  <span class="panda-tool-name">{{ it.facing || it.name }}</span>
                  <span v-if="it.detail" class="panda-tool-detail">({{ it.detail }})</span>
                </div>
                <div
                  v-if="groupItemResult(b, it, gi)"
                  class="panda-group-item-result"
                  :class="{ err: groupItemResult(b, it, gi).ok === false }"
                >
                  <span class="panda-result-prefix">  ⎿&nbsp;</span>
                  <span class="panda-result-preview">{{ shortPreview(groupItemResult(b, it, gi)) }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="groupHint(b)" class="panda-group-hint">
              <span class="panda-result-prefix">  ⎿&nbsp;</span>
              <span>{{ groupHint(b) }}</span>
            </div>
          </div>

          <div v-else-if="b.type === 'tool_use'" class="panda-tool" :class="{ bash: isBashToolRow(b) }">
            <span
              class="panda-gutter panda-dot"
              :class="{
                running: b.status === 'running' || b.status === 'awaiting_permission',
                done: b.status === 'done',
                error: b.status === 'error'
              }"
            >{{ blinkDot(b.status === 'running' || b.status === 'awaiting_permission') }}</span>
            <span v-if="isBashToolRow(b)" class="panda-bash-bang">!</span>
            <span class="panda-tool-name">{{ b.facing || b.name }}</span>
            <span v-if="b.detail" class="panda-tool-detail">({{ b.detail }})</span>
            <div v-if="b.status === 'awaiting_permission'" class="panda-tool-await-line">
              <span class="panda-result-prefix">  ⎿&nbsp;</span>
              <span class="panda-tool-await">Waiting for permission…</span>
            </div>
          </div>

          <div v-else-if="b.type === 'tool_result'" class="panda-tool-result" :class="{ err: b.ok === false, expanded: resultOpen[b._key] }">
            <span class="panda-result-prefix">  ⎿&nbsp;</span>
            <div class="panda-result-wrap">
              <div v-if="isDiffResult(b)" class="panda-ink-diff" @click="toggleResult(b._key)">
                <div
                  v-for="(ln, li) in diffLines(b)"
                  :key="li"
                  class="panda-diff-line"
                  :class="ln.kind"
                >{{ ln.text }}</div>
              </div>
              <div
                v-else-if="!resultOpen[b._key] && !shouldRenderResultMd(b)"
                class="panda-result-preview"
                @click="toggleResult(b._key)"
              >{{ shortPreview(b) }}</div>
              <div v-else-if="shouldRenderResultMd(b)" class="panda-result-md" :class="{ collapsed: !resultOpen[b._key] }">
                <chat-content :content="formatResultMd(b)" :streaming="false" />
                <button
                  v-if="(b.content || b.preview || '').length > 400"
                  type="button"
                  class="panda-expand-btn"
                  @click="toggleResult(b._key)"
                >{{ resultOpen[b._key] ? '(click to collapse)' : '(click to expand)' }}</button>
              </div>
              <pre v-else class="panda-result-body" @click="toggleResult(b._key)">{{ b.content || b.preview }}</pre>
            </div>
          </div>

          <div v-else-if="b.type === 'system'" class="panda-system" :class="'sys-' + systemKind(b)">
            <span class="panda-sys-mark">{{ systemMark(b) }}</span>
            <span>{{ b.content }}</span>
          </div>
        </div>

        <div v-if="sending" class="panda-spinner">
          <span class="panda-spinner-glyph">{{ spinnerGlyph }}</span>
          <span class="panda-spinner-verb shimmer">{{ spinnerVerb }}…</span>
          <span class="panda-spinner-meta">({{ spinnerMeta }})</span>
        </div>
      </div>

      <footer class="panda-prompt">
        <div v-if="teamPermission" class="panda-perm panda-perm-sticky bash">
          <div class="panda-perm-head">
            <div class="panda-perm-title">Team permission · {{ teamPermission.fromMember || 'member' }}</div>
            <div class="panda-perm-sub">{{ teamPermission.tool }} · {{ teamPermission.detail }}</div>
          </div>
          <div class="panda-perm-question">批准队友的工具请求？</div>
          <div class="panda-perm-actions">
            <button type="button" class="panda-perm-btn yes" @click="resolveTeamPerm(true)">1. Allow</button>
            <button type="button" class="panda-perm-btn no" @click="resolveTeamPerm(false)">2. Deny</button>
          </div>
        </div>
        <div v-if="permission" class="panda-perm panda-perm-sticky" :class="{ bash: permission.risk === 'bash' || permission.tool === 'bash' || permission.tool === 'bash_bg' || permission.tool === 'powershell' }">
          <div class="panda-perm-head">
            <div class="panda-perm-title">{{ permTitle }}</div>
            <div class="panda-perm-sub">{{ permission.detail }}</div>
          </div>
          <div v-if="permission.diff" class="panda-perm-diff panda-ink-diff" :class="{ expanded: permDiffExpanded }">
            <div
              v-for="(ln, li) in parseDiffText(permission.diff, permDiffExpanded ? 400 : 120)"
              :key="li"
              class="panda-diff-line"
              :class="ln.kind"
            >{{ ln.text }}</div>
            <button
              v-if="(permission.diff || '').split('\n').length > 120"
              type="button"
              class="panda-expand-btn"
              @click="permDiffExpanded = !permDiffExpanded"
            >{{ permDiffExpanded ? '(collapse diff)' : '(expand full diff)' }}</button>
          </div>
          <div v-else-if="permission.preview" class="panda-perm-preview">{{ permission.preview }}</div>
          <div class="panda-perm-question">{{ permQuestion }}</div>
          <div v-if="permission.reason" class="panda-perm-reason">{{ permission.reason }}</div>
          <div class="panda-perm-actions">
            <template v-if="permission.tool === 'exit_plan_mode'">
              <button type="button" class="panda-perm-btn yes" @click="resolveExitPlan('acceptEdits')">1. Yes, approve → accept edits</button>
              <button type="button" class="panda-perm-btn yes-all" @click="resolveExitPlan('bypassPermissions')">2. Yes, approve → bypass</button>
              <button type="button" class="panda-perm-btn yes-all" @click="resolveExitPlan('auto')">3. Yes, approve → auto</button>
              <button type="button" class="panda-perm-btn yes-all" @click="resolveExitPlan('default')">4. Yes, approve → default</button>
              <button type="button" class="panda-perm-btn no" @click="resolvePerm(false)">5. No</button>
            </template>
            <template v-else>
              <button type="button" class="panda-perm-btn yes" @click="resolvePerm(true)">1. {{ permYesLabel }}</button>
              <button
                v-if="permAllowSuggestion"
                type="button"
                class="panda-perm-btn yes-all"
                @click="resolvePermDontAskAgain"
              >2. Yes, don't ask again for {{ permAllowSuggestion.label }}</button>
              <button
                v-if="permission.risk !== 'bash'"
                type="button"
                class="panda-perm-btn yes-all"
                @click="resolvePermAllowAll"
              >{{ permAllowSuggestion ? '3' : '2' }}. Yes, allow all edits during this session</button>
              <button
                v-if="permission.risk === 'bash'"
                type="button"
                class="panda-perm-btn yes-all"
                @click="resolvePermAllowAll"
              >{{ permAllowSuggestion ? '3' : '2' }}. Yes, allow bash this session</button>
              <button type="button" class="panda-perm-btn no" @click="resolvePerm(false)">{{ permAllowSuggestion ? '4' : '3' }}. No</button>
              <button type="button" class="panda-perm-btn no-session" @click="resolvePermDenySession">{{ permAllowSuggestion ? '5' : '4' }}. No, deny this session</button>
              <button type="button" class="panda-perm-btn no-persist" @click="resolvePermDenyPersist">{{ permAllowSuggestion ? '6' : '5' }}. No, remember deny</button>
            </template>
          </div>
          <div class="panda-perm-footer">数字键 1–6 · Esc 拒绝 · Shift+Tab 切模式</div>
        </div>
        <div v-if="queuedMessages.length" class="panda-queue">
          <div class="panda-queue-head">
            <span>Queued ({{ queuedMessages.length }})</span>
            <button type="button" class="panda-ghost-btn" @click="queuedMessages = []">清空</button>
          </div>
          <div v-for="(q, qi) in queuedMessages" :key="'q' + qi" class="panda-queue-item">
            <span class="panda-prefix">❯&nbsp;</span>
            <span class="panda-queue-text" @click="editQueued(qi)">{{ q.text }}</span>
            <button type="button" class="panda-session-del" title="移除" @click="queuedMessages.splice(qi, 1)">×</button>
          </div>
        </div>
        <div v-if="mcpOAuth" class="panda-mcp-oauth">
          <div class="panda-mcp-oauth-title">MCP OAuth 待授权</div>
          <div v-for="(info, name) in mcpOAuth.pending" :key="name" class="panda-mcp-oauth-row">
            <div class="panda-mcp-oauth-name">{{ name }}</div>
            <a v-if="info.url" class="panda-mcp-oauth-link" :href="info.url" target="_blank" rel="noopener">打开授权页</a>
            <input v-model="mcpOAuthTokens[name]" class="panda-mcp-oauth-input" placeholder="粘贴 access_token" />
            <button type="button" class="panda-perm-btn yes" @click="submitMcpToken(name)">写入 token</button>
          </div>
          <button type="button" class="panda-ghost-btn" @click="mcpOAuth = null">关闭</button>
        </div>
        <div v-if="clarification" class="panda-clarify">
          <div>需要确认：{{ clarification }}</div>
          <div v-if="clarifyOptions.length" class="panda-clarify-opts">
            <button
              v-for="(opt, oi) in clarifyOptions"
              :key="oi"
              type="button"
              class="panda-opt-btn"
              @click="pickClarify(opt)"
            >{{ typeof opt === 'string' ? opt : (opt.label || opt.value || opt) }}</button>
          </div>
        </div>
        <div v-if="pendingImages.length" class="panda-images">
          <div v-for="(img, ii) in pendingImages" :key="ii" class="panda-image-chip">
            <img :src="img.dataUrl" alt="paste" />
            <button type="button" @click="pendingImages.splice(ii, 1)">×</button>
          </div>
        </div>
        <div class="panda-input-shell" :class="['mode-' + permissionMode, { waiting: !!(permission || teamPermission) }]">
          <span class="panda-input-prefix">❯&nbsp;</span>
          <textarea
            ref="prompt"
            v-model="input"
            class="panda-textarea"
            rows="3"
            :disabled="!!(permission || teamPermission)"
            :placeholder="permission || teamPermission
              ? '等待权限确认…'
              : (sending
              ? (queuedMessages.length ? '运行中 · Enter 排队下一条…' : '运行中 · Enter 可排队 · Esc 停止')
              : (vimMode && !vimInsert ? 'VIM NORMAL · i 插入' : '输入需求 · / 斜杠 · 美化请先 Cmd+V 粘贴截图'))"
            @keydown="onPromptKeydown"
            @input="onPromptInput"
            @compositionstart="onImeStart"
            @compositionupdate="onImeStart"
            @compositionend="onImeEnd"
            @paste="onPaste"
          />
        </div>
        <div v-if="slashOpen && slashFiltered.length" class="panda-slash-menu">
          <button
            v-for="(cmd, si) in slashFiltered"
            :key="cmd.name"
            type="button"
            class="panda-slash-item"
            :class="{ active: si === slashIndex }"
            @mousedown.prevent="applySlash(cmd)"
          >
            <span class="panda-slash-name">/{{ cmd.name }}</span>
            <span class="panda-slash-desc">{{ cmd.desc }}{{ cmd.stub ? ' · stub' : '' }}</span>
          </button>
        </div>
        <div class="panda-prompt-bar">
          <button type="button" class="panda-mode-cycle" :class="'mode-' + permissionMode" @click="cyclePermissionMode" :title="permissionModeHint">
            {{ modeCycleLabel }}
          </button>
          <div class="panda-prompt-actions">
            <button v-if="sending" type="button" class="panda-stop-btn" :disabled="aborting" @click="stopRun">{{ aborting ? 'Stopping…' : '停止' }}</button>
            <button type="button" class="panda-send-btn" :disabled="!input.trim()" @click="send">{{ sending ? '排队' : '发送' }}</button>
          </div>
        </div>
      </footer>
    </main>
  </div>
</template>

<script>
import ChatContent from '@/components/ChatContent.vue'
import { createVimController } from '@/utils/vimEngine'
import { getRecentErrors, flushToServer, setCaptureSessionId } from '@/utils/consoleCapture'

const COLLAPSE_TOOLS = new Set(['read_file', 'grep', 'glob', 'Read', 'Grep', 'Glob'])
const COLLAPSE_BASH = new Set(['bash', 'Bash', 'bash_bg', 'powershell', 'PowerShell'])
// Ink: default → acceptEdits → plan → bypassPermissions → auto → dontAsk
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']
const PERMISSION_MODE_META = {
  default: { label: 'default', short: 'default' },
  acceptEdits: { label: '⏵⏵ accept edits', short: 'accept edits' },
  plan: { label: '⏸ plan mode on', short: 'plan' },
  bypassPermissions: { label: '⏵⏵ bypass permissions on', short: 'bypass' },
  auto: { label: '⏵⏵ auto mode', short: 'auto' },
  dontAsk: { label: "⏵⏵ don't ask", short: 'dontAsk' }
}
// Ink SpinnerGlyph: darwin chars + reverse
const SPINNER_CHARS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPINNER_FRAMES = SPINNER_CHARS.concat(SPINNER_CHARS.slice().reverse())
const SPINNER_VERBS = [
  'Accomplishing', 'Baking', 'Brewing', 'Calculating', 'Clauding', 'Cogitating',
  'Composing', 'Computing', 'Considering', 'Contemplating', 'Cooking', 'Crafting',
  'Crunching', 'Deciphering', 'Doing', 'Enchanting', 'Envisioning', 'Generating',
  'Ideating', 'Manifesting', 'Pondering', 'Reasoning', 'Thinking', 'Tinkering',
  'Vibing', 'Working', 'Wrangling'
]

function loadPermissionMode () {
  try {
    const v = localStorage.getItem('panda_permission_mode') || localStorage.getItem('claw_permission_mode')
    if (PERMISSION_MODES.indexOf(v) >= 0) return v
  } catch (e) { /* ignore */ }
  return 'acceptEdits'
}

function isCollapsibleTool (b) {
  if (!b || b.type !== 'tool_use') return false
  return COLLAPSE_TOOLS.has(b.name) || COLLAPSE_TOOLS.has(b.facing)
}

function isBashTool (b) {
  if (!b || b.type !== 'tool_use') return false
  return COLLAPSE_BASH.has(b.name) || COLLAPSE_BASH.has(b.facing)
}

function parseDiffText (raw, limitIn) {
  const text = String(raw || '')
  const lines = text.split('\n')
  const out = []
  const limit = limitIn != null ? limitIn : 120
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]
    let kind = 'ctx'
    if (/^(\+\+\+|---|diff |index |@@)/.test(line)) kind = 'meta'
    else if (line.startsWith('+')) kind = 'add'
    else if (line.startsWith('-')) kind = 'del'
    out.push({ kind, text: line || ' ' })
  }
  if (lines.length > limit) out.push({ kind: 'meta', text: '…[diff truncated · ' + lines.length + ' lines]' })
  return out
}

export default {
  name: 'PandaWorkbench',
  components: { ChatContent },
  data () {
    return {
      sessions: [],
      sessionQuery: '',
      sessionId: '',
      blocks: [],
      input: '',
      sending: false,
      model: 'deepseek-chat',
      activeFile: '',
      viewFiles: [
        'src/views/CommandMarket.vue',
        'src/views/CommandDetail.vue',
        'src/App.vue',
        'src/router/index.js'
      ],
      clarification: '',
      stickBottom: true,
      permission: null,
      permissionMode: loadPermissionMode(),
      agentMode: 'default',
      todos: [],
      slashCommands: [],
      slashOpen: false,
      slashIndex: 0,
      mcpOAuth: null,
      mcpOAuthTokens: {},
      worktreeInfo: { active: false, path: '', branch: '' },
      compactHint: '',
      contextPct: null,
      contextTokens: 0,
      contextLimit: 0,
      chatModels: ['deepseek-chat', 'deepseek-reasoner'],
      visionModels: [],
      multimodalEnabled: false,
      visionHint: '',
      lastPlanText: '',
      queuedMessages: [],
      sessionAllowRules: [],
      sessionDenyRules: [],
      permDiffExpanded: false,
      verbose: false,
      groupOpen: {},
      resultOpen: {},
      bridgeWs: null,
      bridgeStatus: 'off',
      bridgeClients: 0,
      sandboxLabel: 'sandbox · regex',
      sandboxHint: 'Shell 安全为危险命令正则拦截；可在 .panda/config.json 开 osSandbox',
      teamPermission: null,
      thinkOpen: {},
      usage: { total_tokens: 0, est_cost_usd: 0 },
      clarifyOptions: [],
      aborting: false,
      vimMode: false,
      vimInsert: true,
      pendingImages: [],
      imeComposing: false,
      imeSwallowEnter: false,
      workStatus: '',
      executeAbort: null,
      spinnerFrame: 0,
      spinnerVerb: 'Thinking',
      workStartedAt: 0,
      workNow: 0,
      _spinnerTimer: null,
      _runSeq: 0,
      _attachingRun: false
    }
  },
  computed: {
    filteredSessions () {
      const q = (this.sessionQuery || '').trim().toLowerCase()
      if (!q) return this.sessions
      return this.sessions.filter(s =>
        String(s.title || '').toLowerCase().includes(q) ||
        String(s.lastMessage || '').toLowerCase().includes(q)
      )
    },
    currentTitle () {
      const s = this.sessions.find(x => x.id === this.sessionId)
      return (s && s.title) || 'Panda'
    },
    bridgeLabel () {
      if (this.bridgeStatus === 'on') {
        return this.bridgeClients > 0 ? ('Bridge · ' + this.bridgeClients) : 'Bridge'
      }
      if (this.bridgeStatus === 'connecting') return 'Bridge…'
      return ''
    },
    permissionModeHint () {
      if (this.permissionMode === 'bypassPermissions') {
        return 'bypass · 过规则后放行（无 LLM；safetyCheck / ask 规则仍问）'
      }
      if (this.permissionMode === 'auto') {
        return 'auto · CWD 写快路径 + 白名单 + LLM 分类器（对齐 panda-code auto）'
      }
      if (this.permissionMode === 'dontAsk') {
        return "don't ask · 未批准的操作直接拒绝（只读/白名单仍放行）"
      }
      if (this.permissionMode === 'acceptEdits') return 'accept edits · CWD 内写自动过，只读/文件系统 bash 放行'
      if (this.permissionMode === 'plan') return 'plan · 只读规划，写业务文件硬拒'
      return 'default · 写需确认；只读 bash 放行'
    },
    permAllowSuggestion () {
      const list = (this.permission && this.permission.suggestions) || []
      return list[0] || null
    },
    modeCycleLabel () {
      const m = PERMISSION_MODE_META[this.permissionMode]
      return (m && m.label) || this.permissionMode
    },
    todoOpenCount () {
      return (this.todos || []).filter(t => t && t.status !== 'completed' && t.status !== 'cancelled').length
    },
    slashFiltered () {
      const raw = String(this.input || '')
      const m = raw.match(/^\/([^\s]*)$/)
      if (!m) return []
      const q = String(m[1] || '').toLowerCase()
      const list = (this.slashCommands || []).filter(c => {
        if (c.stub) return false
        if (!q) return true
        return c.name.indexOf(q) === 0 || c.name.indexOf(q) >= 0
      })
      return list.slice(0, 12)
    },
    permTitle () {
      const t = (this.permission && this.permission.tool) || ''
      if (t === 'exit_plan_mode') return 'Approve plan'
      if (t === 'write_file' || t === 'Write') return 'Overwrite file'
      if (t === 'edit_file' || t === 'Edit' || t === 'apply_patch' || t === 'edit_lines') return 'Edit file'
      if (t === 'bash' || t === 'Bash' || t === 'bash_bg') return 'Run bash'
      return t || 'Permission'
    },
    permBasename () {
      const d = (this.permission && this.permission.detail) || ''
      const parts = String(d).split(/[/\\]/)
      return parts[parts.length - 1] || d || 'file'
    },
    permQuestion () {
      const p = this.permission
      if (!p) return ''
      if (p.tool === 'exit_plan_mode') {
        return 'Approve this plan and exit Plan Mode to start implementation?'
      }
      if (p.risk === 'bash' || p.tool === 'bash' || p.tool === 'bash_bg') {
        return 'Do you want to run this command?'
      }
      if (p.tool === 'write_file') {
        return 'Do you want to overwrite ' + this.permBasename + '?'
      }
      return 'Do you want to make this edit to ' + this.permBasename + '?'
    },
    permYesLabel () {
      if (this.permission && this.permission.tool === 'exit_plan_mode') return 'Yes, approve plan'
      return 'Yes'
    },
    spinnerGlyph () {
      return SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]
    },
    workElapsedLabel () {
      if (!this.workStartedAt) return '0s'
      const ms = Math.max(0, this.workNow - this.workStartedAt)
      if (ms < 60000) return Math.floor(ms / 1000) + 's'
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      if (seconds === 60) return (minutes + 1) + 'm'
      return minutes + 'm ' + seconds + 's'
    },
    spinnerMeta () {
      const parts = [this.workElapsedLabel]
      if (this.usage && this.usage.total_tokens) {
        parts.push('↓ ' + this.usage.total_tokens + ' tokens')
      }
      if (this.workStatus) {
        const s = String(this.workStatus)
        if (!/^\d+s$|^\d+m/.test(s) && s.length < 48) parts.push(s)
      }
      return parts.filter(Boolean).join(' · ')
    },
    displayBlocks () {
      if (this.verbose) return this.blocks
      const out = []
      const blocks = this.blocks
      let i = 0
      while (i < blocks.length) {
        const b = blocks[i]
        if (isCollapsibleTool(b)) {
          let j = i
          const items = []
          while (j < blocks.length && isCollapsibleTool(blocks[j])) {
            items.push(blocks[j])
            j++
          }
          const results = []
          const ids = new Set(items.map(it => it.id).filter(Boolean))
          while (j < blocks.length && blocks[j].type === 'tool_result') {
            const r = blocks[j]
            if (ids.size && r.id && !ids.has(r.id)) break
            results.push(r)
            j++
          }
          if (items.length >= 2) {
            out.push({
              type: 'tool_group',
              kind: 'readsearch',
              facing: items[0].facing || 'Read',
              count: items.length,
              items,
              results,
              _key: 'grp_' + (items[0]._key || j)
            })
          } else {
            out.push(items[0])
            if (results[0]) out.push(results[0])
          }
          i = j
          continue
        }
        // 连续 Bash / PowerShell 折叠
        if (!this.verbose && isBashTool(b)) {
          let j = i
          const items = []
          while (j < blocks.length && isBashTool(blocks[j])) {
            items.push(blocks[j])
            j++
          }
          const results = []
          const ids = new Set(items.map(it => it.id).filter(Boolean))
          while (j < blocks.length && blocks[j].type === 'tool_result') {
            const r = blocks[j]
            if (ids.size && r.id && !ids.has(r.id)) break
            results.push(r)
            j++
          }
          if (items.length >= 2) {
            out.push({
              type: 'tool_group',
              kind: 'bash',
              facing: 'Bash',
              count: items.length,
              items,
              results,
              _key: 'bash_' + (items[0]._key || j)
            })
            i = j
            continue
          }
        }
        out.push(b)
        i++
      }
      return out
    }
  },
  async created () {
    await this.refreshSessions()
    if (!this.sessions.length) {
      await this.createSession()
    } else {
      await this.openSession(this.sessions[0].id)
    }
    this.loadViewFiles()
    this.loadSlashCommands()
    this.loadModels()
    this.loadSandboxStatus()
    this._onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' &&
          this.sessionId && !this.sending && !this._attachingRun) {
        this.tryAttachLiveRun(this.sessionId, { silent: true })
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVis)
    }
  },
  beforeDestroy () {
    this.closeBridge()
    this.stopSpinner()
    if (typeof document !== 'undefined' && this._onVis) {
      document.removeEventListener('visibilitychange', this._onVis)
    }
  },
  watch: {
    sessionId (id) {
      this.connectBridge(id)
      setCaptureSessionId(id || '')
      if (id) flushToServer(id).catch(() => {})
    },
    sending (v) {
      if (v) this.startSpinner()
      else {
        this.stopSpinner()
        this.flushQueue()
      }
    }
  },
  methods: {
    async loadModels () {
      try {
        const res = await fetch('/api/panda/models')
        const data = await res.json()
        this.chatModels = (data.chat && data.chat.length) ? data.chat : ['deepseek-chat', 'deepseek-reasoner']
        this.visionModels = data.vision || []
        this.multimodalEnabled = !!data.multimodalEnabled
        this.visionHint = data.hint || ''
        if (data.defaultVision && this.multimodalEnabled && !this.model) {
          this.model = data.defaultVision
        }
      } catch (e) {
        this.visionHint = '无法加载模型列表'
      }
    },
    async loadSandboxStatus () {
      try {
        const res = await fetch('/api/panda/sandbox')
        const data = await res.json()
        if (!data) return
        if (data.enabled) {
          this.sandboxLabel = 'sandbox · ' + (data.backend || 'os')
          this.sandboxHint = 'OS sandbox 已开 · ' + (data.backend || '?') + ' · ' + (data.platform || '')
        } else {
          this.sandboxLabel = 'sandbox · regex'
          this.sandboxHint = '未开 osSandbox：仅正则/启发拦截。设 .panda/config.json osSandbox:true 或 PANDA_OS_SANDBOX=1'
        }
      } catch (e) { /* ignore */ }
    },
    onModelChange () {
      try { localStorage.setItem('panda_model', this.model) } catch (e) { /* ignore */ }
      const isVision = this.visionModels.indexOf(this.model) >= 0
      if (this.pendingImages.length && !isVision && !this.multimodalEnabled) {
        this.pushBlock({
          type: 'system',
          content: '当前模型看不见图片。请选视觉模型，或配置 DEEPSEEK_VISION_MODEL / DEEPSEEK_MULTIMODAL=1。'
        })
      }
    },
    async syncRuntimeMode (extra) {
      if (!this.sessionId) return
      try {
        await fetch('/api/panda/runtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            sessionId: this.sessionId,
            permissionMode: this.permissionMode,
            agentMode: this.agentMode
          }, extra || {}))
        })
      } catch (e) { /* ignore — no active run is ok */ }
    },
    startSpinner () {
      this.workStartedAt = Date.now()
      this.workNow = this.workStartedAt
      this.spinnerFrame = 0
      this.spinnerVerb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]
      this.stopSpinner()
      this._spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length
        this.workNow = Date.now()
        if (this.spinnerFrame % 12 === 0) {
          this.spinnerVerb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]
        }
      }, 120)
    },
    stopSpinner () {
      if (this._spinnerTimer) {
        clearInterval(this._spinnerTimer)
        this._spinnerTimer = null
      }
    },
    isThinkOpen (b) {
      if (!b) return false
      if (this.verbose) return true
      return this.thinkOpen[b._key] === true
    },
    thinkPeek (b) {
      const t = String((b && b.content) || '').trim()
      if (!t) return ''
      const lines = t.split(/\n/).filter(Boolean)
      const last = lines[lines.length - 1] || ''
      return last.length > 100 ? last.slice(0, 100) + '…' : last
    },
    toggleAllThinking () {
      const keys = this.blocks.filter(b => b.type === 'thinking').map(b => b._key)
      if (keys.length) {
        const anyClosed = keys.some(k => this.thinkOpen[k] !== true)
        keys.forEach(k => this.$set(this.thinkOpen, k, anyClosed))
      }
      // 同步折叠/展开工具组（对标 ctrl+o）
      const groups = this.displayBlocks.filter(b => b.type === 'tool_group')
      if (groups.length) {
        const anyClosed = groups.some(g => !this.groupOpen[g._key])
        groups.forEach(g => this.$set(this.groupOpen, g._key, anyClosed))
      }
    },
    onWorkbenchKeydown (e) {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        this.cyclePermissionMode()
        return
      }
      if (this.permission && /^[1-5]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        this.handlePermDigit(Number(e.key))
        return
      }
      if (e.key === 'Escape' && this.permission) {
        e.preventDefault()
        this.resolvePerm(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        this.toggleAllThinking()
        return
      }
      if (e.key === 'Escape' && this.sending) {
        e.preventDefault()
        this.stopRun()
      }
    },
    cyclePermissionMode () {
      const i = PERMISSION_MODES.indexOf(this.permissionMode)
      const next = PERMISSION_MODES[(i < 0 ? 0 : i + 1) % PERMISSION_MODES.length]
      this.permissionMode = next
      this.agentMode = next === 'plan' ? 'plan' : 'default'
      try { localStorage.setItem('panda_permission_mode', next) } catch (e) { /* ignore */ }
      this.pushBlock({
        type: 'system',
        content: this.permissionModeHint + (this.sending ? ' · 已同步运行中闸门' : '')
      })
      this.syncRuntimeMode()
      if (this.permission && this.permission.tool !== 'exit_plan_mode' &&
          (next === 'bypassPermissions' || (next === 'acceptEdits' && this.permission.risk !== 'bash'))) {
        this.resolvePerm(true)
      }
    },
    leavePlanModeUi () {
      this.permissionMode = 'acceptEdits'
      this.agentMode = 'default'
      try { localStorage.setItem('panda_permission_mode', 'acceptEdits') } catch (e) { /* ignore */ }
      this.syncRuntimeMode({ permissionMode: 'acceptEdits', agentMode: 'default' })
      this.pushBlock({
        type: 'system',
        content: '已退出 Plan UI（解锁写入 · accept edits）。正式「批准计划」请等 Agent 的 exit_plan_mode 弹窗。'
      })
      if (this.permission && this.permission.tool === 'exit_plan_mode') {
        this.resolveExitPlan('acceptEdits')
      }
    },
    isBashToolRow (b) {
      return isBashTool(b)
    },
    editQueued (qi) {
      const q = this.queuedMessages[qi]
      if (!q) return
      this.queuedMessages.splice(qi, 1)
      this.input = q.text || ''
      this.pendingImages = (q.images || []).slice()
      this.$nextTick(() => {
        const el = this.$refs.prompt
        if (el) el.focus()
      })
    },
    handlePermDigit (n) {
      if (!this.permission) return false
      const isExit = this.permission.tool === 'exit_plan_mode'
      if (isExit) {
        if (n === 1) { this.resolveExitPlan('acceptEdits'); return true }
        if (n === 2) { this.resolveExitPlan('bypassPermissions'); return true }
        if (n === 3) { this.resolveExitPlan('auto'); return true }
        if (n === 4) { this.resolveExitPlan('default'); return true }
        if (n === 5) { this.resolvePerm(false); return true }
        return false
      }
      const hasSug = !!this.permAllowSuggestion
      if (n === 1) { this.resolvePerm(true); return true }
      if (hasSug) {
        if (n === 2) { this.resolvePermDontAskAgain(); return true }
        if (n === 3) { this.resolvePermAllowAll(); return true }
        if (n === 4) { this.resolvePerm(false); return true }
        if (n === 5) { this.resolvePermDenySession(); return true }
        if (n === 6) { this.resolvePermDenyPersist(); return true }
      } else {
        if (n === 2) { this.resolvePermAllowAll(); return true }
        if (n === 3) { this.resolvePerm(false); return true }
        if (n === 4) { this.resolvePermDenySession(); return true }
        if (n === 5) { this.resolvePermDenyPersist(); return true }
      }
      return false
    },
    async resolveExitPlan (mode) {
      const next = mode || 'acceptEdits'
      this.permissionMode = next
      this.agentMode = 'default'
      try { localStorage.setItem('panda_permission_mode', next) } catch (e) { /* ignore */ }
      await this.syncRuntimeMode({ permissionMode: next, agentMode: 'default' })
      await this.resolvePerm(true, { permissionMode: next })
      this.pushBlock({ type: 'system', content: 'Plan approved → ' + next })
    },
    todoMark (status) {
      if (status === 'completed') return '✓'
      if (status === 'in_progress') return '●'
      if (status === 'cancelled') return '○'
      return '·'
    },
    async loadSlashCommands () {
      try {
        const res = await fetch('/api/panda/slash-commands')
        const data = await res.json()
        this.slashCommands = (data && data.commands) || []
      } catch (e) {
        this.slashCommands = []
      }
    },
    onPromptInput () {
      const open = /^\/[^\s]*$/.test(String(this.input || ''))
      this.slashOpen = open
      if (!open) this.slashIndex = 0
      else if (this.slashIndex >= this.slashFiltered.length) this.slashIndex = 0
    },
    applySlash (cmd) {
      if (!cmd) return
      this.input = '/' + cmd.name + ' '
      this.slashOpen = false
      this.slashIndex = 0
      this.$nextTick(() => {
        const el = this.$refs.prompt
        if (el) {
          el.focus()
          const n = this.input.length
          el.setSelectionRange(n, n)
        }
      })
    },
    async submitMcpToken (server) {
      const token = (this.mcpOAuthTokens && this.mcpOAuthTokens[server]) || ''
      if (!token.trim()) return
      try {
        const res = await fetch('/api/panda/mcp/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server, access_token: token.trim() })
        })
        const data = await res.json()
        this.pushBlock({
          type: 'system',
          content: data.ok
            ? ('MCP OAuth token 已写入：' + server + (data.connectError ? '（重连：' + data.connectError + '）' : ''))
            : ('写入失败：' + (data.error || 'unknown'))
        })
        if (data.ok && this.mcpOAuth && this.mcpOAuth.pending) {
          const next = Object.assign({}, this.mcpOAuth.pending)
          delete next[server]
          if (!Object.keys(next).length) this.mcpOAuth = null
          else this.mcpOAuth = { pending: next }
        }
      } catch (e) {
        this.pushBlock({ type: 'system', content: 'MCP token 写入失败：' + (e.message || e) })
      }
    },
    isGroupActive (b) {
      const items = (b && b.items) || []
      return items.some(it => it.status === 'running' || it.status === 'awaiting_permission')
    },
    isBashGroup (b) {
      return !!(b && (b.kind === 'bash' || b.facing === 'Bash'))
    },
    groupHasError (b) {
      const results = (b && b.results) || []
      if (results.some(r => r && r.ok === false)) return true
      const items = (b && b.items) || []
      return items.some(it => it.status === 'error')
    },
    blinkDot (running) {
      if (!running) return '⏺'
      // Ink ToolUseLoader：~500ms 闪烁 ⏺ / 空白
      return Math.floor((this.workNow || Date.now()) / 500) % 2 === 0 ? '⏺' : ' '
    },
    groupItemResult (b, it, gi) {
      const results = (b && b.results) || []
      if (it && it.id) {
        const hit = results.find(r => r && r.id === it.id)
        if (hit) return hit
      }
      return results[gi] || null
    },
    groupLabel (b) {
      const items = (b && b.items) || []
      const n = b.count || items.length || 0
      const active = this.isGroupActive(b)
      const hint = ' (ctrl+o to expand)'
      if (this.isBashGroup(b)) {
        const plural = n === 1 ? '' : 's'
        return (active ? 'Running ' : 'Ran ') + n + ' bash command' + plural + (active ? '…' : '') + hint
      }
      let reads = 0
      let greps = 0
      let globs = 0
      items.forEach(it => {
        const name = String(it.name || it.facing || '')
        if (/^grep$/i.test(name)) greps++
        else if (/^glob$/i.test(name)) globs++
        else reads++
      })
      const bits = []
      if (reads) {
        bits.push((active ? 'Reading ' : 'Read ') + reads + (reads === 1 ? ' file' : ' files'))
      }
      if (greps) {
        bits.push((active ? 'searching for ' : 'searched for ') + greps + (greps === 1 ? ' pattern' : ' patterns'))
      }
      if (globs) {
        bits.push((active ? 'listing ' : 'listed ') + globs + (globs === 1 ? ' path' : ' paths'))
      }
      if (!bits.length) {
        bits.push((active ? 'Reading ' : 'Read ') + n + (n === 1 ? ' file' : ' files'))
      }
      let label = bits[0]
      for (let i = 1; i < bits.length; i++) {
        const part = bits[i]
        label += ', ' + (active ? part : part.charAt(0).toLowerCase() + part.slice(1))
      }
      return label + (active ? '…' : '') + hint
    },
    groupHint (b) {
      const items = (b && b.items) || []
      if (!items.length) return ''
      const last = items[items.length - 1]
      return last.detail || last.facing || last.name || ''
    },
    userDisplayText (b) {
      const t = String((b && b.content) || '')
      if (t.length <= 10000) return t
      const omitted = t.length - 10000
      return t.slice(0, 5000) + '\n… +' + omitted + ' chars …\n' + t.slice(-5000)
    },
    systemKind (b) {
      const c = String((b && b.content) || '')
      if (/已中断|Stopping|⏹/.test(c)) return 'interrupt'
      if (/^Hook\(/i.test(c) || /^Stop:/i.test(c)) return 'hook'
      if (/Plan approved|permissionMode|accept edits|bypass|don't ask/i.test(c)) return 'mode'
      if (/compact|Context compacted/i.test(c)) return 'compact'
      if (/Team |Bridge /i.test(c)) return 'bridge'
      return 'default'
    },
    systemMark (b) {
      const k = this.systemKind(b)
      if (k === 'interrupt') return '⏹'
      if (k === 'hook') return '⚒'
      if (k === 'mode') return '⏵'
      if (k === 'compact') return '✂'
      if (k === 'bridge') return '⇄'
      return '✻'
    },
    isTurnStart (b, idx) {
      if (!b) return false
      if (b.type === 'user') return true
      if (b.type === 'tool_result') return false
      if (idx === 0) return true
      const prev = this.displayBlocks[idx - 1]
      if (!prev) return true
      if (prev.type === 'user') return true
      if (b.type === 'assistant_text' || b.type === 'thinking' || b.type === 'tool_group' || b.type === 'system') return true
      if (b.type === 'tool_use' && prev.type !== 'tool_use' && prev.type !== 'tool_result' && prev.type !== 'tool_group') return true
      return false
    },
    parseDiffText,
    isDiffResult (b) {
      const t = String(b.content || b.preview || '')
      return /^[-+]{3}\s|^@@ |^diff --git/m.test(t)
    },
    diffLines (b) {
      let t = String(b.content || b.preview || '')
      if (!this.resultOpen[b._key] && t.length > 4000) t = t.slice(0, 4000)
      return parseDiffText(t)
    },
    formatTime (iso) {
      if (!iso) return ''
      try {
        const d = new Date(iso)
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      } catch (e) {
        return ''
      }
    },
    shortPreview (b) {
      const t = String(b.preview || b.content || '')
      return t.length > 220 ? t.slice(0, 220) + '…' : t
    },
    shouldRenderResultMd (b) {
      const t = String(b.content || b.preview || '')
      if (!t) return false
      if (b.ok === false) return true
      if (/^#{1,3}\s|^\*\*|```|^\s*[-*]\s|\n\|\s/.test(t)) return true
      if (/^(【|L\d+\s\[|Worker|Swarm|诊断)/m.test(t)) return true
      if (t.length > 80 && /\n/.test(t)) return true
      return false
    },
    formatResultMd (b) {
      let t = String(b.content || b.preview || '')
      if (!this.resultOpen[b._key] && t.length > 1200) {
        t = t.slice(0, 1200) + '\n\n…'
      }
      t = t.replace(/^(L\d+\s\[(?:error|warning|info)\].+)$/gm, '- `$1`')
      if (/^[-+]{3}\s|^@@ |^diff --git/m.test(t) && !/```/.test(t)) {
        return '```diff\n' + t + '\n```'
      }
      if (/^\s*[\[{]/.test(t) && !/```/.test(t)) {
        try {
          const pretty = JSON.stringify(JSON.parse(t), null, 2)
          return '```json\n' + pretty + '\n```'
        } catch (e) { /* keep */ }
      }
      return t
    },
    toggleGroup (key) {
      this.$set(this.groupOpen, key, !this.groupOpen[key])
    },
    toggleResult (key) {
      this.$set(this.resultOpen, key, !this.resultOpen[key])
    },
    toggleThink (key) {
      this.$set(this.thinkOpen, key, this.thinkOpen[key] !== true)
    },
    pickClarify (opt) {
      const text = typeof opt === 'string' ? opt : (opt.value || opt.label || '')
      this.clarification = ''
      this.clarifyOptions = []
      this.input = text
      this.send()
    },
    onPaste (e) {
      const items = (e.clipboardData && e.clipboardData.items) || []
      let handled = false
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (!it.type || !it.type.startsWith('image/')) continue
        handled = true
        const file = it.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          this.pendingImages.push({
            dataUrl: reader.result,
            mime: file.type || 'image/png',
            name: file.name || ('paste_' + Date.now())
          })
        }
        reader.readAsDataURL(file)
      }
      if (handled) {
        e.preventDefault()
        const visionOk = this.multimodalEnabled && (
          this.visionModels.indexOf(this.model) >= 0 ||
          (this.visionModels[0] && this.model === this.visionModels[0])
        )
        if (!this.multimodalEnabled) {
          this.pushBlock({
            type: 'system',
            content: '已粘贴截图，但 vision off（未配置 DEEPSEEK_VISION_MODEL）。Agent 只能看到路径，看不见像素。'
          })
        } else if (!visionOk && this.visionModels.length) {
          this.pushBlock({
            type: 'system',
            content: '已粘贴截图。当前模型是文本线；请切到视觉模型：' + this.visionModels.join(' / ')
          })
        }
      }
    },
    onImeStart () {
      this.imeComposing = true
    },
    onImeEnd () {
      this.imeComposing = false
      // 只吃掉组词确认那一下 Enter，不影响随后真正发送
      this.imeSwallowEnter = true
      const clear = () => { this.imeSwallowEnter = false }
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          setTimeout(clear, 0)
        })
      })
    },
    isImeBlockingSend (e) {
      if (this.imeComposing) return true
      if (e && (e.isComposing || e.keyCode === 229)) return true
      if (this.imeSwallowEnter) {
        this.imeSwallowEnter = false
        return true
      }
      return false
    },
    onPromptKeydown (e) {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        this.cyclePermissionMode()
        return
      }
      if (this.permission && /^[1-5]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        this.handlePermDigit(Number(e.key))
        return
      }
      if (this.slashOpen && this.slashFiltered.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          this.slashIndex = (this.slashIndex + 1) % this.slashFiltered.length
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          this.slashIndex = (this.slashIndex - 1 + this.slashFiltered.length) % this.slashFiltered.length
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          this.applySlash(this.slashFiltered[this.slashIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          this.slashOpen = false
          return
        }
      }
      if (e.key === 'Escape' && this.sending) {
        e.preventDefault()
        this.stopRun()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        this.toggleAllThinking()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        if (this.isImeBlockingSend(e)) return
        if (this.vimMode && !this.vimInsert) {
          e.preventDefault()
          return
        }
        e.preventDefault()
        this.send()
        return
      }
      if (!this.vimMode) return
      if (e.key === 'Escape') {
        this.vimInsert = false
        if (this._vim) this._vim.resetPending()
        e.preventDefault()
        return
      }
      if (this.vimInsert) return
      if (!this._vim) {
        const self = this
        this._vim = createVimController({
          getText: () => self.input || '',
          setText: (t) => { self.input = t },
          getOffset: () => {
            const el = self.$refs.prompt
            return el ? el.selectionStart : 0
          },
          setOffset: (off) => {
            self.$nextTick(() => {
              const el = self.$refs.prompt
              if (el) {
                const p = Math.max(0, Math.min(off, (self.input || '').length))
                el.focus()
                el.setSelectionRange(p, p)
              }
            })
          },
          enterInsert: (off) => {
            self.vimInsert = true
            self.$nextTick(() => {
              const el = self.$refs.prompt
              if (el) {
                const p = Math.max(0, Math.min(off, (self.input || '').length))
                el.focus()
                el.setSelectionRange(p, p)
              }
            })
          },
          getRegister: () => self._vimReg || { content: '', linewise: false },
          setRegister: (c, lw) => { self._vimReg = { content: c, linewise: !!lw } }
        })
      }
      const key = e.key
      if (key === 'Shift' || key === 'Control' || key === 'Meta' || key === 'Alt') return
      const handled = this._vim.handleKey(key, e)
      if (handled) e.preventDefault()
      else if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault()
    },
    async stopRun () {
      if (this.aborting) return
      this.aborting = true
      this.workStatus = 'Stopping…'
      this.pushBlock({ type: 'system', content: '⏹ Stopping…' })
      const sid = this.sessionId
      try {
        if (sid) {
          await fetch('/api/panda/abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid })
          })
        }
      } catch (e) { /* ignore */ }
      if (this.executeAbort) {
        try { this.executeAbort.abort() } catch (e) { /* ignore */ }
      }
      // aborting 保持到 sending 结束（finally 清）
    },
    bridgeUrl (sessionId) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${location.host}/panda-bridge?session=${encodeURIComponent(sessionId || 'default')}`
    },
    closeBridge () {
      if (this.bridgeWs) {
        try { this.bridgeWs.close() } catch (e) { /* ignore */ }
        this.bridgeWs = null
      }
      this.bridgeStatus = 'off'
    },
    connectBridge (sessionId) {
      this.closeBridge()
      if (!sessionId || typeof WebSocket === 'undefined') return
      this.bridgeStatus = 'connecting'
      try {
        const ws = new WebSocket(this.bridgeUrl(sessionId))
        this.bridgeWs = ws
        ws.onopen = () => {
          this.bridgeStatus = 'on'
          ws.send(JSON.stringify({ type: 'ping' }))
        }
        ws.onclose = () => {
          if (this.bridgeWs === ws) {
            this.bridgeStatus = 'off'
            this.bridgeWs = null
          }
        }
        ws.onerror = () => {
          this.bridgeStatus = 'off'
        }
        ws.onmessage = (ev) => {
          let msg
          try { msg = JSON.parse(ev.data) } catch (e) { return }
          if (!msg || !msg.event) return
          if (msg.clients != null) this.bridgeClients = msg.clients
          if (msg.event === 'bridge_inject' && msg.content) {
            this.input = msg.content
            this.send()
          } else if (msg.event === 'bridge_kick') {
            this.pushBlock({
              type: 'system',
              content: 'Bridge kick' + (msg.reason ? ' · ' + msg.reason : '')
            })
          } else if (msg.event === 'permission_resolved' || msg.event === 'bridge_permission_resolved') {
            this.pushBlock({
              type: 'system',
              content: 'Bridge permission ' + (msg.allow ? 'allowed' : 'denied') +
                (msg.tool ? ' · ' + msg.tool : '')
            })
          }
        }
      } catch (e) {
        this.bridgeStatus = 'off'
      }
    },
    async loadViewFiles () {
      try {
        const res = await fetch('/api/dev/files')
        const data = await res.json()
        const files = (data.files || data || [])
          .map(f => (typeof f === 'string' ? f : f.path || f.file))
          .filter(p => typeof p === 'string' && (p.endsWith('.vue') || p.endsWith('.js')))
          .filter(p => p.startsWith('src/'))
          .slice(0, 80)
        if (files.length) this.viewFiles = files
      } catch (e) { /* ignore */ }
    },
    async refreshSessions () {
      const res = await fetch('/api/panda/sessions')
      const data = await res.json()
      this.sessions = data.sessions || []
    },
    async createSession () {
      const res = await fetch('/api/panda/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新会话' })
      })
      const data = await res.json()
      await this.refreshSessions()
      if (data.session && data.session.id) {
        await this.openSession(data.session.id)
      }
    },
    async openSession (id) {
      this.sessionId = id
      this.blocks = []
      this.groupOpen = {}
      this.resultOpen = {}
      this.thinkOpen = {}
      this.clarification = ''
      this.todos = []
      this.mcpOAuth = null
      this.compactHint = ''
      this.worktreeInfo = { active: false, path: '', branch: '' }
      this.permission = null
      this.teamPermission = null
      const res = await fetch('/api/panda/sessions/' + encodeURIComponent(id))
      const data = await res.json()
      const ctx = data.context || {}
      if (Array.isArray(ctx.todos)) this.todos = ctx.todos
      if (ctx.permissionMode && PERMISSION_MODES.indexOf(ctx.permissionMode) >= 0) {
        this.permissionMode = ctx.permissionMode
        try { localStorage.setItem('panda_permission_mode', ctx.permissionMode) } catch (e) { /* ignore */ }
      }
      if (data.worktree && data.worktree.active) {
        this.worktreeInfo = {
          active: true,
          path: data.worktree.path || '',
          branch: data.worktree.branch || ''
        }
      }
      const entries = data.entries || []
      entries.forEach((e, i) => {
        if (e.type === 'user') {
          this.blocks.push({ type: 'user', content: e.content, _key: 'h' + i })
        } else if (e.type === 'assistant') {
          this.blocks.push({ type: 'assistant_text', content: e.content, _key: 'h' + i })
        } else if (e.type === 'thinking') {
          this.blocks.push({ type: 'thinking', content: e.content, _key: 'hk' + i })
          this.$set(this.thinkOpen, 'hk' + i, false)
        } else if (e.type === 'tool') {
          const tid = e.id || ('ht' + i)
          this.blocks.push({
            type: 'tool_use',
            id: tid,
            name: e.name,
            facing: e.facing || e.name,
            detail: e.detail || '',
            status: e.ok === false ? 'error' : 'done',
            _key: 'ht' + i
          })
          if (e.preview || e.content) {
            this.blocks.push({
              type: 'tool_result',
              id: tid,
              name: e.name,
              facing: e.facing || e.name,
              ok: e.ok !== false,
              preview: e.preview,
              content: e.content || e.preview,
              _key: 'hr' + i
            })
          }
        } else if (e.type === 'system') {
          this.blocks.push({ type: 'system', content: e.content, _key: 'hs' + i })
        }
      })
      this.$nextTick(() => this.scrollBottom())
      await this.tryAttachLiveRun(id, { silent: false })
    },
    async removeSession (id) {
      await fetch('/api/panda/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
      await this.refreshSessions()
      if (this.sessionId === id) {
        if (this.sessions[0]) await this.openSession(this.sessions[0].id)
        else {
          this.sessionId = ''
          this.blocks = []
          await this.createSession()
        }
      }
    },
    async resolveTeamPerm (allow) {
      if (!this.teamPermission) return
      const row = this.teamPermission
      this.teamPermission = null
      try {
        await fetch('/api/panda/team/permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: row.id,
            teamId: row.teamId || 'default',
            allow: !!allow,
            reason: allow ? 'workbench allow' : 'workbench deny'
          })
        })
      } catch (e) { /* ignore */ }
      this.pushBlock({
        type: 'system',
        content: (allow ? '✓ Team allow · ' : '✗ Team deny · ') + row.id
      })
    },
    async resolvePerm (allow, extras) {
      if (!this.permission) return
      const id = this.permission.id
      this.permission = null
      try {
        await fetch('/api/panda/permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            id,
            allow,
            sessionId: this.sessionId
          }, extras || {}))
        })
      } catch (e) { /* ignore */ }
    },
    async resolvePermDontAskAgain () {
      const sug = this.permAllowSuggestion
      if (!sug) {
        await this.resolvePerm(true)
        return
      }
      const label = sug.label || sug.entry
      await this.resolvePerm(true, {
        persistAllow: true,
        allowRule: {
          toolName: sug.toolName,
          ruleContent: sug.ruleContent,
          prefix: !!sug.prefix
        }
      })
      this.pushBlock({ type: 'system', content: "Don't ask again · 已写入 allow " + label })
    },
    async resolvePermAllowAll () {
      const risk = this.permission && this.permission.risk
      const isBash = risk === 'bash' ||
        (this.permission && (this.permission.tool === 'bash' || this.permission.tool === 'bash_bg' || this.permission.tool === 'powershell'))
      if (isBash) {
        // 对齐 Ink：只 session-allow shell，不把模式切成 acceptEdits
        const tool = (this.permission && this.permission.tool) || 'bash'
        this.sessionAllowRules = (this.sessionAllowRules || []).concat([{ toolName: tool === 'powershell' ? 'powershell' : 'bash', ruleContent: null }])
        await this.syncRuntimeMode({})
        await this.resolvePerm(true, { sessionAllow: true })
        this.pushBlock({ type: 'system', content: 'Session allow · shell only（模式未变：' + this.permissionMode + '）' })
        return
      }
      const next = 'acceptEdits'
      this.permissionMode = next
      try { localStorage.setItem('panda_permission_mode', next) } catch (e) { /* ignore */ }
      ;['edit_file', 'write_file', 'apply_patch', 'edit_lines'].forEach(t => {
        this.sessionAllowRules = (this.sessionAllowRules || []).concat([{ toolName: t, ruleContent: null }])
      })
      await this.syncRuntimeMode({ permissionMode: next })
      await this.resolvePerm(true, {
        permissionMode: next,
        sessionAllow: true
      })
      this.pushBlock({ type: 'system', content: 'Session allow · edits for this run' })
    },
    async resolvePermDenySession () {
      const tool = this.permission && this.permission.tool
      const detail = this.permission && this.permission.detail
      if (tool) {
        this.sessionDenyRules = (this.sessionDenyRules || []).concat([{
          toolName: tool,
          ruleContent: detail || null,
          prefix: !detail
        }])
      }
      await this.resolvePerm(false, { sessionDeny: true })
      this.pushBlock({ type: 'system', content: 'Session deny · 本会话拒绝此类操作' })
    },
    async resolvePermDenyPersist () {
      await this.resolvePerm(false, { sessionDeny: true, persistDeny: true, projectRoot: undefined })
      this.pushBlock({ type: 'system', content: 'Remember deny · 已写入 .panda/permissions.json' })
    },
    flushQueue () {
      if (this.sending || !this.queuedMessages.length) return
      const next = this.queuedMessages.shift()
      if (!next) return
      this.input = next.text || ''
      this.pendingImages = (next.images || []).slice()
      this.$nextTick(() => this.send())
    },
    quick (text) {
      this.input = text
      this.send()
    },
    onScroll () {
      const el = this.$refs.scroll
      if (!el) return
      this.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    },
    scrollBottom () {
      const el = this.$refs.scroll
      if (!el) return
      el.scrollTop = el.scrollHeight
    },
    historyForApi () {
      return this.blocks
        .filter(b => b.type === 'user' || b.type === 'assistant_text')
        .slice(-20)
        .map(b => ({
          role: b.type === 'user' ? 'user' : 'assistant',
          content: b.content || ''
        }))
    },
    async onPandaEvent (payload) {
      const ev = payload && payload.event
      if (!ev) return
      if (payload._seq != null) this._runSeq = payload._seq
      if (ev === 'started' || ev === 'step' || ev === 'panda_status') {
        this.workStatus = payload.message || this.workStatus || '…'
        if (payload.phase === 'compact' || payload.phase === 'reactive_compact' || payload.phase === 'reactive_compact_done') {
          this.compactHint = payload.phase === 'reactive_compact_done' ? 'compacted' : 'compacting…'
          if (payload.phase === 'reactive_compact_done') {
            setTimeout(() => { if (this.compactHint === 'compacted') this.compactHint = '' }, 4000)
          }
        }
      } else if (ev === 'panda_run') {
        if (payload.reattached) {
          this.workStatus = payload.workStatus || this.workStatus || '已重连…'
        }
      } else if (ev === 'panda_round') {
        this.workStatus = '调用模型…'
      } else if (ev === 'analyze') {
        this.workStatus = payload.summary || payload.detail || '已扫描工程'
      } else if (ev === 'panda_block') {
        this.pushBlock(payload)
        if (payload.type === 'tool_use') {
          this.workStatus = '执行 ' + (payload.facing || payload.name || 'tool') +
            (payload.detail ? ' · ' + payload.detail : '')
        } else if (payload.type === 'tool_result') {
          this.workStatus = (payload.ok ? '工具完成' : '工具失败') + ' · ' + (payload.facing || payload.name || '')
        } else if (payload.type === 'assistant_text' && payload.streaming) {
          this.workStatus = '模型输出中…'
        } else if (payload.type === 'thinking' && payload.streaming) {
          this.workStatus = '思考中…'
        }
      } else if (ev === 'panda_stream') {
        this.appendStream(payload.id, payload.kind, payload.chunk)
        if (payload.kind === 'thinking') this.workStatus = '思考中…'
        else if (payload.kind === 'text') this.workStatus = '模型输出中…'
      } else if (ev === 'panda_stream_end') {
        this.endStream(payload.id, payload.kind, payload.content)
      } else if (ev === 'panda_usage') {
        this.usage = {
          total_tokens: payload.total_tokens || 0,
          est_cost_usd: payload.est_cost_usd || 0,
          prompt_tokens: payload.prompt_tokens,
          completion_tokens: payload.completion_tokens,
          rounds: payload.rounds,
          model: payload.model
        }
      } else if (ev === 'panda_set_model') {
        if (payload.model) this.model = payload.model
      } else if (ev === 'panda_set_vim') {
        this.vimMode = !!payload.enabled
        this.vimInsert = true
      } else if (ev === 'panda_resume') {
        if (payload.sessionId) this.openSession(payload.sessionId)
      } else if (ev === 'panda_rename') {
        this.refreshSessions()
      } else if (ev === 'panda_context') {
        this.contextPct = payload.pct != null ? payload.pct : this.contextPct
        this.contextTokens = payload.tokens || this.contextTokens
        this.contextLimit = payload.limit || this.contextLimit
        if (payload.permissionMode) this.permissionMode = payload.permissionMode
      } else if (ev === 'panda_mode') {
        if (payload.permissionMode) {
          this.permissionMode = payload.permissionMode
          try { localStorage.setItem('panda_permission_mode', payload.permissionMode) } catch (e) { /* ignore */ }
        }
        if (payload.mode) this.agentMode = payload.mode
        if (payload.plan) this.lastPlanText = String(payload.plan).slice(0, 12000)
        if (payload.planApproved) {
          this.pushBlock({ type: 'system', content: '✓ Plan approved · implementation unlocked' })
        }
      } else if (ev === 'panda_todos') {
        this.todos = Array.isArray(payload.todos) ? payload.todos : []
      } else if (ev === 'panda_worktree') {
        this.worktreeInfo = {
          active: !!payload.active,
          path: payload.path || '',
          branch: payload.branch || ''
        }
      } else if (ev === 'panda_mcp_oauth') {
        this.mcpOAuth = { pending: payload.pending || {} }
        this.mcpOAuthTokens = {}
        this.workStatus = '等待 MCP OAuth…'
      } else if (ev === 'panda_team_permission') {
        if (payload.pending === false) {
          if (this.teamPermission && this.teamPermission.id === payload.id) this.teamPermission = null
        } else {
          this.teamPermission = {
            id: payload.id,
            teamId: payload.teamId || 'default',
            tool: payload.tool || '',
            detail: payload.detail || '',
            risk: payload.risk || 'write',
            fromMember: payload.fromMember || ''
          }
          this.workStatus = 'Team 权限：' + (payload.fromMember || '') + ' · ' + (payload.tool || '')
        }
      } else if (ev === 'panda_permission_resolved') {
        if (this.permission && this.permission.id === payload.id) this.permission = null
      } else if (ev === 'panda_permission') {
        const mustAsk = !!payload.forceAsk || payload.tool === 'exit_plan_mode'
        if (!mustAsk && this.permissionMode !== 'auto' &&
            (this.permissionMode === 'bypassPermissions' ||
            (this.permissionMode === 'acceptEdits' && payload.risk !== 'bash'))) {
          try {
            await fetch('/api/panda/permission', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: payload.id, allow: true })
            })
          } catch (e) { /* ignore */ }
        } else {
          this.permDiffExpanded = false
          this.permission = {
            id: payload.id,
            tool: payload.tool,
            detail: payload.detail,
            risk: payload.risk,
            diff: payload.diff || '',
            preview: payload.preview || '',
            reason: payload.reason || '',
            suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : []
          }
          this.workStatus = payload.reason
            ? ('权限确认：' + String(payload.reason).slice(0, 80))
            : '等待权限确认…'
        }
      } else if (ev === 'panda_clear') {
        this.blocks = []
      } else if (ev === 'clarification') {
        this.clarification = payload.question || ''
        this.clarifyOptions = payload.options || []
        this.workStatus = '等待确认…'
      } else if (ev === 'error') {
        this.pushBlock({ type: 'assistant_text', content: '**错误**\n\n' + (payload.message || '错误') })
        this.workStatus = '出错'
      } else if (ev === 'done') {
        if (payload.idle) return
        if (payload.sessionId) this.sessionId = payload.sessionId
        if (payload.usage) this.usage = payload.usage
        if (Array.isArray(payload.todos)) this.todos = payload.todos
        if (payload.permissionMode && PERMISSION_MODES.indexOf(payload.permissionMode) >= 0) {
          this.permissionMode = payload.permissionMode
        }
        this.workStatus = payload.aborted ? '已中断' : '完成'
        if (payload.aborted) {
          this.pushBlock({ type: 'system', content: '⏹ Turn interrupted · resume with keep going or a new message' })
        }
        await this.refreshSessions()
      }
    },
    /**
     * P0：检测服务端仍在跑的 Agent，重连 SSE + 恢复权限弹窗
     * @returns {Promise<boolean>} 是否已挂上 live run
     */
    async tryAttachLiveRun (id, opts) {
      const sid = id || this.sessionId
      const silent = !!(opts && opts.silent)
      if (!sid || this._attachingRun) return false
      this._attachingRun = true
      try {
        const res = await fetch('/api/panda/runs/' + encodeURIComponent(sid))
        const snap = await res.json()
        if (!snap || !snap.running) return false

        if (this.executeAbort) {
          try { this.executeAbort.abort() } catch (e) { /* ignore */ }
        }
        const attachAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null
        this.executeAbort = attachAbort
        this.sending = true
        this.aborting = false
        this.workStatus = snap.workStatus || '已重连运行中…'
        this.startSpinner()
        if (snap.pendingPermission && snap.pendingPermission.id) {
          this.permission = {
            id: snap.pendingPermission.id,
            tool: snap.pendingPermission.tool,
            detail: snap.pendingPermission.detail,
            risk: snap.pendingPermission.risk,
            diff: snap.pendingPermission.diff || '',
            preview: snap.pendingPermission.preview || '',
            reason: snap.pendingPermission.reason || '',
            suggestions: Array.isArray(snap.pendingPermission.suggestions) ? snap.pendingPermission.suggestions : []
          }
        }
        if (snap.teamPermission) this.teamPermission = snap.teamPermission
        if (Array.isArray(snap.todos)) this.todos = snap.todos
        if (snap.permissionMode && PERMISSION_MODES.indexOf(snap.permissionMode) >= 0) {
          this.permissionMode = snap.permissionMode
        }
        if (!silent) {
          this.pushBlock({
            type: 'system',
            content: '⇄ 已重连运行中的 Agent' + (snap.round ? ' · round ' + snap.round : '')
          })
        }

        const evRes = await fetch(
          '/api/panda/runs/' + encodeURIComponent(sid) + '/events?replay=ring&fromSeq=' + (this._runSeq || 0),
          { signal: attachAbort ? attachAbort.signal : undefined }
        )
        if (!evRes.ok || !evRes.body) {
          this.sending = false
          this.stopSpinner()
          return false
        }
        const reader = evRes.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        while (true) {
          if (attachAbort && attachAbort.signal.aborted) break
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\n/)
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            try {
              const payload = JSON.parse(trimmed.slice(6))
              await this.onPandaEvent(payload)
              if (payload.event === 'done' && !payload.idle) break
            } catch (e) { /* ignore */ }
          }
        }
        return true
      } catch (e) {
        if (e && e.name === 'AbortError') return true
        return false
      } finally {
        this._attachingRun = false
        if (!this.aborting) {
          // 若仍在跑会由循环撑住 sending；结束后清
          try {
            const check = await fetch('/api/panda/runs/' + encodeURIComponent(sid))
            const s2 = await check.json()
            if (!s2 || !s2.running) {
              this.sending = false
              this.executeAbort = null
              this.workStatus = ''
              this.stopSpinner()
            }
          } catch (e2) {
            this.sending = false
            this.executeAbort = null
            this.stopSpinner()
          }
        }
      }
    },
    pushBlock (b) {
      b._key = b._key || b.id || ('b' + Date.now() + '_' + Math.random().toString(16).slice(2, 6))
      if (b.type === 'tool_status') {
        const t = this.blocks.find(x => x.type === 'tool_use' && x.id === b.id)
        if (t) this.$set(t, 'status', b.status)
        return
      }
      if (b.type === 'user') {
        const last = this.blocks[this.blocks.length - 1]
        if (last && last.type === 'user' && last.content === b.content) return
      }
      if (b.id && (b.type === 'assistant_text' || b.type === 'thinking')) {
        const exist = this.blocks.find(x => x.id === b.id && x.type === b.type)
        if (exist) {
          this.$set(exist, 'content', b.content || exist.content)
          this.$set(exist, 'streaming', !!b.streaming)
          if (this.stickBottom) this.$nextTick(() => this.scrollBottom())
          return
        }
      }
      this.blocks.push(b)
      if (this.stickBottom) this.$nextTick(() => this.scrollBottom())
    },
    appendStream (id, kind, chunk) {
      const type = kind === 'thinking' ? 'thinking' : 'assistant_text'
      let block = this.blocks.find(x => x.id === id && x.type === type)
      if (!block) {
        block = { type, id, content: '', streaming: true, _key: id }
        this.blocks.push(block)
      }
      this.$set(block, 'content', (block.content || '') + (chunk || ''))
      this.$set(block, 'streaming', true)
      if (this.stickBottom) this.$nextTick(() => this.scrollBottom())
    },
    endStream (id, kind, content) {
      const type = kind === 'thinking' ? 'thinking' : 'assistant_text'
      const block = this.blocks.find(x => x.id === id && x.type === type)
      if (block) {
        if (content != null && content !== '') this.$set(block, 'content', content)
        this.$set(block, 'streaming', false)
      }
    },
    async send () {
      const text = (this.input || '').trim()
      if (!text) return
      if (this.sending) {
        // 本页已有 SSE：优先 steer 进活 run，否则本地排队
        const textQ = text
        const imgs = this.pendingImages.slice()
        this.input = ''
        this.pendingImages = []
        try {
          const r = await fetch('/api/panda/steer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, text: textQ, images: imgs })
          })
          if (r.ok) {
            this.pushBlock({
              type: 'system',
              content: '已插话 #' + ((await r.json()).queued || '?') + '：' + textQ.slice(0, 80)
            })
            return
          }
        } catch (e) { /* fall through queue */ }
        this.queuedMessages.push({ text: textQ, images: imgs })
        this.pushBlock({
          type: 'system',
          content: '已排队 #' + this.queuedMessages.length + '：' + textQ.slice(0, 80)
        })
        return
      }
      if (!this.sessionId) await this.createSession()
      // 服务端仍有活 run：先重连，本条入队（避免双开 Agent）
      try {
        const live = await fetch('/api/panda/runs/' + encodeURIComponent(this.sessionId))
        const snap = await live.json()
        if (snap && snap.running) {
          const imgs = this.pendingImages.slice()
          this.input = ''
          this.pendingImages = []
          this.pushBlock({
            type: 'system',
            content: 'Agent 仍在运行 · 已插话（下一轮注入）：' + text.slice(0, 80)
          })
          try {
            const r = await fetch('/api/panda/steer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: this.sessionId,
                text,
                images: imgs
              })
            })
            if (!r.ok) {
              this.queuedMessages.push({ text, images: imgs })
            }
          } catch (e) {
            this.queuedMessages.push({ text, images: imgs })
          }
          await this.tryAttachLiveRun(this.sessionId, { silent: true })
          return
        }
      } catch (e) { /* fall through to new execute */ }
      this.input = ''
      this.slashOpen = false
      this.clarification = ''
      this.sending = true
      this.workStatus = '连接中…'
      this.pushBlock({ type: 'user', content: text })

      const executeAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null
      this.executeAbort = executeAbort
      this.startSpinner()

      try {
        setCaptureSessionId(this.sessionId || '')
        await flushToServer(this.sessionId).catch(() => {})
        const browserConsole = getRecentErrors(40, { level: 'error' })
        const res = await fetch('/api/engine/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            stream: true,
            context: {
              agentMode: 'panda',
              model: this.model,
              activeFile: this.activeFile || '',
              preferredFile: this.activeFile || '',
              sessionId: this.sessionId,
              history: this.historyForApi().slice(0, -1),
              permissionMode: this.permissionMode,
              autoApprove: this.permissionMode === 'bypassPermissions'
                ? 'all'
                : this.permissionMode === 'auto'
                  ? false
                  : this.permissionMode === 'acceptEdits',
              sessionAllowRules: this.sessionAllowRules,
              sessionDenyRules: this.sessionDenyRules,
              vimMode: this.vimMode,
              browserConsole,
              images: this.pendingImages.map(img => ({
                dataUrl: img.dataUrl,
                mime: img.mime,
                name: img.name
              }))
            }
          }),
          signal: executeAbort ? executeAbort.signal : undefined
        })
        this.pendingImages = []
        if (!res.ok || !res.body) {
          this.pushBlock({ type: 'assistant_text', content: '请求失败，请确认 `npm run server` 已启动' })
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        while (true) {
          if (executeAbort && executeAbort.signal.aborted) break
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\n/)
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            try {
              const payload = JSON.parse(trimmed.slice(6))
              await this.onPandaEvent(payload)
            } catch (e) { /* ignore */ }
          }
        }
        if (executeAbort && executeAbort.signal.aborted) {
          if (this.aborting) {
            const hasAbortMsg = this.blocks.some(b => b.type === 'system' && /已中断/.test(b.content || ''))
            if (!hasAbortMsg) this.pushBlock({ type: 'system', content: '⏹ 已中断' })
          }
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          if (this.aborting) {
            const hasAbortMsg = this.blocks.some(b => b.type === 'system' && /已中断/.test(b.content || ''))
            if (!hasAbortMsg) this.pushBlock({ type: 'system', content: '⏹ 已中断' })
          }
        } else {
          this.pushBlock({ type: 'assistant_text', content: e.message || '网络错误' })
        }
      } finally {
        const stopRequested = this.aborting
        this.sending = false
        this.aborting = false
        this.executeAbort = null
        this.workStatus = ''
        this.stopSpinner()
        this.$nextTick(() => this.scrollBottom())
        // 主 SSE 意外断开但 Agent 仍在跑 → 自动重连
        if (!stopRequested && this.sessionId) {
          await this.tryAttachLiveRun(this.sessionId, { silent: true })
        }
      }
    }
  }
}
</script>

<style scoped>
.panda-workbench {
  /* Ink darkTheme tokens */
  --claude: #D77757;
  --claude-shimmer: #EB9F7F;
  --text: #FFFFFF;
  --subtle: #505050;
  --inactive: #999999;
  --success: #4EBA65;
  --error: #FF6B80;
  --warning: #FFC107;
  --diff-added: #225C2B;
  --diff-removed: #7A2936;
  --permission: #B1B9F9;
  --prompt-border: #888888;
  --user-msg-bg: #373737;
  --message-actions-bg: #2c323e;
  --suggestion: #B1B9F9;
  --bash-border: #FD5DB1;
  --plan-mode: rgb(72, 150, 140);
  --auto-accept: rgb(175, 135, 255);
  --bg: #000000;
  --bg-elev: #0a0a0a;
  --bg-soft: #141414;
  --line: #222222;
  --muted: var(--inactive);
  --dim: var(--subtle);
  --accent: var(--claude);
  --accent-2: var(--success);
  --warn: var(--warning);
  --err: var(--error);
  --ok: var(--success);
  display: flex;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  outline: none;
}
.panda-sidebar {
  width: 252px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
}
.panda-sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 14px 10px;
}
.panda-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  color: var(--claude);
  letter-spacing: 0.02em;
}
.panda-brand-mark {
  font-size: 15px;
  line-height: 1;
  opacity: 0.95;
}
.panda-new-btn,
.panda-ghost-btn,
.panda-send-btn,
.panda-stop-btn,
.panda-expand-btn,
.panda-opt-btn {
  font-family: inherit;
  font-size: 12px;
  border-radius: 0;
  cursor: pointer;
  border: 1px solid var(--prompt-border);
  background: transparent;
  color: var(--text);
  padding: 4px 10px;
}
.panda-new-btn {
  padding: 3px 9px;
  color: var(--inactive);
  border-color: var(--line);
}
.panda-new-btn:hover,
.panda-ghost-btn:hover,
.panda-expand-btn:hover,
.panda-opt-btn:hover { border-color: var(--claude); color: var(--claude); }
.panda-ghost-btn { margin-left: 8px; }
.panda-send-btn {
  background: var(--claude);
  border-color: var(--claude);
  color: #000;
  font-weight: 600;
  padding: 6px 14px;
}
.panda-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.panda-stop-btn {
  border-color: var(--error);
  color: var(--error);
}
.panda-search { margin: 0 10px 10px; }
.panda-search >>> .el-input__inner {
  background: var(--bg-soft) !important;
  border: 1px solid var(--line) !important;
  border-radius: 0 !important;
  color: var(--text) !important;
  height: 28px;
  font-family: inherit;
  font-size: 12px;
}
.panda-search >>> .el-input__inner::placeholder { color: var(--subtle); }
.panda-search >>> .el-input__prefix { color: var(--subtle); }
.panda-session-list {
  flex: 1;
  overflow: auto;
  padding: 0 8px 20px;
}
.panda-session-item {
  position: relative;
  padding: 10px 10px 10px 12px;
  cursor: pointer;
  margin-bottom: 2px;
  border-left: 2px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.panda-session-item:hover {
  background: rgba(55, 55, 55, 0.55);
}
.panda-session-item.active {
  background: var(--user-msg-bg);
  border-left-color: var(--claude);
}
.panda-session-item.busy {
  border-left-color: var(--claude-shimmer);
}
.panda-session-item.pending {
  border-left-color: var(--permission);
}
.panda-session-dot {
  color: var(--claude);
  margin-right: 4px;
  animation: panda-pulse 1.1s ease-in-out infinite;
}
.panda-session-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.panda-session-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}
.panda-session-item:not(.active) .panda-session-title {
  color: #d0d0d0;
}
.panda-session-del {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--subtle);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  font-family: inherit;
}
.panda-session-item:hover .panda-session-del { opacity: 1; }
.panda-session-del:hover { color: var(--error); }
.panda-session-meta {
  font-size: 10.5px;
  color: var(--subtle);
  margin-top: 4px;
  letter-spacing: 0.02em;
}
.panda-session-preview {
  font-size: 11px;
  color: var(--inactive);
  margin-top: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.85;
}
.panda-session-empty {
  color: var(--subtle);
  font-size: 12px;
  padding: 28px 10px;
  text-align: left;
}
.panda-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.panda-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  min-height: 40px;
}
.panda-topbar-left,
.panda-topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.panda-top-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  max-width: 28ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panda-top-sub { font-size: 11px; color: var(--subtle); }
.panda-bridge-pill,
.panda-vim-pill,
.panda-usage {
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  color: var(--inactive);
}
.panda-bridge-pill.on {
  color: var(--success);
  border-color: var(--success);
}
.panda-bridge-pill.connecting { color: var(--warning); }
.panda-vim-pill.on {
  color: var(--warning);
  border-color: var(--warning);
}
.panda-mode-pill,
.panda-mode-cycle {
  font-size: 11px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  color: var(--inactive);
  background: transparent;
  font-family: inherit;
  cursor: pointer;
}
.panda-mode-pill.mode-acceptEdits,
.panda-mode-cycle.mode-acceptEdits {
  color: var(--auto-accept);
  border-color: rgba(175, 135, 255, 0.5);
}
.panda-mode-pill.mode-bypassPermissions,
.panda-mode-cycle.mode-bypassPermissions {
  color: var(--error);
  border-color: rgba(255, 107, 128, 0.5);
}
.panda-mode-pill.mode-dontAsk,
.panda-mode-cycle.mode-dontAsk {
  color: var(--error);
  border-color: rgba(255, 107, 128, 0.35);
}
.panda-mode-pill.mode-auto,
.panda-mode-cycle.mode-auto {
  color: var(--warning);
  border-color: rgba(230, 180, 80, 0.55);
}
.panda-mode-pill.mode-plan,
.panda-mode-cycle.mode-plan {
  color: var(--plan-mode);
  border-color: rgba(72, 150, 140, 0.55);
}
.panda-mode-pill.mode-default,
.panda-mode-cycle.mode-default {
  color: var(--inactive);
}
.panda-mode-cycle:hover { border-color: var(--claude); color: var(--claude); }
.panda-verbose { color: var(--inactive); }
.panda-messages {
  flex: 1;
  overflow: auto;
  padding: 14px 18px 36px;
  background: var(--bg);
  line-height: 1.45;
}
.panda-hero {
  max-width: 560px;
  margin: 56px auto 32px;
  text-align: left;
}
.panda-hero-mark { font-size: 28px; color: var(--claude); }
.panda-hero-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--claude);
  margin-top: 4px;
}
.panda-hero-desc {
  margin-top: 8px;
  color: var(--inactive);
  font-size: 13px;
}
.panda-hero-hints {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panda-hero-hints button {
  background: transparent;
  border: 1px dashed var(--subtle);
  color: var(--text);
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
}
.panda-hero-hints button:hover {
  border-color: var(--claude);
  color: var(--claude);
}
.panda-hero-tip {
  margin-top: 14px;
  font-size: 11px;
  color: var(--subtle);
}

/* —— Ink MessageRow turn gaps —— */
.panda-row {
  max-width: 92ch;
  margin: 0;
}
.panda-row.turn { margin-top: 1.15em; }
.panda-row.type-user.turn { margin-top: 0; } /* user 自带背景间距，避免双倍 */
.panda-row.type-tool_result,
.panda-row.type-tool_use + .panda-row.type-tool_use { margin-top: 0; }

.panda-gutter {
  flex-shrink: 0;
  width: 2ch;
  display: inline-block;
  text-align: left;
  line-height: 1.45;
  white-space: pre;
}

/* UserPromptMessage */
.panda-user {
  display: flex;
  gap: 0;
  padding: 0.35em 1ch 0.35em 0;
  background: var(--user-msg-bg);
  margin-top: 1.15em;
}
.panda-prefix {
  color: var(--subtle);
  font-weight: 400;
  padding-left: 0.5ch;
}
.panda-user-text {
  white-space: pre-wrap;
  line-height: 1.45;
  color: var(--text);
  flex: 1;
  min-width: 0;
  padding: 0;
}

/* AssistantTextMessage — ⏺ + body */
.panda-assistant {
  display: flex;
  gap: 0;
  align-items: flex-start;
}
.panda-assistant .panda-dot { color: var(--text); }

.panda-dot {
  color: var(--inactive);
  line-height: 1.45;
}
.panda-dot.running {
  color: var(--inactive);
  /* Ink blink：空白帧靠 blinkDot；保留轻脉冲作辅 */
  animation: none;
}
.panda-dot.done { color: var(--success); }
.panda-dot.error { color: var(--error); }

.panda-md-body {
  flex: 1;
  min-width: 0;
  line-height: 1.45;
  font-size: 13px;
  color: var(--text);
}
.panda-md-body >>> .chat-md,
.panda-result-md >>> .chat-md,
.panda-think-body >>> .chat-md { color: var(--text); }
.panda-md-body >>> .chat-md p,
.panda-result-md >>> .chat-md p { margin: 0.25em 0; color: var(--text); }
.panda-md-body >>> .chat-md h1,
.panda-md-body >>> .chat-md h2,
.panda-md-body >>> .chat-md h3 {
  color: var(--text);
  border-bottom: none;
  font-size: 1em;
  font-weight: 700;
  margin: 0.4em 0;
}
.panda-md-body >>> .chat-md code,
.panda-result-md >>> .chat-md code {
  background: transparent;
  color: var(--permission);
  padding: 0;
}
.panda-md-body >>> .chat-md a { color: var(--claude); }
.panda-md-body >>> .chat-code-wrap,
.panda-result-md >>> .chat-code-wrap {
  border: none;
  max-height: 420px;
  background: transparent;
  border-radius: 0;
  margin: 0.35em 0;
}
.panda-md-body >>> .chat-code-wrap pre,
.panda-result-md >>> .chat-code-wrap pre {
  background: transparent !important;
  margin: 0;
  padding: 0;
}

/* Tool use */
.panda-tool {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0 0;
  font-size: 13px;
  padding: 0;
  margin: 0;
}
.panda-tool-group { cursor: pointer; user-select: none; width: 100%; }
.panda-tool-group.bash {
  border-left: 2px solid var(--bash-border);
  padding-left: 6px;
}
.panda-tool-summary {
  color: var(--text);
  font-weight: 400;
}
.panda-tool-summary.dim { color: var(--inactive); }
.panda-tool-name { font-weight: 700; color: var(--text); }
.panda-tool-detail { color: var(--inactive); font-weight: 400; }
.panda-tool-await {
  color: var(--permission);
  font-size: 12px;
  font-style: italic;
}
.panda-tool-await-line {
  width: 100%;
  flex-basis: 100%;
  display: flex;
  align-items: baseline;
  margin-top: 0;
  color: var(--inactive);
  font-size: 12px;
}
.panda-group-items,
.panda-group-hint {
  width: 100%;
  margin-top: 0;
  padding-left: 0;
}
.panda-group-item {
  font-size: 12px;
  color: var(--inactive);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.panda-group-item-head,
.panda-group-hint {
  display: flex;
  align-items: baseline;
  gap: 0;
  font-size: 12px;
  color: var(--inactive);
}
.panda-group-item-result {
  display: flex;
  align-items: baseline;
  color: var(--inactive);
  font-size: 12px;
  padding-left: 0;
}
.panda-group-item-result.err { color: var(--error); }
.panda-group-item-result .panda-result-preview {
  white-space: pre-wrap;
  word-break: break-word;
}

/* MessageResponse: "  ⎿ " = 5ch */
.panda-tool-result {
  display: flex;
  gap: 0;
  color: var(--inactive);
  font-size: 12px;
  margin-top: 0;
  line-height: 1.45;
}
.panda-tool-result.err { color: var(--error); }
.panda-result-prefix {
  flex-shrink: 0;
  width: 5ch;
  text-align: left;
  color: var(--subtle);
  white-space: pre;
  line-height: 1.45;
  box-sizing: border-box;
}
.panda-result-wrap { flex: 1; min-width: 0; }
.panda-result-preview {
  cursor: pointer;
  white-space: pre-wrap;
  word-break: break-word;
}
.panda-result-preview:hover { color: var(--text); }
.panda-result-md.collapsed {
  max-height: 12em;
  overflow: hidden;
  position: relative;
}
.panda-result-md.collapsed::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 2em;
  background: linear-gradient(transparent, var(--bg));
  pointer-events: none;
}
.panda-result-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 20em;
  overflow: auto;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
.panda-ink-diff {
  border-top: 1px dashed var(--subtle);
  border-bottom: 1px dashed var(--subtle);
  margin: 2px 0;
  font-size: 12px;
  line-height: 1.4;
  max-height: 280px;
  overflow: auto;
}
.panda-diff-line {
  white-space: pre;
  padding: 0 1ch;
  color: var(--inactive);
}
.panda-diff-line.add { background: var(--diff-added); color: #dff5e4; }
.panda-diff-line.del { background: var(--diff-removed); color: #f8d7dd; }
.panda-diff-line.meta { color: var(--subtle); background: transparent; }

.panda-system {
  display: flex;
  gap: 1ch;
  align-items: flex-start;
  color: var(--subtle);
  font-size: 12px;
  font-style: italic;
  margin-top: 1.15em;
}
.panda-sys-mark { color: var(--claude); font-style: normal; }
.panda-system.sys-interrupt { color: var(--error); font-style: normal; }
.panda-system.sys-interrupt .panda-sys-mark { color: var(--error); }
.panda-system.sys-hook { color: var(--inactive); }
.panda-system.sys-mode { color: var(--permission); font-style: normal; }
.panda-system.sys-mode .panda-sys-mark { color: var(--permission); }
.panda-system.sys-compact { color: var(--warning); }
.panda-system.sys-bridge { color: var(--suggestion); font-style: normal; }

.panda-spinner {
  display: flex;
  align-items: baseline;
  gap: 0.5ch;
  margin-top: 1.15em;
  color: var(--claude);
  font-size: 13px;
}
.panda-spinner-glyph {
  display: inline-block;
  width: 2ch;
  text-align: left;
  color: var(--claude);
}
.panda-spinner-verb { color: var(--claude); }
.panda-spinner-meta {
  color: var(--inactive);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.shimmer {
  background: linear-gradient(90deg, var(--claude) 0%, var(--claude-shimmer) 45%, var(--claude) 90%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: panda-shimmer 1.6s linear infinite;
}

/* Thinking */
.panda-thinking { margin-top: 0.25em; max-width: 92ch; }
.panda-think-toggle {
  background: none;
  border: none;
  color: var(--inactive);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  font-family: inherit;
  font-style: italic;
  display: inline-flex;
  gap: 1ch;
  align-items: baseline;
}
.panda-think-toggle:hover { color: var(--text); }
.panda-think-hint {
  font-style: normal;
  font-size: 11px;
  color: var(--subtle);
}
.panda-thinking.streaming .panda-think-label {
  background: linear-gradient(90deg, var(--inactive) 0%, #c1c1c1 50%, var(--inactive) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: panda-shimmer 1.6s linear infinite;
}
.panda-think-body {
  margin-top: 0.5em;
  padding-left: 2ch;
  opacity: 0.75;
  font-size: 12px;
  color: var(--inactive);
}
.panda-think-body >>> .chat-md,
.panda-think-body >>> .chat-text-plain {
  color: var(--inactive) !important;
  font-style: italic;
}
.panda-think-peek {
  margin-top: 0.25em;
  padding-left: 2ch;
  color: var(--subtle);
  font-size: 11px;
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80ch;
}

.panda-prompt {
  border-top: none;
  padding: 8px 14px 12px;
  background: var(--bg);
  margin-top: 0;
}
.panda-clarify {
  font-size: 12px;
  color: var(--warning);
  margin-bottom: 8px;
}
.panda-perm {
  background: transparent;
  border: none;
  border-top: 2px solid var(--permission);
  border-radius: 0;
  padding: 10px 4px 8px;
  margin-bottom: 10px;
}
.panda-perm-sticky { animation: panda-fade-in 0.15s ease; }
.panda-perm-head { margin-bottom: 6px; }
.panda-perm-title {
  font-weight: 700;
  color: var(--permission);
  font-size: 13px;
}
.panda-perm-sub {
  font-size: 12px;
  color: var(--inactive);
  margin-top: 2px;
  word-break: break-all;
}
.panda-perm-question {
  font-size: 13px;
  color: var(--text);
  margin: 10px 0 8px;
}
.panda-perm-question strong { font-weight: 700; }
.panda-perm-preview {
  font-size: 12px;
  color: var(--inactive);
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
  border-top: 1px dashed var(--subtle);
  border-bottom: 1px dashed var(--subtle);
  padding: 6px 0;
}
.panda-perm-diff.panda-ink-diff { max-height: 280px; overflow: auto; }
.panda-perm-diff.panda-ink-diff.expanded { max-height: 55vh; }
.panda-perm.bash {
  border-left: 3px solid var(--bash-border);
  padding-left: 10px;
}
.panda-tool.bash {
  border-left: 2px solid var(--bash-border);
  padding-left: 6px;
}
.panda-bash-bang {
  color: var(--bash-border);
  margin-right: 4px;
  font-weight: 700;
}
.panda-perm-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin-top: 4px;
}
.panda-perm-btn {
  font-family: inherit;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--text);
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
}
.panda-perm-btn.yes { color: var(--success); }
.panda-perm-btn.yes-all { color: var(--permission); }
.panda-perm-btn.no { color: var(--error); }
.panda-perm-btn.no-session { color: var(--warning); }
.panda-perm-btn.no-persist { color: #ff8a9a; }
.panda-perm-btn:hover { text-decoration: underline; }
.panda-perm-reason {
  margin: 6px 0 8px;
  color: var(--inactive);
  font-size: 12px;
}
.panda-queue {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin-bottom: 8px;
  border: none;
  border-radius: 0;
  color: var(--suggestion);
  font-size: 12px;
  background: transparent;
}
.panda-queue-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--inactive);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
  padding: 0 4px 4px;
}
.panda-queue-item {
  display: flex;
  align-items: flex-start;
  gap: 0;
  color: var(--text);
  background: var(--user-msg-bg);
  padding: 0.35em 1ch 0.35em 0;
  margin-bottom: 2px;
}
.panda-queue-text {
  flex: 1;
  cursor: pointer;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.9;
}
.panda-queue-text:hover { opacity: 1; text-decoration: underline; }
.panda-plan-panel {
  margin: 0 16px 8px;
  border: 1px solid #2a3348;
  border-radius: 8px;
  background: #0c1018;
  padding: 10px 12px;
}
.panda-plan-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--permission);
  font-size: 12px;
  margin-bottom: 6px;
}
.panda-plan-body {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--inactive);
  font-size: 12px;
  line-height: 1.45;
}
.panda-perm-footer {
  margin-top: 8px;
  font-size: 11px;
  color: var(--subtle);
}
.panda-images {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.panda-image-chip {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  overflow: hidden;
}
.panda-image-chip img { width: 100%; height: 100%; object-fit: cover; }
.panda-image-chip button {
  position: absolute;
  top: 2px;
  right: 2px;
  border: none;
  background: rgba(0,0,0,.65);
  color: #fff;
  cursor: pointer;
  width: 18px;
  height: 18px;
  line-height: 18px;
  padding: 0;
}
.panda-input-shell {
  display: flex;
  gap: 0;
  align-items: flex-start;
  border: none;
  border-top: 1px solid var(--prompt-border);
  border-bottom: 1px solid var(--prompt-border);
  border-radius: 8px 8px 0 0;
  padding: 8px 2px 8px 0;
  background: var(--bg);
  margin-top: 1.15em;
}
.panda-input-shell.waiting {
  opacity: 0.55;
  pointer-events: none;
}
.panda-input-shell.mode-plan {
  border-top-color: var(--plan-mode);
  border-bottom-color: var(--plan-mode);
}
.panda-input-shell.mode-acceptEdits {
  border-top-color: var(--auto-accept);
  border-bottom-color: var(--auto-accept);
}
.panda-input-shell.mode-bypassPermissions {
  border-top-color: var(--success);
  border-bottom-color: var(--success);
}
.panda-input-shell.mode-auto {
  border-top-color: var(--warning);
  border-bottom-color: var(--warning);
}
.panda-input-shell.mode-dontAsk {
  border-top-color: var(--error);
  border-bottom-color: var(--error);
}
.panda-input-prefix {
  color: var(--subtle);
  font-weight: 400;
  flex-shrink: 0;
  width: 2ch;
  line-height: 1.45;
  padding-top: 0;
  white-space: pre;
}
.panda-textarea {
  flex: 1;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  min-height: 4.5em;
  padding: 0;
}
.panda-textarea:disabled { opacity: 0.55; }
.panda-textarea::placeholder { color: var(--subtle); }
.panda-expand-btn {
  border: none !important;
  background: transparent !important;
  color: var(--subtle) !important;
  padding: 0 !important;
  font-size: 11px !important;
  font-style: italic;
  margin-top: 2px;
}
.panda-expand-btn:hover { color: var(--inactive) !important; }
.panda-prompt-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  gap: 12px;
}
.panda-prompt-actions { display: flex; gap: 8px; }
.panda-clarify-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }

@keyframes panda-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes panda-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@keyframes panda-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.panda-workbench >>> .el-input__inner,
.panda-workbench >>> .el-input__inner:focus {
  background: var(--bg-soft);
  border-color: var(--line);
  color: var(--text);
  border-radius: 0;
}
.panda-workbench >>> .el-checkbox__label { color: var(--inactive); font-size: 11px; }
.panda-workbench >>> .el-select .el-input__inner { height: 28px; line-height: 28px; }

/* Plan / todos / slash / MCP / chips */
.panda-chip {
  font-size: 11px;
  color: var(--inactive);
  border: 1px solid var(--line);
  padding: 1px 6px;
  margin-left: 6px;
}
.panda-chip.wt { color: var(--suggestion); border-color: #3a3f55; }
.panda-chip.compact { color: var(--warning); }
.panda-chip.sandbox { color: var(--subtle); }
.panda-chip.mode { color: var(--permission); }
.panda-chip.mode.mode-plan { color: var(--plan-mode); }
.panda-chip.mode.mode-acceptEdits { color: var(--auto-accept); }
.panda-chip.mode.mode-bypassPermissions { color: var(--error); }
.panda-chip.mode.mode-auto { color: var(--warning); }
.panda-chip.mode.mode-dontAsk { color: var(--error); }
.panda-chip.context { color: var(--inactive); }
.panda-chip.context.hot { color: var(--warning); border-color: #5a4a20; }
.panda-chip.vision { color: var(--subtle); }
.panda-chip.vision.on { color: var(--success); }
.panda-plan-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: rgba(72, 150, 140, 0.12);
  border-bottom: 1px solid var(--plan-mode);
  color: var(--plan-mode);
  font-size: 12px;
}
.panda-plan-mark { font-size: 16px; }
.panda-plan-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.panda-plan-text strong { color: #9fd8d0; }
.panda-plan-text span { color: #7ab0a8; font-size: 11px; }
.panda-todo-panel {
  border-bottom: 1px solid var(--line);
  background: var(--bg-elev);
  padding: 8px 14px;
  max-height: 140px;
  overflow: auto;
  font-size: 12px;
}
.panda-todo-head {
  display: flex;
  justify-content: space-between;
  color: var(--inactive);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}
.panda-todo-item {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  color: var(--text);
}
.panda-todo-item.st-completed { color: var(--subtle); text-decoration: line-through; }
.panda-todo-item.st-in_progress .panda-todo-mark { color: var(--claude); }
.panda-todo-mark { width: 1.2em; color: var(--inactive); }
.panda-slash-menu {
  border: 1px solid var(--line);
  background: var(--bg-elev);
  max-height: 220px;
  overflow: auto;
  margin: 0 12px 6px;
}
.panda-slash-item {
  display: flex;
  gap: 12px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  padding: 6px 10px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
}
.panda-slash-item:hover,
.panda-slash-item.active {
  background: var(--message-actions-bg);
}
.panda-slash-name { color: var(--suggestion); min-width: 10em; }
.panda-slash-desc { color: var(--inactive); flex: 1; }
.panda-mcp-oauth {
  border-top: 2px solid var(--permission);
  background: #12141c;
  padding: 10px 12px;
  font-size: 12px;
}
.panda-mcp-oauth-title { color: var(--permission); margin-bottom: 8px; }
.panda-mcp-oauth-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.panda-mcp-oauth-name { color: var(--text); min-width: 6em; }
.panda-mcp-oauth-link { color: var(--suggestion); }
.panda-mcp-oauth-input {
  flex: 1;
  min-width: 160px;
  background: var(--bg);
  border: 1px solid var(--line);
  color: var(--text);
  padding: 4px 8px;
  font-family: inherit;
}
</style>
