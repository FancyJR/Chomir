/**
 * Bash 注入/危险模式启发（对齐 bashSecurity / AST 精髓，无 tree-sitter 依赖）
 * 命中 → ask 或 deny，供 permissionRules / canRunBash 使用。
 */

/**
 * @returns {{ ok: true } | { ok: false, severity: 'deny'|'ask', reason: string }}
 */
function analyzeBashSafety (command) {
  const cmd = String(command || '')
  if (!cmd.trim()) return { ok: false, severity: 'deny', reason: '空命令' }

  // 明显破坏 / 提权
  if (/\beval\s*[(/\`]|\beval\s+["']/i.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '含 eval，需确认（注入风险）' }
  }
  if (/\bsource\s+<\(|\.\s+<\(/i.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '进程替换 source，需确认' }
  }
  // 命令替换用于执行（粗）：$(curl|wget|...) 或 `curl|...`
  if (/\$\(\s*(curl|wget|fetch|python|perl|ruby|node|bash|sh)\b/i.test(cmd) ||
      /`\s*(curl|wget|python|perl|ruby|node|bash|sh)\b/i.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '命令替换拉取/解释器执行，需确认' }
  }
  // IFS / 环境注入常见绕过
  if (/\bIFS\s*=/i.test(cmd) && /\$[({0-9]/.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '可疑 IFS 与变量展开组合' }
  }
  // $'...' ANSI-C quoting 藏换行执行第二命令（简化检测）
  if (/\$'[^']*\\n[^']*'/i.test(cmd) && /\$'[^']*;[^']*'/.test(cmd)) {
    return { ok: false, severity: 'ask', reason: 'ANSI-C 引号内含 ; 与换行，需确认' }
  }
  // 隐藏字符
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cmd)) {
    return { ok: false, severity: 'deny', reason: '命令含控制字符' }
  }
  // 历史扩展
  if (/(^|[^[])![!0-9?:$a-zA-Z_]/.test(cmd) && !/#!\//.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '含 bash 历史扩展 !，需确认' }
  }
  // zsh/bash 进程替换写
  if (/>\s*\(.*\)|< <\(/.test(cmd) && /\b(bash|sh|zsh|python|node)\b/i.test(cmd)) {
    return { ok: false, severity: 'ask', reason: '进程替换与解释器组合，需确认' }
  }
  // base64 | sh 已在 HARD_DENY；此处补 xxd/openssl 管道
  if (/\b(xxd|openssl)\b[\s\S]*\|\s*(ba)?sh\b/i.test(cmd)) {
    return { ok: false, severity: 'deny', reason: '解码管道进 shell' }
  }

  return { ok: true }
}

module.exports = {
  analyzeBashSafety
}
