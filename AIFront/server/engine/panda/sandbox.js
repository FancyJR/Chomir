/**
 * OS 级 sandbox 轻量封装（对齐 panda-code sandbox 方向，非完整 Seatbelt 产品）
 * - config.osSandbox / PANDA_OS_SANDBOX=1 开启
 * - darwin：sandbox-exec 只读网络关 + 限制写到项目外（尽力）
 * - linux：可选 bubblewrap（bwrap）若在 PATH
 * - 否则回退：仅 cwd 约束 + 剥离危险 env，仍依赖正则闸
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const os = require('os')

function isOsSandboxEnabled (projectRoot) {
  if (process.env.PANDA_OS_SANDBOX === '0') return false
  if (process.env.PANDA_OS_SANDBOX === '1') return true
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(projectRoot, '.panda', 'config.json'), 'utf8'))
    if (cfg.osSandbox === true || cfg.sandboxMode === 'os') return true
  } catch (e) { /* ignore */ }
  return false
}

function which (bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter)
  for (const d of dirs) {
    const p = path.join(d, bin)
    try {
      if (fs.existsSync(p)) return p
    } catch (e) { /* ignore */ }
  }
  return null
}

/**
 * darwin sandbox-exec profile：允许读全局、写仅 projectRoot + /tmp
 */
function darwinProfile (projectRoot) {
  const root = path.resolve(projectRoot)
  const tmp = os.tmpdir()
  return `
(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow mach*)
(allow file-read*)
(allow file-write* (subpath "${root}"))
(allow file-write* (subpath "${tmp}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/dev"))
(deny network*)
`.trim()
}

/**
 * @returns {{ command: string, shell: boolean, env: object, wrapper?: string } | null}
 * null = 不包装，调用方用普通 spawn
 */
function wrapBashSpawn (command, projectRoot) {
  if (!isOsSandboxEnabled(projectRoot)) return null
  const env = Object.assign({}, process.env)
  // 剥离可被注入的危险变量
  delete env.LD_PRELOAD
  delete env.DYLD_INSERT_LIBRARIES
  delete env.BASH_ENV
  delete env.ENV

  if (process.platform === 'darwin' && which('sandbox-exec')) {
    const profilePath = path.join(os.tmpdir(), 'panda-sb-' + process.pid + '.sb')
    try {
      fs.writeFileSync(profilePath, darwinProfile(projectRoot), 'utf8')
    } catch (e) {
      return { command, shell: true, env, wrapper: 'env-only' }
    }
    // sandbox-exec -f profile -- /bin/bash -lc 'cmd'
    const wrapped = 'sandbox-exec -f ' + JSON.stringify(profilePath) +
      ' -- /bin/bash -lc ' + JSON.stringify(command)
    return { command: wrapped, shell: true, env, wrapper: 'sandbox-exec' }
  }

  if (process.platform === 'linux' && which('bwrap')) {
    const root = path.resolve(projectRoot)
    const wrapped = [
      'bwrap',
      '--ro-bind', '/', '/',
      '--bind', root, root,
      '--bind', os.tmpdir(), os.tmpdir(),
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-net',
      '--chdir', root,
      '--',
      '/bin/bash', '-lc', command
    ].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
    return { command: wrapped, shell: true, env, wrapper: 'bwrap' }
  }

  return { command, shell: true, env, wrapper: 'env-only' }
}

function sandboxStatus (projectRoot) {
  const enabled = isOsSandboxEnabled(projectRoot)
  let backend = 'none'
  if (enabled) {
    if (process.platform === 'darwin' && which('sandbox-exec')) backend = 'sandbox-exec'
    else if (process.platform === 'linux' && which('bwrap')) backend = 'bwrap'
    else backend = 'env-only'
  }
  return { enabled, backend, platform: process.platform }
}

module.exports = {
  isOsSandboxEnabled,
  wrapBashSpawn,
  sandboxStatus
}
