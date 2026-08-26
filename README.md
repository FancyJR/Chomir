# Chomir

<p align="center">
  <img src="docs/assets/chomir-icon.png" alt="Chomir" width="160" />
</p>

<p align="center"><strong>重明丽正，以鉴万码</strong></p>

Chomir 是基于 Code - OSS 打造的桌面代码客户端：完整编辑 / 调试 / 扩展生态，并在侧边 **Chat** 中内置写代码 Agent，可在当前工作区里读文件、改代码、跑命令、连工具，用自然语言把需求落到仓库里。

## 客户端能做什么

在熟悉的编辑器体验之上，打开 Chat（默认参与者 **ChomirCode**）即可：

- **写与改代码**：按任务创建 / 修改 / 重构文件，多轮工具循环直到做完
- **读懂仓库**：搜索、打开、对照现有实现，再动手改
- **跑终端命令**：安装依赖、跑测试、构建、诊断，失败可继续自愈重试
- **权限可控**：允许 / 本会话记住 / 拒绝；也可切 Auto-run 少打断
- **会话不断档**：跨轮次记住上下文；工作区 `.panda/` 存记忆、Skills、权限等
- **斜杠与扩展能力**：`/help`、`/skills`、`/memory`、`/fork` 等；可接 MCP 外部工具
- **模型可配**：DeepSeek 等 OpenAI 兼容接口；命令面板搜 **ChomirCode:** 管理 Key / 模型 / 权限

仍保留上游编辑器能力：多语言编辑、Git、调试、终端、扩展市场兼容的扩展模型等。

## 怎么跑起来

### 环境

- Node.js：见 [`.nvmrc`](.nvmrc)（建议 24.x）
- 与上游 Code - OSS 相同的系统依赖（Python、编译工具等）
- 配置 API Key：命令面板 → **ChomirCode: Set API Key** / **Manage Models**（或设置项 `chomircode.apiKey`）

### 开发启动

```bash
npm install
npm run watch          # 增量编译；也可先 npm run compile
./scripts/code.sh      # 启动 Chomir 客户端
```

启动后：

1. 打开一个**工作区文件夹**（Agent 以该目录为操作范围）
2. 打开 **Chat** 面板
3. 用默认参与者描述任务即可开始改代码

可选：在工作区放 `.panda/mcp.json`、`permissions.json`、`hooks.json`、`skills/` 等，定制 MCP、权限与 Skills。

## 打包客户端

开发验证通过后，用 gulp 打各平台客户端。产物落在**仓库同级目录**（不是仓库内），例如 `../VSCode-darwin-arm64/`。建议先 `npm install`，并确保 `extensions/copilot` 依赖已装（打包脚本会检查）。

架构取值：`x64` / `arm64`（Linux 另有 `armhf`）。

### macOS

一键试用包（打 `.app`、嵌入写代码引擎、ad-hoc 签名，并生成 zip / dmg）：

```bash
./scripts/package-macos-trial.sh         # 本机架构
./scripts/package-macos-trial.sh arm64
./scripts/package-macos-trial.sh x64
```

| 产物 | 位置 |
|------|------|
| `.app` | `../VSCode-darwin-<arch>/Chomir.app` |
| zip / dmg | `dist/macos-trial/` |

安装提示：拖到「应用程序」后执行 `xattr -cr "/Applications/Chomir.app"`，再右键 → 打开。然后 ⌘⇧P → **ChomirCode: Manage Models** 配置 API Key。

仅打客户端、不走试用脚本时：

```bash
npm run gulp vscode-darwin-arm64-min   # 或 vscode-darwin-x64-min
```

### Windows

在 Windows 上打包（或能交叉出 win32 产物的构建环境）：

```bash
npm run gulp vscode-win32-x64-min      # 或 vscode-win32-arm64-min
```

目录产物：`../VSCode-win32-<arch>/`（可直接运行其中的 `Chomir.exe`）。

需要安装包时再打 Inno Setup（需本机有 Inno Setup）：

```bash
npm run gulp vscode-win32-x64-user-setup     # 当前用户
npm run gulp vscode-win32-x64-system-setup   # 系统级
# arm64 同理：vscode-win32-arm64-user-setup / system-setup
```

安装包中间产物在 `.build/win32-<arch>/`。

### Linux

```bash
npm run gulp vscode-linux-x64-min      # 或 arm64 / armhf
```

目录产物：`../VSCode-linux-<arch>/`。

可选 deb / rpm（在对应发行版或 CI 环境执行）：

```bash
npm run gulp vscode-linux-x64-prepare-deb
npm run gulp vscode-linux-x64-build-deb

npm run gulp vscode-linux-x64-prepare-rpm
npm run gulp vscode-linux-x64-build-rpm
```

### 写代码能力一并打进包

macOS 试用脚本会自动把写代码引擎打进 `.app`。Win / Linux 打完 gulp 产物后，需把仓库内引擎目录同步到客户端的 `resources/app/` 下（与 mac 脚本同一相对位置），否则 Chat Agent 无法在正式包里启动。配置模型仍用 **ChomirCode: Manage Models**。

## 许可

基于上游 Code - OSS，遵循 [MIT](LICENSE.txt)。Chomir 品牌与标识归本项目；Visual Studio Code 商标归 Microsoft。
