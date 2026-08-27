# ChomirCode Agent (built-in Chat)

Default Chat participant for Code OSS. Starts the **ChomirCode Express sidecar** and talks to the full panda control plane (`/api/engine/execute` + `/api/panda/*`) — same surface as `PandaWorkbench.vue`.

## ShiyunDesign (product prototypes)

Second Chat participant **`@shiyundesign`** for product / PM HTML prototypes (landing pages, dashboards, mockups).

- Writes deliverables under **`prototypes/<session>/`** in the workspace (config: `chomircode.prototypesDir`)
- Runs `bin/shiyundesign-agent.js` (OpenDesign assets + ChomirCode executor)
- Opens the primary HTML in the system browser when done (`chomircode.openDesignPreview`)
- Command: **ShiyunDesign: Open Prototypes Folder**

Same API key and `chomircode.enginePath` (AIFront repo root) as ChomirCode.

## Capabilities (via sidecar)

- Multi-round tool loop (~54 tools): files, bash, web, todos, plan, …
- Interactive **permissions** (allow / session / remember / deny)
- **Steer** mid-run follow-ups
- **Sessions** continuity across Chat turns
- **Slash** commands (`/help`, `/skills`, `/memory`, `/fork`, …)
- **MCP** connect + OAuth prompt
- Skills / Hooks / Memory / Permissions via workspace `.panda/`
- Cron / background tasks / swarms / worktree (dashboard)
- CLI one-shot fallback if sidecar fails

## Setup

1. `ChomirCode` sibling of this vscode repo, or set `chomircode.enginePath`.
2. Configure API Key via Models → **Configure API Key / Manage Models…** (or `chomircode.apiKey`).
3. Launch Code OSS, open a **workspace folder**, open Chat.
4. Optional: create `.panda/mcp.json`, `permissions.json`, `hooks.json`, `skills/` in the workspace.

## Commands

Search **ChomirCode:** in the Command Palette — Engine Dashboard, Connect MCP, Open MCP/Permissions/Hooks/Skills/Memory, Cycle Permission Mode, etc.
