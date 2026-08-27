# ShiyunN8n DSH 子代理

基于 AIFront/`chomircode-agent` 的 n8n 工作流 / AI Agent 构建子代理。
知识资产来自 n8n Instance-AI skills + ai-workflow-builder prompts（精简抽取，不含完整 monorepo）。

**包体上限 3 MB**（`pack:dsh-subagent-shiyunn8n` 打包前校验）。

## 在 AIFront monorepo 中使用

```bash
node bin/shiyunn8n-agent.js --cwd /path/to/out --task "做一个 webhook 收消息转发到 Slack 的工作流"
```

## DSH preset

见 `cordis.patch.example.yml`。父 Agent 工具名：`subagent_shiyunn8n`（provider：`shiyunn8n`）。

## 打包

```bash
yarn sync:n8n-into-shiyunn8n
yarn pack:dsh-subagent-shiyunn8n
```
