# ShiyunDesign runtime (AIFront)

OpenDesign + **open-codesign** design subagent: composes craft/design-system/brand/method-skill
prompts from bundled `assets/`, then delegates execution to `chomircode-agent`.

**Bundle budget:** entire `shiyundesign/` tree must stay **≤ 5 MB** (enforced by sync + pack scripts).

## Asset layers

| Layer | Source | Notes |
|-------|--------|-------|
| `craft/` | OpenDesign (existing) | 7 rulebooks — not re-imported from open-codesign |
| `design-systems/default/` | OpenDesign (existing) | Neutral Modern + tokens.css |
| `skills/web-clone/` | OpenDesign (existing) | Full site-clone toolchain |
| `skills/artifacts-builder/` | OpenDesign (existing) | Artifact composition stub |
| `skills/method/` | **open-codesign** | 15 method skills (CJK typography, forms, charts, …) |
| `brand-refs/` | **open-codesign** | 25 brand DESIGN.md refs + manifest |
| `design-skills/` | **open-codesign** | JSX/HTML pattern references |
| `scaffolds/` + `frames/` | **open-codesign** | CSS backgrounds, device frames, UI primitives |
| `prompts/sections/` | **open-codesign** (adapted) | Methodology + HTML delivery workflow |

Skipped from open-codesign (already covered): `frontend-design-anti-slop`, `craft-polish`, React-host `workflow.md`.

## Sync assets

```bash
# Merge open-codesign templates (primary)
yarn sync:opencodesign-into-shiyundesign

# Legacy: refresh web-clone/craft from Kylin bank overlay
yarn sync:shiyundesign-assets
```

## CLI

```bash
node bin/shiyundesign-agent.js --cwd /path/to/output --task "用 Linear 风格做一个中文 SaaS landing page"
```

Prompt composition is **task-aware** (`lib/select-design-assets.js`): only relevant method skills, brand refs, and JSX patterns are injected (48K char budget).

## DSH plugin

`packages/dsh-subagent-shiyundesign/` — pack with 5MB guard:

```bash
yarn pack:dsh-subagent-shiyundesign
```
