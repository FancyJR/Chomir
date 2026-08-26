# Chomir

**重明丽正，以鉴万码** — 基于 [Code - OSS](https://github.com/microsoft/vscode) 的 AI 原生代码编辑器。

Chomir 在完整 VS Code 编辑 / 调试 / 扩展能力之上，内置 **ChomirCode Agent**（默认 Chat 参与者），并与仓库内的 **AIFront** 引擎联动，把多轮工具调用、权限、记忆、MCP、Skills 等能力直接接到工作台 Chat。

## 仓库构成

| 路径 | 说明 |
|------|------|
| 根目录（`src/`、`extensions/`…） | Code - OSS 工作台与内置扩展；产品名见 `product.json`（`Chomir` / `chomir`） |
| [`AIFront/`](AIFront/) | Vue 2.7 + Express 的 Panda 控制面与 headless agent（`bin/chomircode-agent.js`） |
| [`extensions/chomircode-agent/`](extensions/chomircode-agent/) | 内置 Chat 扩展：拉起 AIFront sidecar，对接 `/api/engine/execute` 与 `/api/panda/*` |

上游 VS Code 的架构与贡献约定仍可参考 [`.github/copilot-instructions.md`](.github/copilot-instructions.md)。

## 能力概览

通过 Chat（默认参与者 `@chomircode`）与 AIFront sidecar：

- **多轮 Agent 循环**：读改文件、终端、检索、计划 / todo 等（约 50+ 工具）
- **权限闸门**：允许 / 本会话 / 记住 / 拒绝；支持中途 **Steer**
- **会话与记忆**：跨轮次会话；工作区 `.panda/`（MEMORY、topics、skills、hooks、permissions）
- **斜杠命令**：`/help`、`/skills`、`/memory`、`/fork` 等
- **MCP**：连接与 OAuth；可在命令面板搜索 **ChomirCode:**
- **模型**：内置 DeepSeek 等 OpenAI 兼容供应商；也可走 CLI 一次性回退

AIFront 另提供 Web 工作台（Panda 工作台、编排、长期记忆等），与 IDE Chat 共用同一套引擎。详见 [`AIFront/Panda.md`](AIFront/Panda.md)、[`extensions/chomircode-agent/README.md`](extensions/chomircode-agent/README.md)。

## 快速开始

### 环境

- Node.js（见 [`.nvmrc`](.nvmrc)，当前建议 24.x）
- Python、系统构建工具等与上游 Code - OSS 相同依赖
- AIFront 侧：复制 `AIFront/.env.example` → `AIFront/.env.local`，填入 `DEEPSEEK_API_KEY`（勿提交密钥）

### 开发运行（编辑器）

```bash
npm install
npm run watch          # 或先 npm run compile
./scripts/code.sh      # 启动 Chomir 开发实例
```

打开一个**工作区文件夹**，打开 Chat，使用默认参与者即可。可选：在工作区配置 `.panda/mcp.json`、`permissions.json`、`hooks.json`、`skills/`。

扩展设置：命令面板搜索 **ChomirCode:**，或配置 `chomircode.apiKey` / `chomircode.enginePath`（默认会解析仓库内 `AIFront/`）。

### 单独跑 AIFront

```bash
cd AIFront
yarn install   # 或 npm install
yarn dev       # 前端 + Express；或 yarn serve / yarn server
```

### macOS 试用包

```bash
./scripts/package-macos-trial.sh   # 可选参数：架构，如 arm64 / x64
```

产物在 `dist/macos-trial/`，会打包 Chomir 客户端并嵌入 AIFront 引擎。

## 开发提示

- Agent 技能：仓库内 [`.agents/skills/launch`](.agents/skills/launch/SKILL.md) 可用于拉起隔离 profile 做 UI 自动化 / 调试。
- 运行时会话与缓存（如 `.panda/sessions/`）属于本地状态，不要提交。
- 大仓操作避免无差别 `git add -A`；只暂存需要推送的路径。

## 许可

本仓库基于上游 Code - OSS，遵循 [MIT](LICENSE.txt)。产品商标与品牌标识归 Chomir / 本项目维护方；上游 Visual Studio Code 商标归 Microsoft。
