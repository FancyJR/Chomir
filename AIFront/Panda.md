# Panda.md — AIFront

Project instructions for **Panda Code** / Panda agents. These OVERRIDE default behavior when they conflict. Skip anything irrelevant to the current task.

## What this repo is

Vue 2.7 + ElementUI PC demo + Express API, with a **Panda workbench** (`/panda`) that ports panda-code-style agent capabilities (tools, sessions, multimodal paste, Explore/Plan/Verify).

Reference implementation (read-only inspiration, do not treat as runtime): `panda-code/`.

## Commands

| Command | What |
|---------|------|
| `npm run serve` | Frontend (default **http://localhost:8080**) |
| `npm run server` | API / Panda agent (**http://localhost:8787**) |
| `npm run dev` | Both via concurrently |
| `npm run build` | Production frontend build |

Env: `.env.local` at repo root (e.g. `DEEPSEEK_API_KEY`). Optional: `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_MULTIMODAL_MODELS`.

Do **not** commit secrets. Prefer not killing unrelated processes; if 8787 is stuck: `lsof -ti :8787 | xargs kill` then restart server.

## Layout

```
src/
  App.vue              # sidebar menus (Chinese labels → routes)
  main.js
  router/index.js      # history mode routes + meta.title
  views/*.vue          # pages (one view ≈ one menu item)
  utils/               # e.g. consoleCapture.js
  components/
server/
  index.js             # Express entry
  engine/
    panda/              # Panda agent (agent.js, tools, prompts, session…)
    shared-llm.js      # DeepSeek chat/stream
  .panda/               # runtime: sessions, MEMORY.md(索引), memory/topics, uploads, teams, swarms
panda-code/             # upstream-style reference (not the running agent)
```

## Menu → route → view (common)

When the user names a Chinese menu, map via `App.vue` + `router/index.js`, then edit the view:

| Menu (approx.) | Route | View |
|----------------|-------|------|
| Panda 工作台 | `/panda` | `PandaWorkbench.vue` |
| 仪表盘 | `/dashboard` | `Dashboard.vue` |
| 编排 | `/orchestration` | `OrchestrationBuilder.vue` |
| 指令市场 | `/command-market` | `CommandMarket.vue` |
| 无代码 | `/no-code` | `NoCodeBuilder.vue` |
| 长期记忆 | `/long-term-memory` | `LongTermMemory.vue` |
| 坦克大战 | `/tank-battle` | `TankBattle.vue` |

Blank page / “右边什么都没有” on a menu click: usually a **Vue render crash** (template refs missing `data`/`computed`/`methods`). Fix the **view for that route**, not an unrelated file.

## Panda agent conventions

- Agent code lives in `server/engine/panda/`. System prompt: `prompts.js`. Tools: `tools.js`.
- **Memory (三层)**：L1 `.panda/MEMORY.md` 只作**索引**（进 system）；详情在 `.panda/memory/topics/<id>.md`，用 `memory_read(topic)` / `memory_append`；空闲 `/dream` 或后台 autoDream 合并 `auto.md`。L2 为本文件等项目约定；L3 为会话 transcript/scratchpad（溢出会 compact → SessionMemory 注入下一轮）。
- **「聪明感」工程层（对齐 panda-code，非神话 CodeGraph）**：启动 Project snapshot 进 Env；只读工具 / Explore fork 并行；bash/build 失败自愈续跑；compact→SessionMemory；改已有文件优先 `edit_file`/`apply_patch`。
- **三层「监工」硬保证（对齐真实源码，非传言目录）**：
  1. **执行环**：`agent.js` `while` + `apiRetry.js` 指数退避；`failureFuse.js` 同指纹最多 5 次后硬拒并注入 `<correction_prompt>`（不改 system 禁令神话）。
  2. **上下文**：每轮推理前 `maybeCompactMessages`；micro 保留最近 5 条 tool 正文；auto 阈值≈window−13k；`system`/MEMORY 永不丢。
  3. **输出监狱**：`toolValidate.js` + `editMatch.assertReadableForWrite` 写前校验；失败不落盘，错误进下一轮 tool_result。
- **五脏映射（传言模块名 → 真实代码，勿按谣言路径找）**：
  1. 意图锁定 ≠ `parseIntent`：软候选路径（IDE 打开 + git dirty）+ `assertReadableForWrite`（未 read 拒写）。
  2. 手术刀编辑 ≠ `BlockEdit`/MD5：`edit_file`/`apply_patch` + mtime 新鲜度；无并发写块、无 &lt;200ms 语法自动回滚（诊断续跑 + `undo_file`）。
  3. 自愈 ≠ `errorRecoveryLoop`/临时分支：`pendingCommandFail` + `PANDA_MAX_HEALING`（默认 3）耗尽则停；回退靠 `fileHistory`/`undo_file`。
  4. 记忆锚点 ≠ `historyManager`：`readFileState` LRU + compact 后文件恢复 + SessionMemory；磁盘变更 → `changed_files` 附件。
  5. 多 Agent ≠ `teamManager` fork+mkdtemp：`.panda/teams/.../inbox` 邮箱 + Swarm/`enter_worktree` 隔离。
- **骨骼/神经映射（传言 → 真实，勿实现谣言模块）**：
  1. 三步 stage-gate ≠ `stage-gate.ts`：真实是 **Plan Mode 权限闸门**（`enter_plan_mode` + `canWriteFile` 拒写）；只读工具始终可用，不会因第一轮调工具杀会话。
  2. CodeGraph/tree-sitter 全仓图 ≠ 存在：仅有 `projectSnapshot` + Explore/grep；tree-sitter 在上游主要用于 bash 安全 AST，不是补丁波及预判。
  3. memfs 金丝雀编译 ≠ 存在：写前是 `toolValidate`/`assertReadableForWrite`；写后 LSP/`pendingDiagErrors` 续跑，不是内存 `tsc` 再落盘。
  4. behaviorTrace 杀进程广播 ≠ 存在：`tool-trace.jsonl` 本地观测 + 连续 3 次空 grep **软纠偏**；Team 靠 inbox/`abort`，不广播「别搜了」。
  5. EventBus/pubsub ≠ 存在：`sendEvent` UI 推送 + team mailbox。
- Sessions: `.panda/sessions/`；Team 邮箱: `.panda/teams/<id>/inbox/`；Swarm implementer 可用独立 git worktree。
- Prefer dedicated tools (`read_file` / `edit_file` / `glob` / `grep`) over bash for file ops.
- `edit_file`: copy `old_string` from `read_file` **without** line-number prefixes; must Read before Write.
- **Multi-turn**: keep tool-calling until the goal is done; Stop gate / diagnostics / verify FAIL auto-continue (Keep working).
- **Auto-fix**: after edits, read `<new-diagnostics>`; errors must be fixed before finishing. Edit failures → re-read and retry.
- **Quality**: no gold-plating; trivial style (background/color) → minimal CSS only, no mandatory Verify; non-trivial → `Agent(Verify)`; PARTIAL may finish; don’t infinite-retry Verify.
- **Verify vs panda-code**：默认 soft nudge（Stop 不硬拦）；`PANDA_VERIFY_HARD=1` 才硬闸。缺证据降 PARTIAL；grep exit=1 算负证据。
- **权限闸门**：对齐 panda-code — 默认 acceptEdits；bypass/auto/dontAsk；bash/PowerShell 按段 + bashSecurity；可选 `osSandbox`（工作台 chip）；hooks 含 Compact/Subagent/SessionEnd/PermissionDenied；Swarm team 权限弹窗；auto 分类器带 transcript/CLAUDE.md；SessionMemory 结构化；MCP OAuth code 换 token；工具含 `verify_plan` / `powershell` / capture_page actions / `.panda/agents`。
- DeepSeek **chat/reasoner** do not accept `image_url` with tools; vision models may. Multimodal paste/`capture_page` inject images only when the active model supports multimodal; otherwise omit `image_url` and follow the explicit “不支持多模态” hint.
- UI polish: see pixels first (user paste or `capture_page` on localhost). Do not invent layout from memory.
- New user message = new goal unless they say 继续 / 接着做. Use `/clear` for a clean slate.
- Cron: API 进程内常驻 tick（`PANDA_CRON_SCHEDULER=0` 可关）；到期记入 `.panda/cron-due.jsonl`。

## Vue / ElementUI habits

- Options API + Vue 2.7; ElementUI components (`el-*`).
- Keep template bindings in sync with `data` / `computed` / `methods` (missing handlers crash the whole view).
- Prefer local `<style scoped>` edits over rewriting entire SFCs.
- Router is `history` mode; menus in `App.vue` use `index="/path"`.

## Do / don’t

- **Do** search (`grep` Chinese labels, route paths) before editing.
- **Do** verify after non-trivial UI fixes (diagnostics / re-read / optional `capture_page`).
- **Don’t** invent APIs or change ports without need.
- **Don’t** dump huge base64 into session transcripts; uploads go under `.panda/uploads/`.
- **Don’t** treat IDE-open files as the default edit target unless the user said so.
