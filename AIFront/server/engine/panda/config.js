/**
 * Panda 配置读写（对标 panda-code ConfigTool）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULTS = {
  autoApprove: true,
  maxRounds: 40,
  model: 'deepseek-chat',
  yolo: false,
  sandbox: true,
  extraRoots: [],
  language: '简体中文',
  outputStyle: 'default',
  autoMemory: true,
  autoClassifier: true,
  defaultActiveFile: 'src/views/CommandMarket.vue'
}

function configFile (projectRoot) {
  return path.resolve(projectRoot, '.panda', 'config.json')
}

async function loadConfig (projectRoot) {
  try {
    const raw = await fsp.readFile(configFile(projectRoot), 'utf8')
    return Object.assign({}, DEFAULTS, JSON.parse(raw))
  } catch (e) {
    return Object.assign({}, DEFAULTS)
  }
}

async function saveConfig (projectRoot, patch) {
  const cur = await loadConfig(projectRoot)
  const next = Object.assign({}, cur, patch || {})
  await fsp.mkdir(path.resolve(projectRoot, '.panda'), { recursive: true })
  await fsp.writeFile(configFile(projectRoot), JSON.stringify(next, null, 2), 'utf8')
  return next
}

async function getAll (projectRoot) {
  return loadConfig(projectRoot)
}

async function get (projectRoot, key) {
  const cfg = await loadConfig(projectRoot)
  return cfg[key]
}

async function set (projectRoot, key, value) {
  const patch = {}
  let v = value
  if (v === 'true') v = true
  else if (v === 'false') v = false
  else if (/^-?\d+(\.\d+)?$/.test(String(v))) v = Number(v)
  patch[key] = v
  return saveConfig(projectRoot, patch)
}

module.exports = {
  DEFAULTS,
  loadConfig,
  saveConfig,
  getAll,
  get,
  set
}
