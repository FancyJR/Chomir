# Panda Agent 能力对照（vs panda-code）

## 已接入（持续扩充）

当前工具约 **54** 个；工作台 `/panda` 对齐会话细节。

| 能力 | 状态 |
|------|------|
| **写码管线（FileEdit 级）** | ✓ `editMatch`：先读后写、mtime 新鲜度、引号/脱敏恢复、EOL、multi-edits、禁 bash/sed、改后 `<new-diagnostics>` |
| **Token 流式输出** | ✓ SSE `panda_stream` + 回退非流式 |
| **思考过程**（reasoner） | ✓ `thinking` 块可折叠 |
| **中断 / 停止** | ✓ 工作台停止 · `/stop` · `/api/panda/abort` |
| **权限 + Diff 预览** | ✓ bypass 过规则放行（无 LLM）；独立 **auto** 跑分类器；Diff 预览 |
| **用量 / cost** | ✓ 顶栏 + `/cost` `/usage` |
| WebFetch / WebSearch | ✓ |
| Plan Mode / Skills / Slash / Memory / Compact | ✓ |
| Explore / Plan / Verify 子代理 | ✓ |
| Coordinator / Swarm | ✓ |
| LSP + 内置诊断 + **lsp_query 导航** | ✓ definition/refs/hover/symbols |
| Remote Bridge | ✓ |
| MCP / Worktree / Config / Brief | ✓（远程 MCP 断线自动重连） |
| **运行中重连 runHub** | ✓ 刷新不断 Agent · 权限恢复 · fromSeq |
| **运行中插话 steer** | ✓ 下一轮注入，不重开会话 |
| File history + undo + `/diff` | ✓ |
| Hooks Pre/Post/Stop + Session/Permission/Compact/Subagent | ✓ |
| OS sandbox lite（sandbox-exec / bwrap，`osSandbox:true`） | ✓ 可选；工作台 chip 反映状态 |
| Bridge 权限中继 `permission_resolve` | ✓ |
| verify_plan / powershell / browser actions / custom agents | ✓ |
| Swarm team permission → leader UI / `team_perm_resolve` | ✓ |
| Mid-run reconnect（刷新/断线重挂 SSE + 权限弹窗） | ✓ `runHub` + `/api/panda/runs/:id/events` |
| MCP OAuth authorization_code 换 token（PKCE lite） | ✓ |
| 后台 Bash / Team / Cron / REPL | ✓ |
| 会话 UI ●/⎿ · Markdown · 折叠 Read/Grep/Bash | ✓ |
| AskUser 选项按钮 | ✓ |
| **斜杠命令扩表** | ✓ ~100 条（`/help`） |
| **Fork sidechain** | ✓ 继承对话/readFileState/权限 bubble/模型 inherit |
| **Vim 文本对象** | ✓ diw/daw/ci"/ya( / dd/yy/p · `/vim` |
| **真多模态** | ✓ 粘贴图默认 `DEEPSEEK_VISION_MODEL` content parts |

## 工作台体验（已对齐）

- Shift+Tab：`default → acceptEdits → plan → bypass → auto → dontAsk`；**运行中同步** `runtime.permissionMode`
- 权限弹窗：Yes / **don't ask again**（写 allow 前缀）/ session allow / deny / remember deny
- acceptEdits/auto shell：**按段**校验（bash `&&` `|` `;`；PowerShell `;` `|`）；只读命令 default 也可放行
- 默认权限模式工作台：**acceptEdits**（非 bypass）
- auto 分类器：注入 Panda.md/CLAUDE.md + 近期 transcript + autoMode 配置；连续拒绝 ≥3 或累计 ≥20 → 回退人工确认
- **多轮 transcript**：Ink 式折叠 Read/Grep/Bash（混合计数 + 展开见结果）；工具点闪烁；并行工具按 id 配对；reload 恢复 todos/mode/worktree；中间 assistant 叙述落盘
- 队列项用 user-msg 背景；权限等待时输入框变暗；system 行分型（interrupt/hook/mode/compact）
- 会话侧栏：运行中 ● / 待权限左边线

## 仍弱 / 刻意精简

- 完整 tree-sitter bash AST（当前为 bashSecurity 启发 + 按段拆分）
- Seatbelt/bwrap 默认关；设 `.panda/config.json` `"osSandbox": true` 或 `PANDA_OS_SANDBOX=1`
- Ink TUI / 插件市场 / 完整 WebBrowser 会话持久化
- PowerShell 完整 flag 白名单（工具已挂，权限走 bash 同源启发）

## 试用细节

```
/help
Shift+Tab 切权限 · Plan 批准后同轮可写
bypass = 过规则放行（无 LLM）；auto = 分类器
敏感路径（.git 等）即使 bypass 也 ask
粘贴截图前确认顶栏 vision on + 选视觉模型
运行中可继续输入排队；看 ctx % 防失忆
```
