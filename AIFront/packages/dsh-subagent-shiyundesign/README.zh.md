# ShiyunDesign DSH 子代理

OpenDesign 设计子代理：从 bundled `AIFront/shiyundesign/assets` 组装 craft/设计系统/brand/method-skill prompt，
再调用 `chomircode-agent` 产出 HTML/CSS 等交付物，完成后自动打开浏览器预览。

**包体上限 5 MB**（`pack:dsh-subagent-shiyundesign` 会在打包前校验 vendor 体积）。

## 在 AIFront  monorepo 中使用

1. 确保 `AIFront/bin/shiyundesign-agent.js` 可执行，且 `DEEPSEEK_API_KEY` 已配置。
2. 在 DSH preset 中插入 `cordis.patch.example.yml` 片段。
3. 父 Agent 可通过 `subagent_shiyundesign` 工具委派设计任务。

## 打包为 Kylin dropin

```bash
yarn pack:dsh-subagent-shiyundesign
```

后续可像 Kylin bank 插件一样，将 `shiyundesign/` runtime 与 `chomircode-agent` 一并 vendor 进 tgz。
