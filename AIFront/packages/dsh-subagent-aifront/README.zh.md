# @aifront/dsh-subagent-aifront

把 **AIFront 自己的写代码能力** 做成 DeepSeek Harness 可调用的 one-shot 子代理（对标 Codex / Claude Code 接入方式）。

## 组成

| 部件 | 作用 |
|------|------|
| AIFront `chomircode-agent` CLI | 独立进程，在指定 cwd 跑一轮写代码，**stdout 只打一行 JSON 最终结果** |
| 本包 Provider `aifront` | 注册到 `ctx.subagents`，spawn CLI，映射为 `SubagentRun` |
| `@deepseek-ai/dsh-tool-subagent` | 向父模型暴露工具 `subagent_aifront` |

约定：`inheritsParentContext: false`；不继承父会话 transcript；只回最终答案。

## 本地 CLI

在 AIFront 仓库根目录：

```bash
node bin/chomircode-agent.js --cwd /path/to/project --task "给 README 加一行说明"
# 或
npm run chomircode-agent -- --cwd /path/to/project --task "..."
```

stdout 示例：

```json
{"ok":true,"finalAnswer":"已完成…","sessionId":"aifront_sub_…","changed":["README.md"]}
```

诊断日志在 stderr。需要 `DEEPSEEK_API_KEY`（可读 `.env.local`）。

## 接到 DSH / Kylin Desktop

1. 安装本包到 Desktop 工作区（任选其一）：

```bash
# 在 deepseek-harness-Kylin-desktop 根目录
yarn link /absolute/path/to/AIFront/packages/dsh-subagent-aifront
# 或 package.json resolutions / dependencies:
# "@aifront/dsh-subagent-aifront": "file:../AIFront/packages/dsh-subagent-aifront"
```

2. 确保父进程能启动 CLI（默认会解析 AIFront 仓库旁的 `bin/chomircode-agent.js`；否则把 `chomircode-agent` 加到 PATH，或在 config 里写死 `command`/`args`）。

3. 按 [cordis.patch.example.yml](./cordis.patch.example.yml) 插入 provider + tool 两行；复制 Agent Preset 后启用 `tool-subagent-aifront`。

4. 重启 Desktop / harness，在带 workspace cwd 的会话里让父模型调用 `subagent_aifront`。

## 配置

| 键 | 默认 | 含义 |
|----|------|------|
| `command` | `node`（若找到仓库 bin）或 `chomircode-agent` | 可执行文件 |
| `args` | `[…/bin/chomircode-agent.js]` 或 `[]` | 前置参数 |
| `env` | `{}` | 叠在凭证 scrub 后的环境上；Mac/Windows 会自动从 DSH 凭据注入 `DEEPSEEK_API_KEY`（与父模型同一把），也可用 `env` / `AIFront/.env.local` 覆盖 |
| `disposeGraceMs` | `3000` | 进程树终止宽限 |

## 与官方子代理的差异

- 不实现 Codex app-server / Claude Agent SDK 协议。
- 子进程协议就是 AIFront headless JSON 一行结果。
- 引擎实现可复用仓库内 coding agent；对外品牌是 **aifront**，不是 Claude Code。
