# ShiyunN8n runtime (AIFront)

Headless **n8n workflow / AI-agent builder** subagent:

1. Compose Instance-AI skills + distilled workflow-builder prompts from `assets/`
2. Delegate execution to `chomircode-agent` (same as ShiyunDesign / ShiyunCode)
3. Deliver importable `*.workflow.json` / Workflow SDK TS under `--cwd`

**Bundle budget:** `shiyunn8n/` ≤ **3 MB** (enforced by sync + pack).

## Asset layers

| Layer | Source |
|-------|--------|
| `skills/` | n8n `@n8n/instance-ai/skills` |
| `docs/` | architecture / tools / configuration excerpts |
| `knowledge-base/` | workflow guardrails + trigger shapes |
| `prompts/workflow-builder/` | distilled from `ai-workflow-builder.ee` |
| `prompts/sections/` | headless delivery + JSON shape |
| `meta/n8n-cli/` | n8n REST CLI skill |

Skipped: frontend, nodes-base, Instance-AI runtime, agents SDK (too large).

## Commands

```bash
yarn sync:n8n-into-shiyunn8n
node bin/shiyunn8n-agent.js --cwd ./out --task "Webhook → Slack 通知工作流"
yarn pack:dsh-subagent-shiyunn8n
```
