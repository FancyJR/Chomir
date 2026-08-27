# ShiyunDesign delivery workflow

- Start from context: user task, default design system, optional brand-ref, task-selected method skills.
- Write self-contained HTML/CSS/JS deliverables under cwd; prefer `index.html` unless the user names a file.
- After the primary HTML file is written, stop — the runtime opens it in the browser.
- Do not start local HTTP servers or install puppeteer/playwright for verification loops.
- For multi-screen work, maintain `DESIGN.md` in cwd as the cross-page baton (colors, type, spacing, radius).
- Respond in Chinese when the user writes in Chinese.
