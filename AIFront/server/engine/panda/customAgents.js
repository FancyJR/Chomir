/**
 * 自定义 Agent 定义（.panda/agents/*.md）
 * frontmatter: name, description, tools, permissionMode, model
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function agentsDir (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'agents')
}

function parseFrontmatter (text) {
  const raw = String(text || '')
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: raw }
  const fm = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const meta = {}
  fm.split(/\n/).forEach(line => {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) return
    let v = m[2].trim()
    if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
      try { v = JSON.parse(v) } catch (e) { /* keep string */ }
    } else if (v === 'true') v = true
    else if (v === 'false') v = false
    meta[m[1]] = v
  })
  return { meta, body }
}

async function listCustomAgents (projectRoot) {
  const dir = agentsDir(projectRoot)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    return []
  }
  const out = []
  for (const n of names) {
    if (!/\.md$/i.test(n)) continue
    try {
      const text = await fsp.readFile(path.join(dir, n), 'utf8')
      const { meta, body } = parseFrontmatter(text)
      const id = String(meta.name || n.replace(/\.md$/i, '')).trim()
      out.push({
        id,
        file: n,
        description: meta.description || '',
        tools: meta.tools || null,
        permissionMode: meta.permissionMode || meta.permission_mode || 'bubble',
        model: meta.model || 'inherit',
        prompt: body.trim()
      })
    } catch (e) { /* ignore */ }
  }
  return out
}

async function getCustomAgent (projectRoot, id) {
  const list = await listCustomAgents(projectRoot)
  const needle = String(id || '').toLowerCase()
  return list.find(a => a.id.toLowerCase() === needle) || null
}

module.exports = {
  listCustomAgents,
  getCustomAgent,
  agentsDir,
  parseFrontmatter
}
