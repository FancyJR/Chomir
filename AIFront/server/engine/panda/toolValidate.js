/**
 * 工具输入「Schema 监狱」（对齐 panda-code toolExecution: inputSchema.safeParse + validateInput）
 * 在落盘 / 执行前同步校验；失败 → is_error 风格文案，绝不写文件。
 * 不是神话里的 validateOutputSchema(new_content 括号检查)；真实保证是写前门禁。
 */

const path = require('path')

function toolUseError (message, code) {
  return {
    ok: false,
    content: '<tool_use_error code="' + (code || 'schema') + '">' + String(message || 'invalid input') + '</tool_use_error>',
    meta: { validationFailed: true, errorCode: code || 'schema' }
  }
}

function requireString (args, key, tool) {
  const v = args && args[key]
  if (v == null || String(v).trim() === '') {
    return toolUseError(tool + ' 缺少必填字段: ' + key, 1)
  }
  return null
}

/** 粗检 unified diff 形状（无 @@ 则拒） */
function validatePatchShape (patch) {
  const t = String(patch || '')
  if (!t.trim()) return toolUseError('apply_patch 需要非空 patch', 1)
  if (!/^@@\s+-\d+/m.test(t) && !/^\+\+\+/m.test(t) && !/^---/m.test(t)) {
    return toolUseError('apply_patch: patch 不像 unified diff（需 ---/+++ 与 @@ hunk）。请改用 edit_file 或修正 diff。', 8)
  }
  if (!/^@@\s+-\d+/m.test(t)) {
    return toolUseError('apply_patch: 缺少 @@ hunk 行，拒绝落盘。', 8)
  }
  return null
}

/**
 * 写前结构校验（不读盘；读盘门禁仍在 editMatch.assertReadableForWrite）
 * @returns {{ ok:false, content, meta }|null} null = 通过
 */
function validateToolInput (name, args) {
  args = args || {}

  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' ||
      name === 'apply_patch' || name === 'edit_lines' || name === 'undo_file' ||
      name === 'lsp_diagnostics' || name === 'notebook_edit') {
    const m = requireString(args, 'path', name)
    if (m) return m
    const p = String(args.path || '')
    if (p.includes('\0') || /[\x00-\x08]/.test(p)) {
      return toolUseError('非法路径字符', 2)
    }
  }

  if (name === 'write_file') {
    if (args.content == null) return toolUseError('write_file 需要 content', 1)
  }

  if (name === 'edit_file') {
    const hasEdits = Array.isArray(args.edits) && args.edits.length
    if (!hasEdits && args.old_string == null && args.new_string == null) {
      return toolUseError('edit_file 需要 old_string/new_string 或 edits[]', 1)
    }
    if (!hasEdits && args.old_string != null && args.new_string === args.old_string) {
      return toolUseError('edit_file: new_string 与 old_string 相同，拒绝空操作', 5)
    }
    // 行号前缀误带：硬拒（模型常把 12|code 当 old_string）
    const samples = hasEdits
      ? args.edits.map(e => String((e && e.old_string) || ''))
      : [String(args.old_string || '')]
    for (let i = 0; i < samples.length; i++) {
      if (/^\s*\d+\|/.test(samples[i]) || /\n\s*\d+\|/.test(samples[i].slice(0, 400))) {
        return toolUseError(
          'edit_file: old_string 含行号前缀 N|（来自 read_file 展示）。请去掉行号后重试，或改用 apply_patch。',
          8
        )
      }
    }
  }

  if (name === 'apply_patch') {
    const bad = validatePatchShape(args.patch)
    if (bad) return bad
  }

  if (name === 'edit_lines') {
    if (args.start_line == null && args.startLine == null) {
      return toolUseError('edit_lines 需要 start_line', 1)
    }
  }

  if (name === 'bash' || name === 'bash_bg') {
    const m = requireString(args, 'command', name)
    if (m) return m
  }

  if (name === 'grep') {
    const m = requireString(args, 'pattern', name)
    if (m) return m
  }

  if (name === 'glob') {
    const m = requireString(args, 'pattern', name)
    if (m) return m
  }

  return null
}

/** 写后可选：粗括号平衡（仅整文件 write 时；增量 edit 不做，避免误杀） */
function validateWrittenContentBalance (relPath, content) {
  const ext = path.extname(String(relPath || '')).toLowerCase()
  if (!/\.(js|jsx|ts|tsx|vue|json|mjs|cjs)$/.test(ext)) return null
  const s = String(content || '')
  // 跳过字符串的极简扫描：只计非字符串外括号
  let brace = 0
  let brack = 0
  let paren = 0
  let quote = null
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') brace++
    else if (c === '}') brace--
    else if (c === '[') brack++
    else if (c === ']') brack--
    else if (c === '(') paren++
    else if (c === ')') paren--
    if (brace < -2 || brack < -2 || paren < -2) {
      return toolUseError('写入内容括号严重失衡，已拒绝落盘。请修正后再 write_file。', 11)
    }
  }
  if (Math.abs(brace) > 3 || Math.abs(brack) > 3 || Math.abs(paren) > 3) {
    return toolUseError(
      '写入内容括号未闭合（{:' + brace + ' [:' + brack + ' (:' + paren + '）。拒绝落盘。',
      11
    )
  }
  return null
}

module.exports = {
  validateToolInput,
  validatePatchShape,
  validateWrittenContentBalance,
  toolUseError
}
