/**
 * Parse ShiyunDesign runtime stderr lines: `[aifront-agent] {"event":...,"data":...}`.
 */

export const STDERR_EVENT_PREFIX = '[aifront-agent] '

/**
 * @param {string} line
 * @returns {{ event: string, data: Record<string, unknown> } | null}
 */
export function parseAgentStderrLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith(STDERR_EVENT_PREFIX)) return null
  try {
    const payload = JSON.parse(trimmed.slice(STDERR_EVENT_PREFIX.length))
    if (!payload || typeof payload.event !== 'string') return null
    const data = payload.data
    return {
      event: payload.event,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
    }
  } catch {
    return null
  }
}

/**
 * @param {(event: { event: string, data: Record<string, unknown> }) => void} onEvent
 * @param {{ forward?: (line: string) => void }} [options]
 */
export function createStderrEventParser(onEvent, options = {}) {
  const forward = options.forward ?? (() => {})
  let buf = ''
  return (chunk) => {
    buf += String(chunk)
    let newline = buf.indexOf('\n')
    while (newline >= 0) {
      const line = buf.slice(0, newline)
      buf = buf.slice(newline + 1)
      newline = buf.indexOf('\n')
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      const event = parseAgentStderrLine(trimmed)
      if (event) onEvent(event)
      else forward(trimmed)
    }
  }
}
