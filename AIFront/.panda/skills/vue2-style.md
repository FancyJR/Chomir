# Vue2 样式修改规范

1. 先 `read_file` 目标 `.vue`（引擎会拒绝未 Read 的编辑）
2. 只用 `edit_file` 改 `<style scoped>` 内相关选择器；`old_string` 不要带行号前缀 `N|`
3. `old_string` 保持唯一；多处改用 `edits` 数组或 `replace_all`
4. 不要重写 template/script，除非用户明确要求；勿用 `write_file` 整页覆盖做小改
5. 改完查看返回的 `<new-diagnostics>`；写错用 `undo_file`
