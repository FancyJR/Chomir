# ShiyunDesign runtime extensions (headless CLI)

Optional capabilities beyond default HTML delivery. **Only use when the user task or injected sections call for them.** Do not replace bundled craft/method/web-clone flows.

## Scripts (run from task cwd)

All paths are under the ShiyunDesign runtime root (`{{RUNTIME_ROOT}}`).

| Capability | When | Command |
|------------|------|---------|
| Brand extract | User supplies `tailwind.config.*`, `tokens.css`, or DTCG JSON | `node {{SCRIPTS}}/brand-extract.mjs --file <path> --out DESIGN.extracted.md` |
| AI image | Hero/background needs generated bitmap (not SVG/CSS) | `node {{SCRIPTS}}/generate-image.mjs --cwd . --prompt "..." --purpose hero` |
| UI kit handoff | User asks for coding-agent-ready bundle | Write `ui-kit-plan.json`, then `node {{SCRIPTS}}/decompose-ui-kit.mjs --cwd . --plan ui-kit-plan.json` |
| UI kit verify | After decompose | `node {{SCRIPTS}}/verify-ui-kit-parity.mjs --cwd . --slug <slug>` — re-decompose if score < 0.85 |
| Preview capture | Pixel iteration or design-reference compare | `node {{SCRIPTS}}/preview-capture.mjs --html index.html --out .shiyundesign/preview.png` |
| Preview compare | Reference PNG vs capture | `node {{SCRIPTS}}/preview-compare.mjs --original ref.png --clone .shiyundesign/preview.png` |
| Session brief | Multi-turn continuation | Read `.shiyundesign/brief.json`; update via `node {{SCRIPTS}}/design-brief.mjs update --cwd . --task "..."` |

## UI kit plan JSON shape

```json
{
  "slug": "landing-linear",
  "indexHtml": "<!DOCTYPE html>...",
  "components": [{ "name": "Hero", "filename": "Hero.tsx", "source": "...", "propsSummary": "title, cta" }],
  "tokens": [{ "name": "color-primary", "value": "#5E6AD2", "category": "color" }],
  "readmeNotes": "Handoff notes"
}
```

Emit **one complete plan** per decompose call.

## Preview iteration loop

1. Capture: `preview-capture.mjs`
2. Compare against reference (if any): `preview-compare.mjs`
3. Fix HTML/CSS; repeat until diff score ≥ 4 or user satisfied
4. Do **not** install new npm packages; only use bundled scripts above or existing web-clone scripts

## Brand extract

- Never invent brand hex/fonts when a source file is provided — extract first, merge into cwd `DESIGN.md`
- Bundled `brand-refs/` still override when user names a known brand slug

## AI image

- Requires `SHIYUNDESIGN_IMAGE_API_KEY` or `OPENAI_API_KEY`
- Prefer CSS/SVG for icons, charts, gradients; use generate-image only for photographic/illustration assets
- Reference output path in HTML: `assets/images/...`

## Conflicts to avoid

- Default delivery remains self-contained `index.html` in cwd
- web-clone tasks: follow web-clone SKILL; do not also run preview-capture unless comparing your output to a local reference PNG
- Do not start HTTP servers for preview; use `file://` capture only
