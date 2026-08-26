/**
 * Skills 加载（对标 panda-code/skills + SkillTool）
 * 扫描 .panda/skills/*.md 与 skills/；/reload-plugins 清缓存
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

let _cache = null
let _cacheRoot = ''
let _cacheAt = 0

function clearSkillsCache () {
  _cache = null
  _cacheRoot = ''
  _cacheAt = 0
}

async function loadSkills (projectRoot, opts) {
  const force = !!(opts && opts.force)
  const now = Date.now()
  if (!force && _cache && _cacheRoot === projectRoot && (now - _cacheAt) < 30000) {
    return _cache
  }
  const dirs = [
    path.resolve(projectRoot, '.panda', 'skills'),
    path.resolve(projectRoot, 'skills')
  ]
  const skills = []
  for (const dir of dirs) {
    let entries = []
    try {
      entries = await fsp.readdir(dir)
    } catch (e) {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const full = path.join(dir, name)
      try {
        const text = await fsp.readFile(full, 'utf8')
        const title = (text.match(/^#\s+(.+)$/m) || [, name.replace(/\.md$/, '')])[1]
        skills.push({
          id: name.replace(/\.md$/, ''),
          title: title.trim(),
          path: path.relative(projectRoot, full).split(path.sep).join('/'),
          body: text.slice(0, 8000)
        })
      } catch (e) { /* ignore */ }
    }
  }
  if (!skills.find(s => s.id === 'vue2-style')) {
    skills.push({
      id: 'vue2-style',
      title: 'Vue2 样式修改规范',
      path: '(builtin)',
      body: [
        '# Vue2 样式修改规范',
        '1. 先 read_file 目标 .vue',
        '2. 只用 edit_file 改 <style scoped> 内相关选择器',
        '3. 不要重写 template/script，除非用户明确要求',
        '4. 改完用 diagnostics 或简述视觉变化'
      ].join('\n')
    })
  }
  if (!skills.find(s => s.id === 'safe-edit')) {
    skills.push({
      id: 'safe-edit',
      title: '安全编辑',
      path: '(builtin)',
      body: [
        '# 安全编辑',
        '- edit_file 的 old_string 必须从文件原样复制',
        '- 一次改一处；失败则重新 read',
        '- 写前自动快照，可用 undo_file 回退'
      ].join('\n')
    })
  }
  _cache = skills
  _cacheRoot = projectRoot
  _cacheAt = now
  return skills
}

async function getSkill (projectRoot, skillId) {
  const all = await loadSkills(projectRoot)
  return all.find(s => s.id === skillId || s.title === skillId) || null
}

function skillsPromptBlock (skills) {
  if (!skills || !skills.length) return ''
  return [
    '## 可用 Skills（可用 skill 工具加载全文）',
    ...skills.map(s => `- ${s.id}: ${s.title}`)
  ].join('\n')
}

module.exports = {
  loadSkills,
  getSkill,
  skillsPromptBlock,
  clearSkillsCache
}
