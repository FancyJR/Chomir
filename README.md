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

### macOS 试用包

```bash
./scripts/package-macos-trial.sh   # 可选：arm64 / x64
```

产物在 `dist/macos-trial/`。打包后的 `.app` 可直接双击试用（改资源后需脚本内 ad-hoc 签名步骤）。

## 许可

基于上游 Code - OSS，遵循 [MIT](LICENSE.txt)。Chomir 品牌与标识归本项目；Visual Studio Code 商标归 Microsoft。
