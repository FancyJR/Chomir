# Minimal n8n workflow JSON shape

```json
{
  "name": "Example",
  "nodes": [
    {
      "id": "1",
      "name": "Manual Trigger",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0],
      "parameters": {}
    }
  ],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "meta": { "templateCredsSetupCompleted": true }
}
```

Rules:

- Every node needs unique `id`, `name`, `type`, `typeVersion`, `position`, `parameters`.
- `connections` maps source node name → outputs → target `{ node, type, index }`.
- Prefer well-known nodes: `manualTrigger`, `webhook`, `scheduleTrigger`, `httpRequest`, `code`, `if`, `set`, `slack`, `gmail`, LangChain agent nodes when building AI agents.
- Never put real secrets in the JSON; use credential placeholders and document required creds in README.
