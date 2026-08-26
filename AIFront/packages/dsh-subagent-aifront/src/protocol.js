/**
 * AIFront headless CLI ↔ DSH provider stdout protocol (no DSH imports).
 */

/**
 * Parse the last non-empty stdout line as AIFront JSON result.
 * @param {string} stdout
 * @returns {{ ok?: boolean, aborted?: boolean, finalAnswer?: string, error?: string, sessionId?: string, changed?: string[] }}
 */
export function parseAgentStdout(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return { ok: false, error: 'chomircode-agent produced no stdout' }
  }
  const last = lines[lines.length - 1]
  try {
    return JSON.parse(last)
  } catch {
    return {
      ok: false,
      error: 'chomircode-agent stdout was not JSON: ' + last.slice(0, 200),
      finalAnswer: lines.join('\n'),
    }
  }
}
