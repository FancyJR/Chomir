// 指令市场相关接口封装
// 优先调用后端真实接口（/api/commands），在本地开发或后端未启动时回退到前端 mock。

const API_BASE = '/api/commands'

// 前端 mock 数据源（仅在后端不可用时作为兜底）
let mockCommands = [
  {
    id: 1,
    nameZh: 'AI代码评审',
    nameEn: 'review',
    type: '代码质量',
    tags: ['后端开发', '代码质量', '前端开发'],
    description: 'AI 代码评审指令，用于自动分析代码质量并给出优化建议。',
    status: 'enabled',
    createdBy: '系统',
    createdAt: '2025-06-10',
    subscribeCount: 2,
    subscribed: true
  },
  {
    id: 2,
    nameZh: 'P2代码生成指令',
    nameEn: 'P2_CODE_GENERATION',
    type: '脚本开发',
    tags: ['脚本开发', '前端开发'],
    description: 'P2 项目代码生成指令，根据模板快速生成业务代码骨架。',
    status: 'enabled',
    createdBy: '刘伟',
    createdAt: '2025-05-05',
    subscribeCount: 3,
    subscribed: true
  },
  {
    id: 3,
    nameZh: '检查sql',
    nameEn: 'check_sql',
    type: '数据库操作',
    tags: ['数据库操作', '异常排除'],
    description: '检查 SQL 语句的规范性与执行风险，预防慢查询与潜在错误。',
    status: 'enabled',
    createdBy: '李雷',
    createdAt: '2025-06-05',
    subscribeCount: 3,
    subscribed: true
  },
  {
    id: 4,
    nameZh: '生成单元测试',
    nameEn: 'generate_unit_test',
    type: '单元测试',
    tags: ['单元测试', '多框架', '脚本开发'],
    description: '根据已有代码自动生成 JUnit、Mockito、Spring Test 等多框架单元测试用例。',
    status: 'enabled',
    createdBy: '系统',
    createdAt: '2024-12-11',
    subscribeCount: 6,
    subscribed: true
  }
]

function filterAndPaginateMock (params = {}) {
  const {
    pageNum = 1,
    pageSize = 10,
    type = '',
    keyword = '',
    statusTab = 'all',
    currentUser = 'Admin'
  } = params

  let list = mockCommands.slice()

  if (type) {
    list = list.filter(item => item.type === type)
  }

  if (statusTab === 'mine') {
    list = list.filter(item => item.createdBy === currentUser)
  } else if (statusTab === 'subscribed') {
    list = list.filter(item => item.subscribed)
  } else if (statusTab === 'unsubscribed') {
    list = list.filter(item => !item.subscribed)
  }

  if (keyword) {
    const kw = String(keyword).toLowerCase()
    list = list.filter(item => {
      const zh = item.nameZh ? String(item.nameZh).toLowerCase() : ''
      const en = item.nameEn ? String(item.nameEn).toLowerCase() : ''
      return zh.includes(kw) || en.includes(kw)
    })
  }

  const total = list.length
  const start = (pageNum - 1) * pageSize
  const end = start + pageSize
  const records = list.slice(start, end)

  return { total, records }
}

function createMockCommand (payload = {}) {
  const newId = mockCommands.length ? Math.max.apply(null, mockCommands.map(i => Number(i.id))) + 1 : 1
  const now = new Date()
  const createdAt =
    payload.createdAt ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`

  const command = {
    id: newId,
    status: 'enabled',
    subscribeCount: 0,
    subscribed: false,
    ...payload,
    createdAt
  }

  mockCommands.unshift(command)
  return command
}

function updateMockCommand (id, payload = {}) {
  const index = mockCommands.findIndex(item => String(item.id) === String(id))
  if (index !== -1) {
    mockCommands[index] = {
      ...mockCommands[index],
      ...payload
    }
    return mockCommands[index]
  }
  return null
}

// 列表查询：优先请求后端，失败时回退到前端 mock
export async function fetchCommandList (params = {}) {
  const query = new URLSearchParams()
  const merged = {
    pageNum: params.pageNum,
    pageSize: params.pageSize,
    type: params.type,
    keyword: params.keyword,
    statusTab: params.statusTab,
    currentUser: params.currentUser
  }
  Object.keys(merged).forEach(key => {
    const value = merged[key]
    if (value !== undefined && value !== null && String(value) !== '') {
      query.append(key, String(value))
    }
  })

  const queryString = query.toString()

  try {
    const res = await fetch(queryString ? `${API_BASE}?${queryString}` : API_BASE, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error((data && data.message) || '获取指令列表失败')
    }
    return {
      total: data.total || 0,
      records: Array.isArray(data.records) ? data.records : []
    }
  } catch (e) {
    console.warn('[command] 获取列表失败，使用前端 mock 数据', e && e.message)
    return filterAndPaginateMock(params)
  }
}

// 新增指令
export async function createCommand (payload = {}) {
  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error((data && data.message) || '创建指令失败')
    }
    return data
  } catch (e) {
    console.warn('[command] 创建指令失败，使用前端 mock 数据', e && e.message)
    return createMockCommand(payload)
  }
}

// 更新指令
export async function updateCommand (id, payload = {}) {
  try {
    const safeId = encodeURIComponent(String(id))
    const res = await fetch(`${API_BASE}/${safeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error((data && data.message) || '更新指令失败')
    }
    return data
  } catch (e) {
    console.warn('[command] 更新指令失败，使用前端 mock 数据', e && e.message)
    return updateMockCommand(id, payload)
  }
}

