/**
 * Bridge ShiyunDesign `panda_todos` stderr events to the parent session Todo UI.
 */

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed'])

/**
 * @typedef {{ content: string, status: 'pending' | 'in_progress' | 'completed' }} DshTodo
 */

/**
 * @param {unknown} raw
 * @returns {DshTodo[] | null}
 */
export function mapPandaTodosToDsh(raw) {
  if (!Array.isArray(raw)) return null
  /** @type {DshTodo[]} */
  const todos = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const content = String(/** @type {{ content?: unknown }} */ (item).content ?? '').trim()
    if (!content || seen.has(content)) continue
    const status = String(/** @type {{ status?: unknown }} */ (item).status ?? 'pending')
    if (!VALID_STATUS.has(status)) continue
    seen.add(content)
    todos.push({ content, status: /** @type {DshTodo['status']} */ (status) })
  }
  return todos
}

/**
 * @param {(raw: unknown) => void} bridge
 * @param {string} taskText
 */
export function seedShiyunDesignTodos(bridge, taskText) {
  const summary = String(taskText || '').trim().replace(/\s+/g, ' ')
  if (!summary) return
  const headline = summary.length > 96 ? `${summary.slice(0, 93)}...` : summary
  bridge([
    { content: `ShiyunDesign：${headline}`, status: 'in_progress' },
    { content: '应用设计系统与 craft 规则', status: 'pending' },
    { content: '产出页面/组件并验证', status: 'pending' },
  ])
}

/**
 * @param {{ append?: (type: string, data: { todos: DshTodo[] }) => void } | null | undefined} parentSession
 */
export function createParentTodoBridge(parentSession) {
  let lastKey = ''
  /** @type {DshTodo[]} */
  let lastSnapshot = []

  return (raw) => {
    const append = parentSession?.append
    if (typeof append !== 'function') return

    let todos = mapPandaTodosToDsh(raw)
    if (todos === null) return

    if (todos.length === 0 && lastSnapshot.length > 0) {
      todos = lastSnapshot.map((item) => ({ ...item, status: 'completed' }))
      lastSnapshot = []
    } else if (todos.length > 0) {
      lastSnapshot = todos
    }

    if (todos.length === 0) return
    const key = JSON.stringify(todos)
    if (key === lastKey) return
    lastKey = key
    append.call(parentSession, 'todo/write', { todos })
  }
}
