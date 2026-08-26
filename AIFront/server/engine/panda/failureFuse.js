/**
 * 工具失败熔断 + 写码空转熔断
 *
 * 1) 同指纹连续失败 → 硬拒（原有）
 * 2) 同路径反复成功 read（含换 offset 绕过）→ 硬拒（修 TokenUsageScreen 死循环）
 * 3) 同 grep pattern 连空转 → 硬拒
 */

const MAX_SAME_FINGERPRINT = parseInt(process.env.PANDA_TOOL_MAX_RETRIES, 10) || 5
/** 同一路径成功 read 上限（与 offset 无关） */
const MAX_PATH_READS = parseInt(process.env.PANDA_MAX_PATH_READS, 10) || 3
/** 同一指纹成功重复上限 */
const MAX_SAME_SUCCESS = parseInt(process.env.PANDA_TOOL_MAX_REPEAT, 10) || 3

const READ_TOOLS = new Set(['read_file', 'Read'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'Grep', 'Glob', 'diagnostics', 'lsp_diagnostics'])
const REPEAT_GUARD_TOOLS = new Set([].concat(
  Array.from(READ_TOOLS),
  Array.from(SEARCH_TOOLS)
))

function normPath (p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function fingerprint (name, args) {
  args = args || {}
  const p = normPath(args.path || args.file || args.file_path || '')
  const cmd = String(args.command || '').replace(/\s+/g, ' ').slice(0, 160)
  const old = String(args.old_string || (args.edits && args.edits[0] && args.edits[0].old_string) || '').slice(0, 100)
  const pat = String(args.pattern || args.patch || '').slice(0, 80)
  const off = args.offset != null ? String(args.offset) : ''
  const lim = args.limit != null ? String(args.limit) : ''
  return [name, p, cmd, old, pat, off, lim].join('|')
}

function ensure (runtime) {
  if (!runtime.failureFuse) {
    runtime.failureFuse = {
      counts: Object.create(null),
      bannedPaths: [],
      last: null,
      lastSuccessFp: null,
      successStreak: 0,
      pathReads: Object.create(null),
      lastReadPath: null
    }
  }
  if (!runtime.failureFuse.pathReads) runtime.failureFuse.pathReads = Object.create(null)
  return runtime.failureFuse
}

function clearReadLoop (fuse) {
  fuse.lastSuccessFp = null
  fuse.successStreak = 0
  fuse.lastReadPath = null
  // pathReads 在写成功后清对应路径，见 noteSuccess
}

function noteSuccess (runtime, name, args) {
  const fuse = ensure(runtime)
  const fp = fingerprint(name, args)
  delete fuse.counts[fp]
  if (fuse.last && fuse.last.fp === fp) fuse.last = null

  const p = normPath(args && (args.path || args.file || args.file_path))
  const isWrite = /^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(name)

  if (isWrite) {
    clearReadLoop(fuse)
    if (p && fuse.pathReads[p]) delete fuse.pathReads[p]
    runtime.readLoopBlocked = false
    return
  }

  if (READ_TOOLS.has(name) && p) {
    fuse.pathReads[p] = (fuse.pathReads[p] || 0) + 1
    fuse.lastReadPath = p
    if (fuse.lastSuccessFp === fp) {
      fuse.successStreak = (fuse.successStreak || 0) + 1
    } else {
      fuse.lastSuccessFp = fp
      fuse.successStreak = 1
    }
    return
  }

  if (SEARCH_TOOLS.has(name)) {
    if (fuse.lastSuccessFp === fp) {
      fuse.successStreak = (fuse.successStreak || 0) + 1
    } else {
      fuse.lastSuccessFp = fp
      fuse.successStreak = 1
    }
    return
  }

  // 其它工具：打断连读指纹，但保留 pathReads（例如 bash 探测后仍可能再读）
  fuse.lastSuccessFp = null
  fuse.successStreak = 0
}

function noteEmptySearch (runtime, name, args) {
  const fuse = ensure(runtime)
  fuse.emptySearch = (fuse.emptySearch || 0) + 1
  fuse.lastEmpty = {
    name,
    pattern: String((args && (args.pattern || args.path)) || '').slice(0, 120),
    count: fuse.emptySearch,
    at: Date.now()
  }
  return fuse.emptySearch
}

function clearEmptySearch (runtime) {
  const fuse = ensure(runtime)
  fuse.emptySearch = 0
  fuse.lastEmpty = null
}

function emptySearchSuffix (runtime) {
  const n = (runtime && runtime.failureFuse && runtime.failureFuse.emptySearch) || 0
  if (n < 3) return ''
  const last = runtime.failureFuse.lastEmpty
  return [
    '',
    '<lost_agent_nudge>',
    '【迷路纠偏】连续 ' + n + ' 次 ' + ((last && last.name) || 'search') + ' 无匹配。',
    '禁止继续用相同 pattern/目录空转；换关键词、改路径范围，或 Agent(Explore)。',
    last && last.pattern ? '最近空搜：' + last.pattern : '',
    '</lost_agent_nudge>'
  ].filter(Boolean).join('\n')
}

function blockRepeat (name, count, pathHint, reason) {
  return {
    blocked: true,
    count,
    fp: '',
    reason: reason || 'repeat_success',
    content: [
      '<tool_use_error code="repeat_loop">',
      '熔断：写码空转 — ' + name + ' 已成功重复 ' + count + ' 次。',
      pathHint ? '目标：' + pathHint : '',
      '禁止再 read/grep 同一目标（换 offset/limit 也算）。',
      '下一动作必须：edit_file / write_file / apply_patch，或一两句话问用户「具体改什么」。',
      '禁止再输出「先读原始文件确认」。',
      '</tool_use_error>'
    ].filter(Boolean).join('\n')
  }
}

/**
 * @returns {{ blocked: boolean, content?: string, count: number, fp: string, reason?: string }}
 */
function checkBeforeExecute (runtime, name, args) {
  const fuse = ensure(runtime)
  const fp = fingerprint(name, args)
  const failCount = fuse.counts[fp] || 0
  if (failCount >= MAX_SAME_FINGERPRINT) {
    const pathHint = args && (args.path || args.file) ? String(args.path || args.file) : ''
    return {
      blocked: true,
      count: failCount,
      fp,
      reason: 'fail_fuse',
      content: [
        '<tool_use_error code="fuse">',
        '熔断：同一工具调用指纹已连续失败 ' + failCount + ' 次（上限 ' + MAX_SAME_FINGERPRINT + '）。',
        '绝对禁止再次使用相同参数原样重试' + (pathHint ? '（含路径 ' + pathHint + '）' : '') + '。',
        '请：换路径 / 扩大 old_string / Agent(Explore) / 或诚实说明阻塞。',
        '</tool_use_error>'
      ].join('\n')
    }
  }

  const p = normPath(args && (args.path || args.file || args.file_path))

  // 同路径 read：与 offset 无关，累计超限即拒
  if (READ_TOOLS.has(name) && p && (fuse.pathReads[p] || 0) >= MAX_PATH_READS) {
    runtime.readLoopBlocked = true
    return blockRepeat(name, fuse.pathReads[p], p, 'repeat_path_read')
  }

  // 同指纹成功空转（grep/glob/diagnostics）
  if (
    REPEAT_GUARD_TOOLS.has(name) &&
    fuse.lastSuccessFp === fp &&
    (fuse.successStreak || 0) >= MAX_SAME_SUCCESS
  ) {
    runtime.readLoopBlocked = true
    return blockRepeat(name, fuse.successStreak, p || '', 'repeat_success')
  }

  return { blocked: false, count: failCount, fp }
}

function noteFailure (runtime, name, args, errSnippet) {
  const fuse = ensure(runtime)
  const fp = fingerprint(name, args)
  const count = (fuse.counts[fp] || 0) + 1
  fuse.counts[fp] = count
  // 普通失败打断指纹连读；pathReads 保留（失败 edit 后仍可能狂读）
  fuse.lastSuccessFp = null
  fuse.successStreak = 0
  const p = normPath(args && (args.path || args.file))
  if (p && count >= 2 && fuse.bannedPaths.indexOf(p) === -1) {
    fuse.bannedPaths.push(p)
    if (fuse.bannedPaths.length > 20) fuse.bannedPaths.shift()
  }
  fuse.last = {
    fp,
    name,
    path: p,
    count,
    at: Date.now(),
    snippet: String(errSnippet || '').slice(0, 400)
  }
  return { count, fp, path: p }
}

function correctionSuffix (runtime, name, args, note) {
  const count = (note && note.count) || 0
  const p = (note && note.path) || (args && args.path) || ''
  const fuse = ensure(runtime)
  const lines = ['', '<correction_prompt>']
  if (count >= MAX_SAME_FINGERPRINT) {
    lines.push('【熔断】同操作已失败 ' + count + ' 次。禁止原样重试；换策略或说明阻塞。')
  } else if (count >= 2) {
    lines.push('【禁令】绝对禁止再次使用刚才失败的相同参数' + (p ? '（路径/目标：' + p + '）' : '') + '。')
    lines.push('请先判断：命令错了还是路径/匹配串错了？扩大上下文后重试。')
  } else {
    lines.push('工具失败。请根据错误信息修正后重试；不要无视错误盲目再调一次。')
  }
  if (fuse.bannedPaths.length) {
    lines.push('近期失败过的路径（慎用相同参数）：' + fuse.bannedPaths.slice(-5).join(', '))
  }
  lines.push('</correction_prompt>')
  return lines.join('\n')
}

function shouldForceContinue (runtime) {
  const fuse = runtime && runtime.failureFuse
  if (!fuse || !fuse.last) return false
  return fuse.last.count >= 1
}

function continueMessage (runtime) {
  const last = runtime && runtime.failureFuse && runtime.failureFuse.last
  if (!last) return ''
  return [
    '【系统续跑 · 失败熔断】上一工具调用失败（' + last.name + ' ×' + last.count + '）。',
    last.snippet ? String(last.snippet).slice(0, 800) : '',
    '禁止原样重试；换参数/路径或说明阻塞。'
  ].filter(Boolean).join('\n')
}

module.exports = {
  MAX_SAME_FINGERPRINT,
  MAX_SAME_SUCCESS,
  MAX_PATH_READS,
  fingerprint,
  checkBeforeExecute,
  noteFailure,
  noteSuccess,
  noteEmptySearch,
  clearEmptySearch,
  emptySearchSuffix,
  correctionSuffix,
  shouldForceContinue,
  continueMessage,
  normPath
}
