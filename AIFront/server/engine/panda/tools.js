/**
 * Panda 风格工具集（移植自 panda-code/tools 的核心能力，适配 Node + DeepSeek）
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')
const { canReadFile, canWriteFile, canRunBash } = require('./permissions')
const { snapshotBeforeWrite, undoLast, unifiedDiff } = require('./fileHistory')
const { getSkill, loadSkills } = require('./skills')
const { runAgent, isVerifyAgentCall } = require('./subagents')
const mcp = require('./mcp')
const worktree = require('./worktree')
const pandaConfig = require('./config')
const { runCoordinator } = require('./coordinator')
const bgTasks = require('./backgroundTasks')
const team = require('./team')
const cron = require('./cron')
const hooks = require('./hooks')
const editMatch = require('./editMatch')
const lsp = require('./lsp')
const swarm = require('./swarm')

const MAX_READ_CHARS = 64000
const MAX_GREP_MATCHES = 40
const MAX_TOOL_RESULT = 16000
const MAX_TOOL_PERSIST = 50000

function truncate (s, max = MAX_TOOL_RESULT) {
  const str = String(s == null ? '' : s)
  if (str.length <= max) return str
  return str.slice(0, max) + `\n…[截断，共 ${str.length} 字符]`
}

function getToolDefinitions (options = {}) {
  const base = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取项目内文件。输出带行号前缀（N|）。编辑前必须先 Read；编辑时 old_string 不要包含行号前缀。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径，如 src/views/CommandMarket.vue' },
            offset: { type: 'integer', description: '起始行（1-based，可选）' },
            limit: { type: 'integer', description: '读取行数（可选）' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '整文件写入。已存在文件必须先 read_file。优先用 edit_file 做局部改动；勿无故新建文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: '精确字符串替换（对标 FileEditTool）。必须先 read_file。old_string 从文件原样复制且勿含行号前缀；不唯一则失败或设 replace_all。可用 edits 数组一次多处修改。禁止用 bash/sed 改文件。定位失败可改用 apply_patch 或 edit_lines。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: '单处编辑时必填' },
            new_string: { type: 'string', description: '单处编辑时必填' },
            replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
            edits: {
              type: 'array',
              description: '多处顺序编辑；若提供则忽略顶层 old/new_string',
              items: {
                type: 'object',
                properties: {
                  old_string: { type: 'string' },
                  new_string: { type: 'string' },
                  replace_all: { type: 'boolean' }
                },
                required: ['old_string', 'new_string']
              }
            }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: '对已读文件应用 unified diff（---/+++/@@ hunk）。适合 edit_file 定位失败或需要多处关联修改时。必须先 read_file。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            patch: { type: 'string', description: 'unified diff 文本，可含多个 @@ hunk' }
          },
          required: ['path', 'patch']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_lines',
        description: '按行号替换区间（含端点）。行号以最近一次 read_file 返回的 N| 为准。必须先 read_file。适合已知起止行的精确改码。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            start_line: { type: 'integer', description: '起始行（1-based，含）' },
            end_line: { type: 'integer', description: '结束行（1-based，含）' },
            new_content: { type: 'string', description: '替换后的内容（可多行，勿含行号前缀）' }
          },
          required: ['path', 'start_line', 'end_line', 'new_content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: '按 glob 模式查找文件，如 **/*.vue、src/api/*.js',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            cwd: { type: 'string', description: '相对搜索根，默认项目根' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: '在项目中正则搜索代码内容，返回匹配行。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: '限定目录或文件，默认整个项目' },
            glob: { type: 'string', description: '文件过滤，如 *.vue' },
            case_insensitive: { type: 'boolean' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: '在项目根目录执行 shell 命令（有危险命令拦截）。用于跑测试、看 git status、构建等。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'integer', description: '超时毫秒，默认 30000' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取公开 URL 文本内容（用于查文档）。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'todo_write',
        description: 'Break multi-step work into a todo list. Use when the user request needs ≥3 steps, touches multiple files, or lists several asks. Skip for trivial one-file edits. Keep exactly one in_progress; mark completed immediately when a step is done (do not batch).',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
                },
                required: ['id', 'content', 'status']
              }
            }
          },
          required: ['todos']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Ask clarifying questions only when the user\'s real goal is still ambiguous AFTER you tried to interpret colloquial/incomplete Chinese as an engineering task and investigated with glob/grep/read/explore. Do NOT ask as the first reaction to friction or vague wording — infer intent from project context first. Prefer enter_plan_mode when the ambiguity is about approach/architecture.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '可选的候选答案'
            }
          },
          required: ['question']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'enter_plan_mode',
        description: 'Enter Plan Mode when the approach is unclear or the change is large: explore/read only, no business edits until exit_plan_mode. Prefer this over ask_user when you need to research then present a plan.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exit_plan_mode',
        description: '退出 Plan Mode，提交计划摘要后允许开始改代码。',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: '计划摘要' }
          },
          required: ['plan']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_read',
        description: '读取长期记忆。不传 topic 返回 MEMORY.md 索引；传 topic（如 general/auto/preferences）返回 `.panda/memory/topics/<topic>.md` 详情。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '主题 id；空则读索引' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_append',
        description: '向长期记忆追加一条。可指定 topic（默认 general），并刷新 MEMORY.md 索引。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string' },
            topic: { type: 'string', description: '主题 id，默认 general' }
          },
          required: ['note']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'Agent',
        description:
          '统一子代理（对齐 panda-code AgentTool）。用 subagent_type 选择：' +
          'Explore=只读广搜映射文件；Plan=深度只读探索后出实施计划+Critical Files；' +
          'Verify=对抗式实测验收（须 Command run 证据）；' +
          'shiyundesign=OpenDesign 设计交付（HTML/CSS/原型，自动打开预览）；' +
          'fork/general/implementer=继承上下文的 sidechain。' +
          '简单单关键词搜索请直接 glob/grep，不要滥用 Explore。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '交给子代理的完整说明（目标、已尝试、约束）；Verify 时用原始用户目标'
            },
            subagent_type: {
              type: 'string',
              description: 'Explore | Plan | Verify | shiyundesign | fork | general | implementer',
              enum: ['Explore', 'Plan', 'Verify', 'explore', 'plan', 'verify', 'shiyundesign', 'design', 'fork', 'general', 'implementer']
            },
            thoroughness: {
              type: 'string',
              enum: ['quick', 'medium', 'very_thorough'],
              description: '仅 Explore：搜索深度，默认 medium'
            },
            model: { type: 'string', description: 'inherit 或具体模型（fork 类）' }
          },
          required: ['prompt', 'subagent_type']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_explore',
        description: '[别名] 等价于 Agent(subagent_type=Explore)。优先用统一 Agent 工具。',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            thoroughness: { type: 'string', enum: ['quick', 'medium', 'very_thorough'] }
          },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_plan',
        description: '[别名] 等价于 Agent(subagent_type=Plan)。优先用统一 Agent 工具。',
        parameters: {
          type: 'object',
          properties: { goal: { type: 'string' } },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_verify',
        description: '[别名] 等价于 Agent(subagent_type=Verify)。优先用统一 Agent 工具。',
        parameters: {
          type: 'object',
          properties: { goal: { type: 'string' } },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_list',
        description: '列出当前会话任务。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_create',
        description: '创建一条任务。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_update',
        description: '更新任务状态或内容。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_get',
        description: '按 id 获取单条任务详情（对齐 TaskGet）。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id' },
            taskId: { type: 'string', description: '同 id' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'notebook_edit',
        description: '编辑 Jupyter .ipynb：按 cell_id/索引 replace、insert、delete。不要用 edit_file 直接改 notebook。',
        parameters: {
          type: 'object',
          properties: {
            notebook_path: { type: 'string' },
            cell_id: { type: 'string', description: 'cell id 或数字索引' },
            new_source: { type: 'string' },
            cell_type: { type: 'string', enum: ['code', 'markdown'] },
            edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] }
          },
          required: ['notebook_path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '在网上搜索技术资料（DuckDuckGo 即时摘要）。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'diagnostics',
        description: '对项目或指定文件做轻量诊断（尝试 vue/js 语法检查或 npm run build 摘要）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '可选，限定文件' },
            build: { type: 'boolean', description: '是否跑 npm run build，默认 false' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_console',
        description: '读取浏览器自动上报的控制台/运行时错误（Vue error、window.onerror、unhandledrejection、console.error）。排查页面报错时必须先调用本工具，再结合堆栈 read_file 定位修复。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数，默认 40' },
            level: { type: 'string', description: 'error | warn | all，默认 error' },
            query: { type: 'string', description: '按关键词过滤 message/stack/url' },
            clear: { type: 'boolean', description: '读取后是否清空缓存，默认 false' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'capture_page',
        description: 'Screenshot a localhost page (Playwright/Chrome). REQUIRED before major UI/美化 if user did not paste a screenshot. Only localhost. After capture: multimodal inject if API supports vision; otherwise path-only text inject (no deepseek-vl2).',
        parameters: {
          type: 'object',
          properties: {
            route: { type: 'string', description: 'App route e.g. /command-market /orchestration (default /)' },
            url: { type: 'string', description: 'Full localhost URL (optional; overrides route)' },
            fullPage: { type: 'boolean', description: 'Full page screenshot, default true' },
            width: { type: 'number' },
            height: { type: 'number' },
            wait_ms: { type: 'number', description: 'Extra wait after load, ms' },
            click: { type: 'string', description: 'CSS selector to click before screenshot' },
            type_selector: { type: 'string', description: 'CSS selector to type into' },
            type_text: { type: 'string', description: 'Text for type_selector' },
            actions: {
              type: 'array',
              description: 'Ordered interactions: {type:click|type|press|wait|waitfor, selector?, text?, key?, ms?}',
              items: { type: 'object' }
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'skill',
        description: '加载某个 Skill 的完整说明并遵循它。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'tool_search',
        description: '按关键词搜索可用工具名。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'undo_file',
        description: '回退某个文件最近一次由 Agent 写入的改动。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'sleep',
        description: '短暂等待（毫秒），用于等待外部进程。',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'integer' } },
          required: ['ms']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp_connect',
        description: '手动连接 .panda/mcp.json 中的 MCP server（通常开局已 autoConnect；连上后工具会以 mcp__server__tool 自动挂载）。',
        parameters: {
          type: 'object',
          properties: { server: { type: 'string' } },
          required: ['server']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp_list',
        description: '列出已配置/已连接 MCP server，以及自动挂载的 mcp__* 工具名。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp_call',
        description: '[兼容] 调用 MCP 工具。优先直接调用已挂载的 mcp__server__tool。',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            tool: { type: 'string' },
            arguments: { type: 'object' }
          },
          required: ['server', 'tool']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp_resources',
        description: '列出 MCP server 资源。',
        parameters: {
          type: 'object',
          properties: { server: { type: 'string' } },
          required: ['server']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mcp_read_resource',
        description: '读取 MCP 资源内容。',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            uri: { type: 'string' }
          },
          required: ['server', 'uri']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'enter_worktree',
        description: '创建并进入隔离 git worktree，后续改动落在隔离目录。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exit_worktree',
        description: '退出隔离 worktree，默认删除该 worktree。',
        parameters: {
          type: 'object',
          properties: { remove: { type: 'boolean' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'config_get',
        description: '读取 Panda 配置（.panda/config.json）。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'config_set',
        description: '更新 Panda 配置项。',
        parameters: {
          type: 'object',
          properties: {
            patch: { type: 'object', description: '要合并的配置字段' }
          },
          required: ['patch']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'brief',
        description: '向用户输出简短状态摘要（当前模式、worktree、改动文件、todos）。',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'coordinator',
        description: '并行运行 Explore+Plan（及可选 Verify）子代理并汇总行动指令。',
        parameters: {
          type: 'object',
          properties: { goal: { type: 'string' } },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bash_bg',
        description: '后台启动 shell 命令，立即返回 task id，可用 task_output/task_stop 管理。',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_output',
        description: '读取后台任务输出。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tail: { type: 'integer' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_stop',
        description: '停止后台任务。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'task_bg_list',
        description: '列出后台 shell 任务。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_create',
        description: '创建协作 Team（成员默认 explorer/planner/implementer）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            members: { type: 'array', items: { type: 'string' } }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_delete',
        description: '删除 Team。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_list',
        description: '列出 Team。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: '向 Team 成员收件箱发消息。',
        parameters: {
          type: 'object',
          properties: {
            team: { type: 'string' },
            to: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['team', 'to', 'message']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_run_member',
        description: '让 Team 某成员根据目标/收件箱产出结果。',
        parameters: {
          type: 'object',
          properties: {
            team: { type: 'string' },
            member: { type: 'string' },
            goal: { type: 'string' }
          },
          required: ['team', 'member', 'goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cron_create',
        description: '创建定时提醒/任务（every 如 5m/1h，或 runAt ISO）。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            every: { type: 'string' },
            runAt: { type: 'string' },
            id: { type: 'string' }
          },
          required: ['prompt']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cron_list',
        description: '列出定时任务。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cron_delete',
        description: '删除定时任务。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cron_tick',
        description: '检查并返回到期的定时任务（更新下次执行时间）。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'repl',
        description: '在受限沙箱中对表达式求值（禁止 require/process/fs，仅用于小计算）。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'lsp_diagnostics',
        description: '对文件运行 LSP 诊断（常驻 Language Server 的 publishDiagnostics；未配置 server 时回退内置启发式）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'lsp_query',
        description: 'LSP 导航（省 token）：definition / references / hover / documentSymbol / workspaceSymbol。需 .panda/lsp.json。line/character 为 1-based。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'definition | references | hover | documentSymbol | workspaceSymbol'
            },
            path: { type: 'string', description: '文件路径（workspaceSymbol 可省略）' },
            line: { type: 'integer', description: '1-based 行号' },
            character: { type: 'integer', description: '1-based 列号' },
            query: { type: 'string', description: 'workspaceSymbol 搜索词' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'swarm_run',
        description: '启动 Swarm：并行多个 worker 后由 Queen 汇总行动指令。',
        parameters: {
          type: 'object',
          properties: { goal: { type: 'string' } },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'swarm_list',
        description: '列出近期 Swarm。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'swarm_get',
        description: '查看某个 Swarm 详情。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_fork',
        description: 'Fork 子 Agent：继承父对话 sidechain、readFileState、权限闸门（bubble）与模型。type=explore|plan|verify|fork|implementer。禁止递归 fork。',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            type: { type: 'string', description: 'explore|plan|verify|fork|general|implementer' },
            permission_mode: { type: 'string', description: 'bubble|plan|acceptEdits' },
            model: { type: 'string', description: 'inherit 或具体模型名' },
            writable: { type: 'boolean' }
          },
          required: ['goal']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_resume',
        description: '继续某个已存在的 Fork Agent。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            follow_up: { type: 'string' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_list',
        description: '列出本进程内的 Fork Agent。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'verify_plan',
        description: 'VerifyPlanExecution：对照最近批准的计划检查改动/todos/证据是否落实。计划执行后应调用；PASS/PARTIAL/FAIL。',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: '可选：覆盖 runtime.lastPlan' },
            notes: { type: 'string', description: '自检说明' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'powershell',
        description: '在 Windows/已安装 pwsh 的环境执行 PowerShell。macOS 若无 pwsh 会返回明确错误。权限与 bash 同闸。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'number' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_perm_list',
        description: '列出 Team 待批准的权限请求（Swarm/Team 权限轮询）。',
        parameters: {
          type: 'object',
          properties: { team_id: { type: 'string' } },
          required: ['team_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'team_perm_resolve',
        description: '批准或拒绝一条 Team 权限请求。',
        parameters: {
          type: 'object',
          properties: {
            team_id: { type: 'string' },
            id: { type: 'string' },
            allow: { type: 'boolean' },
            reason: { type: 'string' }
          },
          required: ['team_id', 'id', 'allow']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'custom_agents',
        description: '列出 .panda/agents/*.md 自定义 Agent 定义。',
        parameters: { type: 'object', properties: {} }
      }
    }
  ]
  const mcpExtra = Array.isArray(options.mcpTools) ? options.mcpTools : []
  // 已挂载的 mcp__* 优先；管理类 mcp_* 仍保留
  return base.concat(mcpExtra)
}

function walkFiles (dir, relativeBase, out, maxFiles = 2000) {
  if (out.length >= maxFiles) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) return
    const name = ent.name
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'panda-code' || name === '.npm-cache') continue
    const abs = path.join(dir, name)
    const rel = path.join(relativeBase, name).split(path.sep).join('/')
    if (ent.isDirectory()) {
      walkFiles(abs, rel, out, maxFiles)
    } else if (ent.isFile()) {
      out.push(rel)
    }
  }
}

function matchGlob (relPath, pattern) {
  // 极简 glob：** / * 
  let re = '^'
  const p = String(pattern || '').replace(/\\/g, '/')
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      re += '.*'
      i++
      if (p[i + 1] === '/') i++
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^$()[]{}|'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  try {
    return new RegExp(re).test(relPath.replace(/\\/g, '/'))
  } catch (e) {
    return false
  }
}

async function runBash (command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ ok: false, stdout: '', stderr: '[aborted]', code: -1 })
      return
    }
    let spawnCmd = command
    let spawnOpts = { cwd, shell: true, env: process.env }
    try {
      const wrapped = require('./sandbox').wrapBashSpawn(command, cwd)
      if (wrapped) {
        spawnCmd = wrapped.command
        spawnOpts = { cwd, shell: wrapped.shell !== false, env: wrapped.env || process.env }
      }
    } catch (e) { /* ignore sandbox wrap errors */ }
    const child = spawn(spawnCmd, spawnOpts)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      try { child.kill('SIGTERM') } catch (e) { /* ignore */ }
      finish({ ok: false, stdout, stderr: stderr + '\n[aborted]', code: -1 })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: -1 })
    }, timeoutMs || 30000)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, code })
    })
    child.on('error', (err) => {
      finish({ ok: false, stdout, stderr: err.message, code: -1 })
    })
  })
}

/**
 * @param {string} name
 * @param {object} args
 * @param {object} runtime - { projectRoot, mode, todos, sessionId, memory, onAskUser, exploreFn }
 */

function ensureReadableForWrite (runtime, absPath, diskContent) {
  const editMatch = require('./editMatch')
  // 对标 FileEditTool：未 Read 直接失败，禁止静默补读
  return editMatch.assertReadableForWrite(runtime, absPath, editMatch.toLF(diskContent))
}

async function executeTool (name, args, runtime) {
  const projectRoot = runtime.projectRoot
  const mode = runtime.mode || 'default'
  args = args || {}

  try {
    // Schema 监狱：落盘/执行前硬校验（对标 Zod + validateInput）
    const schemaFail = require('./toolValidate').validateToolInput(name, args)
    if (schemaFail) return schemaFail

    // 失败熔断：同指纹达上限则硬拒（不写盘、不跑命令）
    const fuse = require('./failureFuse')
    const blocked = fuse.checkBeforeExecute(runtime, name, args)
    if (blocked.blocked) {
      if (runtime.sendEvent && (blocked.reason === 'repeat_success' || blocked.reason === 'repeat_path_read')) {
        runtime.sendEvent('panda_block', {
          type: 'system',
          content: '熔断 · 写码空转 ' + name + ' ×' + blocked.count + '（禁止再读，请改代码）'
        })
      }
      return {
        ok: false,
        content: blocked.content,
        meta: { fuseBlocked: true, count: blocked.count, reason: blocked.reason || 'fuse' }
      }
    }

    const pre = await hooks.runPreToolHooks(projectRoot, name, args, runtime)
    const preNotes = (pre && pre.notes) || (Array.isArray(pre) ? pre : [])
    if (preNotes && preNotes.length && runtime.sendEvent) {
      runtime.sendEvent('panda_block', { type: 'system', content: 'Hook: ' + preNotes.join(' | ') })
    }
    if (pre && pre.deny) {
      return { ok: false, content: pre.denyMessage || 'Hook 拒绝了该工具' }
    }
    runtime._lastToolArgs = args

    // 规则引擎：deny 在 YOLO 下也拦截（ask/allow 由 requirePermission 处理）
    try {
      const permissionRules = require('./permissionRules')
      const risk = (name === 'bash' || name === 'bash_bg' || name === 'powershell')
        ? 'bash'
        : (/^(read_file|glob|grep|task_get|task_list|memory_read|capture_page|browser_console)$/.test(name) ? 'read' : 'write')
      const ev = await permissionRules.evaluatePermission({
        projectRoot,
        tool: name,
        args,
        risk,
        permissionMode: runtime.permissionMode || (mode === 'plan' || mode === 'verify' ? mode : 'acceptEdits'),
        sessionAllow: runtime.sessionAllowRules || [],
        sessionDeny: runtime.sessionDenyRules || [],
        sessionId: runtime.sessionId || '',
        messages: runtime.sidechainMessages || runtime.messages || []
      })
      if (ev.behavior === 'deny') {
        try {
          const hooks = require('./hooks')
          const dn = await hooks.runPermissionDeniedHooks(projectRoot, name, args, ev, runtime)
          if (dn && dn.notes && dn.notes.length && runtime.sendEvent) {
            runtime.sendEvent('panda_block', {
              type: 'system',
              content: 'Hook(PermissionDenied): ' + dn.notes.join(' | ')
            })
          }
        } catch (e) { /* ignore */ }
        return { ok: false, content: '权限拒绝：' + (ev.reason || name) }
      }
      // ask：有 UI 闸门则交给 requirePermission；无闸门且 forceAsk → 拒；无 forceAsk 的 ask 也不得静默放行写/bash
      if (ev.behavior === 'ask') {
        if (runtime.requirePermission) {
          // 写/bash 工具自身还会再调 requirePermission；此处仅拦「不会再问」的工具
          const willAskAgain = name === 'bash' || name === 'bash_bg' || name === 'powershell' ||
            /^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(name) ||
            name === 'exit_plan_mode'
          if (!willAskAgain) {
            const allowed = await runtime.requirePermission({
              tool: name,
              detail: String((args && (args.path || args.command || args.url)) || name).slice(0, 160),
              risk,
              args,
              forceAsk: !!ev.forceAsk,
              reason: ev.reason,
              suggestions: ev.suggestions || []
            })
            if (!allowed) return { ok: false, content: '用户拒绝了操作：' + name }
          }
        } else if (ev.forceAsk || risk === 'bash' || risk === 'write') {
          return { ok: false, content: '权限需确认（无 UI 闸门）：' + (ev.reason || name) }
        }
      }
    } catch (e) {
      // 规则引擎异常：写/bash 失败关闭，避免 YOLO 绕过 deny
      const risky = name === 'bash' || name === 'bash_bg' ||
        /^(write_file|edit_file|edit_lines|apply_patch|notebook_edit)$/.test(name)
      if (risky) {
        return { ok: false, content: '权限规则引擎异常，已拒绝危险操作：' + (e.message || e) }
      }
      console.warn('[panda] evaluatePermission error (non-risky continue):', e.message || e)
    }

    if (name === 'read_file') {
      const gate = canReadFile(projectRoot, args.path)
      if (!gate.ok) {
        const sim = editMatch.findSimilarFile(projectRoot, args.path || '')
        const hint = sim.length ? ('\n相似路径：' + sim.join(', ')) : ''
        return { ok: false, content: gate.reason + hint }
      }
      if (!fs.existsSync(gate.target)) {
        const sim = editMatch.findSimilarFile(projectRoot, gate.rel)
        const hint = sim.length ? ('\n你是否想读：' + sim.join(', ')) : ''
        return { ok: false, content: '文件不存在：' + gate.rel + hint }
      }
      let raw = await fsp.readFile(gate.target, 'utf8')
      // tool-results 落盘文件可能残留叠层行号；先剥干净再编号，避免 1|1|1|…
      const isToolResultDump = /(^|\/)\.panda\/tool-results\//.test(gate.rel.replace(/\\/g, '/'))
      if (isToolResultDump || /^\s*\d+\|\s*\d+\|/.test(raw.slice(0, 200))) {
        raw = editMatch.stripLineNumberPrefix(raw)
      }
      const hasOffset = args.offset != null && args.offset !== ''
      const hasLimit = args.limit != null && args.limit !== ''
      let lines = raw.split(/\n/)
      const offset = hasOffset ? Math.max(1, parseInt(args.offset, 10) || 1) : 1
      const limit = hasLimit ? (parseInt(args.limit, 10) || lines.length) : lines.length
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      let text = slice.map((l, i) => `${offset + i}|${l}`).join('\n')
      if (text.length > MAX_READ_CHARS) text = text.slice(0, MAX_READ_CHARS) + '\n…[截断]'
      editMatch.rememberRead(runtime, gate.target, raw, {
        offset: hasOffset ? offset : undefined,
        limit: hasLimit ? limit : undefined
      })
      return { ok: true, content: text, meta: { file: gate.rel } }
    }

    if (name === 'write_file') {
      const gate = canWriteFile(projectRoot, args.path, mode)
      if (!gate.ok) return { ok: false, content: gate.reason }
      if (String(gate.rel || '').endsWith('.ipynb')) {
        return { ok: false, content: '请勿用 write_file 直接改 .ipynb；请用 notebook_edit。' }
      }
      const bal = require('./toolValidate').validateWrittenContentBalance(gate.rel, args.content)
      if (bal) return bal
      await fsp.mkdir(path.dirname(gate.target), { recursive: true })
      const exists = fs.existsSync(gate.target)
      let before = ''
      let eol = '\n'
      if (exists) {
        before = await fsp.readFile(gate.target, 'utf8')
        eol = editMatch.detectEOL(before)
        const check = ensureReadableForWrite(runtime, gate.target, before)
        if (!check.ok) return { ok: false, content: check.message }
      }
      // 新建文件不要求 read；已存在必须 read
      let after = String(args.content == null ? '' : args.content)
      after = editMatch.applyEOL(editMatch.toLF(after), eol)
      const diff = unifiedDiff(gate.rel, before, after)
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'write_file',
          detail: gate.rel,
          risk: 'write',
          diff,
          preview: after.slice(0, 2400)
        })
        if (!allowed) return { ok: false, content: '用户拒绝了写入权限' }
      }
      await snapshotBeforeWrite(projectRoot, gate.rel, before)
      try { if (exists) await fsp.copyFile(gate.target, gate.target + '.bak') } catch (e) { /* ignore */ }
      await fsp.writeFile(gate.target, after, 'utf8')
      editMatch.rememberWrite(runtime, gate.target, after)
      try { void lsp.syncAfterWrite(projectRoot, gate.rel, after) } catch (e) { /* ignore */ }
      return {
        ok: true,
        content: `已写入 ${gate.rel}\n\n${diff}`,
        meta: { file: gate.rel, changed: true, diff }
      }
    }

    if (name === 'edit_file') {
      const gate = canWriteFile(projectRoot, args.path, mode)
      if (!gate.ok) {
        const sim = editMatch.findSimilarFile(projectRoot, args.path || '')
        const hint = sim.length ? ('\n相似路径：' + sim.join(', ')) : ''
        return { ok: false, content: gate.reason + hint }
      }
      if (String(gate.rel || '').endsWith('.ipynb')) {
        return { ok: false, content: '.ipynb 请用 notebook_edit（replace/insert/delete cell），不要用 edit_file 改 JSON。' }
      }
      if (!fs.existsSync(gate.target)) {
        const sim = editMatch.findSimilarFile(projectRoot, gate.rel)
        const hint = sim.length ? ('\n相似路径：' + sim.join(', ')) : ''
        return { ok: false, content: '文件不存在：' + gate.rel + hint }
      }
      const raw = await fsp.readFile(gate.target, 'utf8')
      const eol = editMatch.detectEOL(raw)
      const lf = editMatch.toLF(raw)
      const check = ensureReadableForWrite(runtime, gate.target, raw)
      if (!check.ok) return { ok: false, content: check.message }

      let edits = Array.isArray(args.edits) && args.edits.length
        ? args.edits
        : [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }]

      // 剥行号前缀误带
      edits = edits.map(e => ({
        old_string: editMatch.stripLineNumberPrefix(String(e.old_string == null ? '' : e.old_string)),
        new_string: editMatch.stripLineNumberPrefix(String(e.new_string == null ? '' : e.new_string)),
        replace_all: !!e.replace_all
      }))

      if (!edits.length || (edits.length === 1 && edits[0].old_string == null && args.old_string == null && !args.edits)) {
        return { ok: false, content: '需要 old_string/new_string，或提供 edits 数组。' }
      }

      const applied = editMatch.applyEditsLF(lf, gate.rel, edits)
      if (!applied.ok) return { ok: false, content: applied.message }

      const next = editMatch.applyEOL(applied.content, eol)
      if (next === raw) return { ok: false, content: '编辑未改变文件内容。' }
      const diff = unifiedDiff(gate.rel, raw, next)

      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'edit_file',
          detail: gate.rel,
          risk: 'write',
          diff,
          preview: String((edits[0] && edits[0].new_string) || '').slice(0, 1200)
        })
        if (!allowed) return { ok: false, content: '用户拒绝了编辑权限' }
      }

      // 写前再次检查新鲜度
      const raw2 = await fsp.readFile(gate.target, 'utf8')
      if (editMatch.toLF(raw2) !== lf) {
        return { ok: false, content: 'File has been modified since read. Read it again before attempting to write it.' }
      }

      await snapshotBeforeWrite(projectRoot, gate.rel, raw)
      try { await fsp.copyFile(gate.target, gate.target + '.bak') } catch (e) { /* ignore */ }
      await fsp.writeFile(gate.target, next, 'utf8')
      editMatch.rememberWrite(runtime, gate.target, next)
      try { void lsp.syncAfterWrite(projectRoot, gate.rel, next) } catch (e) { /* ignore */ }
      return {
        ok: true,
        content: `已编辑 ${gate.rel}（${applied.count || edits.length} 处）\n\n${diff}`,
        meta: { file: gate.rel, changed: true, diff, edits: edits.length }
      }
    }

    if (name === 'apply_patch') {
      const applyPatch = require('./applyPatch')
      const gate = canWriteFile(projectRoot, args.path, mode)
      if (!gate.ok) {
        const sim = editMatch.findSimilarFile(projectRoot, args.path || '')
        const hint = sim.length ? ('\n相似路径：' + sim.join(', ')) : ''
        return { ok: false, content: gate.reason + hint }
      }
      if (!fs.existsSync(gate.target)) {
        return { ok: false, content: '文件不存在：' + gate.rel }
      }
      const raw = await fsp.readFile(gate.target, 'utf8')
      const eol = editMatch.detectEOL(raw)
      const lf = editMatch.toLF(raw)
      const check = ensureReadableForWrite(runtime, gate.target, raw)
      if (!check.ok) return { ok: false, content: check.message }
      const patched = applyPatch.applyUnifiedDiff(lf, args.patch || '')
      if (!patched.ok) return { ok: false, content: patched.message || 'patch 失败' }
      const next = editMatch.applyEOL(patched.content, eol)
      if (next === raw) return { ok: false, content: 'patch 未改变文件内容。' }
      const diff = unifiedDiff(gate.rel, raw, next)
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'apply_patch',
          detail: gate.rel,
          risk: 'write',
          diff,
          preview: String(args.patch || '').slice(0, 1200)
        })
        if (!allowed) return { ok: false, content: '用户拒绝了编辑权限' }
      }
      const raw2 = await fsp.readFile(gate.target, 'utf8')
      if (editMatch.toLF(raw2) !== lf) {
        return { ok: false, content: 'File has been modified since read. Read it again before attempting to write it.' }
      }
      await snapshotBeforeWrite(projectRoot, gate.rel, raw)
      try { await fsp.copyFile(gate.target, gate.target + '.bak') } catch (e) { /* ignore */ }
      await fsp.writeFile(gate.target, next, 'utf8')
      editMatch.rememberWrite(runtime, gate.target, next)
      try { void lsp.syncAfterWrite(projectRoot, gate.rel, next) } catch (e) { /* ignore */ }
      return {
        ok: true,
        content: `已应用 patch ${gate.rel}\n\n${diff}`,
        meta: { file: gate.rel, changed: true, diff }
      }
    }

    if (name === 'edit_lines') {
      const applyPatch = require('./applyPatch')
      const gate = canWriteFile(projectRoot, args.path, mode)
      if (!gate.ok) {
        const sim = editMatch.findSimilarFile(projectRoot, args.path || '')
        const hint = sim.length ? ('\n相似路径：' + sim.join(', ')) : ''
        return { ok: false, content: gate.reason + hint }
      }
      if (!fs.existsSync(gate.target)) {
        return { ok: false, content: '文件不存在：' + gate.rel }
      }
      const raw = await fsp.readFile(gate.target, 'utf8')
      const eol = editMatch.detectEOL(raw)
      const lf = editMatch.toLF(raw)
      const check = ensureReadableForWrite(runtime, gate.target, raw)
      if (!check.ok) return { ok: false, content: check.message }
      const newContent = editMatch.stripLineNumberPrefix(String(args.new_content == null ? '' : args.new_content))
      const replaced = applyPatch.replaceLines(lf, args.start_line, args.end_line, newContent)
      if (!replaced.ok) return { ok: false, content: replaced.message || 'edit_lines 失败' }
      const next = editMatch.applyEOL(replaced.content, eol)
      if (next === raw) return { ok: false, content: '编辑未改变文件内容。' }
      const diff = unifiedDiff(gate.rel, raw, next)
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'edit_lines',
          detail: gate.rel + ' L' + args.start_line + '-' + args.end_line,
          risk: 'write',
          diff,
          preview: newContent.slice(0, 1200)
        })
        if (!allowed) return { ok: false, content: '用户拒绝了编辑权限' }
      }
      const raw2 = await fsp.readFile(gate.target, 'utf8')
      if (editMatch.toLF(raw2) !== lf) {
        return { ok: false, content: 'File has been modified since read. Read it again before attempting to write it.' }
      }
      await snapshotBeforeWrite(projectRoot, gate.rel, raw)
      try { await fsp.copyFile(gate.target, gate.target + '.bak') } catch (e) { /* ignore */ }
      await fsp.writeFile(gate.target, next, 'utf8')
      editMatch.rememberWrite(runtime, gate.target, next)
      try { void lsp.syncAfterWrite(projectRoot, gate.rel, next) } catch (e) { /* ignore */ }
      return {
        ok: true,
        content: `已按行编辑 ${gate.rel}（L${args.start_line}-${args.end_line}，替换 ${replaced.replaced} 行）\n\n${diff}`,
        meta: { file: gate.rel, changed: true, diff }
      }
    }

    if (name === 'glob') {
      const all = []
      const cwdRel = (args.cwd || '').replace(/^\/+/, '')
      const baseAbs = cwdRel ? path.resolve(projectRoot, cwdRel) : projectRoot
      walkFiles(baseAbs, cwdRel || '', all)
      const hits = all.filter(f => matchGlob(f, args.pattern)).slice(0, 200)
      return { ok: true, content: hits.length ? hits.join('\n') : '(无匹配)' }
    }

    if (name === 'grep') {
      const all = []
      const searchRootRel = (args.path || '').replace(/^\/+/, '')
      const baseAbs = searchRootRel ? path.resolve(projectRoot, searchRootRel) : projectRoot
      const gate = canReadFile(projectRoot, searchRootRel || '.')
      if (!gate.ok && searchRootRel) return { ok: false, content: gate.reason }
      if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isFile()) {
        all.push(searchRootRel)
      } else {
        walkFiles(baseAbs, searchRootRel || '', all)
      }
      let re
      try {
        re = new RegExp(args.pattern, args.case_insensitive ? 'i' : '')
      } catch (e) {
        return { ok: false, content: '非法正则：' + e.message }
      }
      const matches = []
      for (const rel of all) {
        if (args.glob && !matchGlob(path.basename(rel), args.glob) && !matchGlob(rel, args.glob)) continue
        if (!/\.(js|vue|ts|tsx|json|css|md|html|yml|yaml)$/i.test(rel)) continue
        let text = ''
        try {
          text = fs.readFileSync(path.resolve(projectRoot, rel), 'utf8')
        } catch (e) {
          continue
        }
        const lines = text.split(/\n/)
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`)
            if (matches.length >= MAX_GREP_MATCHES) break
          }
        }
        if (matches.length >= MAX_GREP_MATCHES) break
      }
      return { ok: true, content: matches.length ? matches.join('\n') : '(无匹配)' }
    }


    if (name === 'bash') {
      const gate = canRunBash(args.command, mode, projectRoot)
      if (!gate.ok) return { ok: false, content: gate.reason }
      const cmd = String(args.command || '')
      // 禁止用 shell 改业务源码（对标 panda-code：用 Edit/Write 专用工具）
      if (/\b(sed|perl|ruby|python3?)\b.*\s(-i|in-place)/i.test(cmd) ||
          />\s*src\/|>\s*server\/|tee\s+src\//i.test(cmd)) {
        return {
          ok: false,
          content: '请使用 edit_file / apply_patch / edit_lines / write_file 修改源码，不要用 bash/sed 重定向改业务文件。'
        }
      }
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'bash',
          detail: cmd.slice(0, 120),
          risk: 'bash'
        })
        if (!allowed) return { ok: false, content: '用户拒绝了终端命令' }
      }
      const result = await runBash(args.command, projectRoot, args.timeout_ms || 30000, runtime.signal)
      // grep/rg 无匹配常为 exit 1 —— 对「确认不存在」类检查是成功负证据，勿当命令失败
      const grepNoMatch = result.code === 1 && /\b(grep|egrep|fgrep|rg)\b/.test(cmd)
      const failed = !grepNoMatch && (!result.ok || (result.code != null && result.code !== 0))
      const looksBuild = /\b(npm|yarn|pnpm)\s+run\s+build\b|\bnpm\s+run\s+serve\b|\bvue-cli-service\s+build\b/i.test(cmd)
      return {
        ok: !failed,
        content: truncate(
          `cwd=${projectRoot}\nexit=${result.code}` +
          (grepNoMatch ? ' (grep/rg: no matches — valid negative evidence)\n' : '\n') +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ),
        meta: {
          code: result.code,
          exitCode: result.code,
          cwd: projectRoot,
          grepNoMatch: !!grepNoMatch,
          commandFail: failed,
          buildFail: failed && looksBuild
        }
      }
    }

    if (name === 'web_fetch') {
      const url = String(args.url || '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: '仅支持 http/https URL' }
      const res = await fetch(url, { headers: { 'User-Agent': 'AIFront-PandaAgent/1.0' } })
      const text = await res.text()
      return { ok: res.ok, content: truncate(text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 16000) }
    }

    if (name === 'web_search') {
      const q = encodeURIComponent(String(args.query || '').trim())
      if (!q) return { ok: false, content: 'query 为空' }
      const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`
      const res = await fetch(url, { headers: { 'User-Agent': 'AIFront-PandaAgent/1.0' } })
      const data = await res.json().catch(() => ({}))
      const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : []
      const lines = []
      if (data.AbstractText) lines.push(data.AbstractText)
      if (data.AbstractURL) lines.push('来源：' + data.AbstractURL)
      related.slice(0, 8).forEach(t => {
        if (t && t.Text) lines.push('- ' + t.Text + (t.FirstURL ? ` (${t.FirstURL})` : ''))
        if (t && t.Topics) t.Topics.slice(0, 3).forEach(x => { if (x.Text) lines.push('- ' + x.Text) })
      })
      return { ok: true, content: lines.length ? lines.join('\n') : '未找到摘要，请换关键词或用 web_fetch 打开文档页。' }
    }

    if (name === 'todo_write') {
      let todos = Array.isArray(args.todos) ? args.todos : []
      // 对齐 panda-code TodoWriteTool：全部 completed 则清空，避免粘到下一任务
      const allDone = todos.length > 0 && todos.every(t => t && t.status === 'completed')
      if (allDone) todos = []
      runtime.todos = todos
      if (runtime.sendEvent) runtime.sendEvent('panda_todos', { todos: runtime.todos || [] })
      return {
        ok: true,
        content: allDone
          ? '全部 todo 已完成，已清空清单（对齐 panda-code）。下一新任务请重新拆解。'
          : ('已更新 todos：\n' + runtime.todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n'))
      }
    }

    if (name === 'task_list') {
      const todos = runtime.todos || []
      return { ok: true, content: todos.length ? todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n') : '(暂无任务)' }
    }

    if (name === 'task_create') {
      if (!Array.isArray(runtime.todos)) runtime.todos = []
      const id = args.id || ('t' + (runtime.todos.length + 1))
      runtime.todos.push({ id, content: args.content || '', status: args.status || 'pending' })
      if (runtime.sendEvent) runtime.sendEvent('panda_todos', { todos: runtime.todos })
      return { ok: true, content: '已创建任务 ' + id }
    }

    if (name === 'task_update') {
      if (!Array.isArray(runtime.todos)) runtime.todos = []
      const t = runtime.todos.find(x => x.id === args.id)
      if (!t) return { ok: false, content: '任务不存在：' + args.id }
      if (args.content != null) t.content = args.content
      if (args.status != null) t.status = args.status
      if (runtime.sendEvent) runtime.sendEvent('panda_todos', { todos: runtime.todos })
      return { ok: true, content: `已更新任务 ${args.id} → ${t.status}` }
    }

    if (name === 'task_get') {
      if (!Array.isArray(runtime.todos)) runtime.todos = []
      const id = args.id || args.taskId
      const t = runtime.todos.find(x => x.id === id)
      if (!t) {
        // Team 任务板兜底
        try {
          const team = require('./team')
          const teams = await team.listTeams(projectRoot)
          for (const info of teams) {
            const hit = team.getTask(projectRoot, info.id, id)
            if (hit) {
              return { ok: true, content: JSON.stringify(hit, null, 2) }
            }
          }
        } catch (e) { /* ignore */ }
        return { ok: false, content: '任务不存在：' + id }
      }
      return {
        ok: true,
        content: JSON.stringify({
          id: t.id,
          content: t.content,
          description: t.description || '',
          status: t.status,
          blocks: t.blocks || [],
          blockedBy: t.blockedBy || []
        }, null, 2)
      }
    }

    if (name === 'notebook_edit') {
      return require('./notebookEdit').editNotebook(projectRoot, args, runtime)
    }

    if (name === 'ask_user') {
      return {
        ok: true,
        content: '已向用户提问，等待回复',
        meta: { askUser: true, question: args.question, options: args.options || [] }
      }
    }

    if (name === 'enter_plan_mode') {
      runtime.mode = 'plan'
      runtime.permissionMode = 'plan'
      if (runtime.sendEvent) {
        runtime.sendEvent('panda_mode', { mode: 'plan', permissionMode: 'plan' })
      }
      return {
        ok: true,
        content: [
          '已进入 Plan Mode（权限闸门已锁写）。',
          '允许：read/glob/grep/Explore/ask_user；计划可写 `.panda/`。',
          '禁止：write_file/edit_file/apply_patch 业务文件、破坏性 bash。',
          '流程：探索 → 写计划/Critical Files → 必要时 ask_user → exit_plan_mode 后再实施。',
          '（非传言 stage-gate：不会因第一轮调工具而杀会话；写业务文件会被拒绝。）'
        ].join('\n'),
        meta: { mode: 'plan' }
      }
    }

    if (name === 'exit_plan_mode') {
      const planText = String(args.plan || runtime.lastPlan || '')
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'exit_plan_mode',
          detail: 'Approve plan & exit Plan Mode',
          risk: 'write',
          forceAsk: true,
          preview: planText.slice(0, 6000) || '(empty plan)',
          reason: 'Plan approval required before implementation'
        })
        if (!allowed) {
          return { ok: false, content: '用户拒绝退出 Plan Mode（计划未批准）。仍停留在 Plan Mode。' }
        }
      }
      runtime.mode = 'default'
      // UI 可能已通过 resolvePerm 写入目标 mode（bypass / auto / acceptEdits / default）
      if (runtime.permissionMode === 'plan' || !runtime.permissionMode) {
        const nextMode = String(args.permission_mode || args.nextMode || 'acceptEdits').trim() || 'acceptEdits'
        if (/bypass/i.test(nextMode) || nextMode === 'yolo') {
          runtime.permissionMode = 'bypassPermissions'
        } else if (nextMode === 'auto') {
          runtime.permissionMode = 'auto'
        } else if (nextMode === 'default') {
          runtime.permissionMode = 'default'
        } else if (nextMode === 'dontAsk') {
          runtime.permissionMode = 'dontAsk'
        } else {
          runtime.permissionMode = 'acceptEdits'
        }
      }
      runtime.lastPlan = planText
      if (runtime.sendEvent) {
        runtime.sendEvent('panda_mode', {
          mode: 'default',
          permissionMode: runtime.permissionMode,
          planApproved: true,
          plan: planText.slice(0, 12000)
        })
        runtime.sendEvent('panda_block', {
          type: 'system',
          content: 'Plan approved · exited Plan Mode → ' + runtime.permissionMode
        })
      }
      return {
        ok: true,
        content: '已退出 Plan Mode（' + runtime.permissionMode + '）。计划：\n' + planText,
        meta: { mode: 'default', planApproved: true, permissionMode: runtime.permissionMode }
      }
    }

    if (name === 'memory_read') {
      if (args.topic) {
        const r = await require('./memoryIndex').readTopic(projectRoot, args.topic)
        return { ok: r.ok !== false, content: r.content }
      }
      const text = await runtime.memory.read()
      return { ok: true, content: text || '(记忆索引为空)' }
    }

    if (name === 'memory_append') {
      const topic = await runtime.memory.append(args.note, args.topic || 'general')
      runtime.didMemoryAppend = true
      return { ok: true, content: '已写入记忆 topic=`' + topic + '`' }
    }

    if (name === 'skill') {
      const sk = await getSkill(projectRoot, args.id)
      if (!sk) {
        const all = await loadSkills(projectRoot)
        return { ok: false, content: '未找到 skill。可用：' + all.map(x => x.id).join(', ') }
      }
      return { ok: true, content: `已加载 Skill「${sk.title}」\n\n${sk.body}` }
    }

    if (name === 'tool_search') {
      const q = String(args.query || '').toLowerCase()
      const names = getToolDefinitions().map(t => t.function.name)
      const hits = names.filter(n => n.includes(q) || q.split(/\s+/).some(w => n.includes(w)))
      return { ok: true, content: (hits.length ? hits : names).join('\n') }
    }

    if (name === 'undo_file') {
      const r = await undoLast(projectRoot, args.path || '')
      return { ok: r.ok, content: r.message, meta: r.ok ? { file: r.file, changed: true } : null }
    }

    if (name === 'diagnostics') {
      const target = args.path ? String(args.path) : ''
      const notes = []
      if (target) {
        const gate = canReadFile(projectRoot, target)
        if (!gate.ok) return { ok: false, content: gate.reason }
        const raw = await fsp.readFile(gate.target, 'utf8')
        if (target.endsWith('.vue')) {
          if (!/<template[\s>]/.test(raw)) notes.push('缺少 <template>')
          if (!/<script[\s>]/.test(raw)) notes.push('缺少 <script>')
          const open = (raw.match(/\{/g) || []).length
          const close = (raw.match(/\}/g) || []).length
          if (open !== close) notes.push(`花括号可能不平衡：{ ${open} } ${close}`)
        }
        notes.push(`文件大小 ${raw.length} 字符，行数 ${raw.split(/\n/).length}`)
      }
      if (args.build) {
        const result = await runBash('npm run build', projectRoot, 90000)
        notes.push(`build exit=${result.code}`)
        notes.push(truncate((result.stderr || result.stdout || '').split(/\n/).slice(-40).join('\n'), 6000))
      }
      return { ok: true, content: notes.join('\n') || '无诊断信息（可传 build:true）' }
    }

    if (name === 'browser_console') {
      const browserConsole = require('./browserConsole')
      const sessionId = (runtime && runtime.sessionId) || ''
      const level = args.level || 'error'
      const entries = browserConsole.list({
        sessionId,
        limit: args.limit || 40,
        level,
        query: args.query || ''
      })
      let content = browserConsole.formatForAgent(entries)
      if (args.clear) {
        browserConsole.clear(sessionId)
        content += '\n\n（已清空该会话控制台缓存）'
      }
      return {
        ok: true,
        content,
        meta: { count: entries.length, level }
      }
    }

    if (name === 'capture_page') {
      const pageCapture = require('./pageCapture')
      return pageCapture.capturePage(projectRoot, args || {})
    }

    if (name === 'sleep') {
      const ms = Math.min(15000, Math.max(0, parseInt(args.ms, 10) || 0))
      await new Promise(r => setTimeout(r, ms))
      return { ok: true, content: `已等待 ${ms}ms` }
    }

    if (name === 'Agent' || name === 'agent' ||
        name === 'agent_explore' || name === 'agent_plan' || name === 'agent_verify') {
      let type = args.subagent_type || args.type || ''
      let prompt = args.prompt || args.goal || ''
      if (name === 'agent_explore') type = 'Explore'
      if (name === 'agent_plan') type = 'Plan'
      if (name === 'agent_verify') type = 'Verify'
      if (!type) type = 'Explore'

      const summary = await runAgent(type, prompt, projectRoot, {
        thoroughness: args.thoroughness || args.level || 'medium',
        changedFiles: runtime.changedFiles || [],
        parentSessionId: runtime.sessionId,
        forkContextMessages: runtime.sidechainMessages || [],
        readFileState: runtime.readFileState,
        parentRequirePermission: runtime.requirePermission,
        parentMode: runtime.mode,
        parentContext: runtime.context,
        model: args.model || 'inherit',
        sendEvent: runtime.sendEvent,
        onProgress: (k, m) => { if (runtime.sendEvent) runtime.sendEvent('step', { message: m }) }
      })

      // Verify：保留末尾 VERDICT
      if (isVerifyAgentCall(name, Object.assign({}, args, { subagent_type: type }))) {
        let body = String(summary || '')
        const vm = body.match(/\bVERDICT:\s*(PASS|FAIL|PARTIAL)\b[^\n]*/i)
        const verdictLine = vm ? vm[0] : ''
        if (body.length > 14000) {
          body = body.slice(0, 14000) + '\n…[截断]\n' + (verdictLine ? '\n' + verdictLine : '')
        }
        return { ok: true, content: body, meta: { subagent_type: 'Verify' } }
      }
      return { ok: true, content: truncate(summary, 14000), meta: { subagent_type: type } }
    }


    // 自动挂载的 MCP 工具：mcp__server__tool
    if (mcp.isMcpToolName(name)) {
      try {
        const text = await mcp.callByQualifiedName(projectRoot, name, args)
        return { ok: true, content: truncate(String(text), 16000) }
      } catch (e) {
        return { ok: false, content: 'MCP 调用失败：' + (e.message || e) }
      }
    }

    if (name === 'mcp_connect') {
      const info = await mcp.connectServer(projectRoot, args.server)
      return {
        ok: true,
        content: '已连接 MCP ' + args.server +
          '\ntools=' + (info.tools || []).join(', ') +
          '\nregistered=' + (info.registeredAs || []).join(', ')
      }
    }
    if (name === 'mcp_list') {
      const list = await mcp.listConnected(projectRoot)
      const cfg = await mcp.loadMcpConfig(projectRoot)
      const pending = mcp.getPendingOAuth()
      return {
        ok: true,
        content: JSON.stringify({
          autoConnect: cfg.autoConnect !== false,
          configured: Object.keys(cfg.servers || {}),
          connected: list,
          pendingOAuth: pending
        }, null, 2)
      }
    }
    if (name === 'mcp_call') {
      const text = await mcp.callMcpTool(projectRoot, args.server, args.tool, args.arguments || {})
      return { ok: true, content: truncate(String(text), 16000) }
    }
    if (name === 'mcp_resources') {
      const list = await mcp.listMcpResources(projectRoot, args.server)
      return { ok: true, content: JSON.stringify(list, null, 2) }
    }
    if (name === 'mcp_read_resource') {
      const text = await mcp.readMcpResource(projectRoot, args.server, args.uri)
      return { ok: true, content: truncate(String(text), 16000) }
    }
    if (name === 'enter_worktree') {
      const mainRoot = runtime.mainRoot || projectRoot
      const r = await worktree.enterWorktree(mainRoot, args.name)
      if (r.ok && r.worktreePath) {
        runtime.mainRoot = mainRoot
        runtime.projectRoot = r.worktreePath
        if (runtime.sendEvent) {
          runtime.sendEvent('panda_worktree', { active: true, path: r.worktreePath, branch: r.branch })
        }
      }
      return { ok: r.ok, content: r.message, meta: r.ok ? { worktreePath: r.worktreePath, branch: r.branch } : null }
    }
    if (name === 'exit_worktree') {
      const mainRoot = runtime.mainRoot || projectRoot
      const r = await worktree.exitWorktree(mainRoot, { remove: args.remove !== false })
      if (r.ok) {
        runtime.projectRoot = mainRoot
        if (runtime.sendEvent) runtime.sendEvent('panda_worktree', { active: false })
      }
      return { ok: r.ok, content: r.message }
    }
    if (name === 'config_get') {
      const cfg = await pandaConfig.loadConfig(projectRoot)
      return { ok: true, content: JSON.stringify(cfg, null, 2) }
    }
    if (name === 'config_set') {
      const next = await pandaConfig.saveConfig(projectRoot, args.patch || {})
      return { ok: true, content: '已更新配置：\n' + JSON.stringify(next, null, 2) }
    }
    if (name === 'brief') {
      const wt = await worktree.currentWorktree(runtime.mainRoot || projectRoot)
      const lines = [
        args.note ? ('备注：' + args.note) : null,
        '模式：' + (runtime.mode || 'default'),
        '工作目录：' + (runtime.projectRoot || projectRoot),
        wt && wt.worktreePath ? ('Worktree：' + wt.worktreePath + ' @ ' + wt.branch) : 'Worktree：无',
        '改动文件：' + ((runtime.changedFiles || []).map(f => f.file || f).join(', ') || '无'),
        'Todos：' + ((runtime.todos || []).map(t => t.id + ':' + t.status).join(', ') || '无')
      ].filter(Boolean)
      return { ok: true, content: lines.join('\n') }
    }


    if (name === 'coordinator') {
      const report = await runCoordinator(args.goal || '', projectRoot, {
        changedFiles: runtime.changedFiles || [],
        onProgress: (k, m) => { if (runtime.sendEvent) runtime.sendEvent('step', { message: m }) }
      })
      return {
        ok: true,
        content: ['【Coordinator 汇总】', report.synthesis, '', '--- Explore ---', report.explore, '', '--- Plan ---', report.plan, report.verify ? ('\n--- Verify ---\n' + report.verify) : ''].join('\n')
      }
    }
    if (name === 'bash_bg') {
      const gate = canRunBash(args.command, mode, projectRoot)
      if (!gate.ok) return { ok: false, content: gate.reason }
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({ tool: 'bash_bg', detail: String(args.command||'').slice(0,120), risk: 'bash' })
        if (!allowed) return { ok: false, content: '用户拒绝了后台命令' }
      }
      const t = bgTasks.createBackgroundShell(projectRoot, args.command, { mainRoot: runtime.mainRoot })
      return { ok: true, content: '后台任务已启动 id=' + t.id + ' cmd=' + t.command }
    }
    if (name === 'task_output') {
      const o = bgTasks.getTaskOutput(args.id, { tail: args.tail })
      if (!o.ok) return { ok: false, content: o.message }
      return { ok: true, content: JSON.stringify(o, null, 2) }
    }
    if (name === 'task_stop') {
      const o = bgTasks.stopTask(args.id)
      return { ok: o.ok, content: o.message }
    }
    if (name === 'task_bg_list') {
      return { ok: true, content: JSON.stringify(bgTasks.listTasks(projectRoot), null, 2) }
    }
    if (name === 'team_create') {
      const t = team.createTeam(projectRoot, args.name, args.members)
      return { ok: true, content: '已创建 team ' + t.id + ' members=' + t.members.map(m=>m.id).join(',') }
    }
    if (name === 'team_delete') {
      const ok = team.deleteTeam(projectRoot, args.name)
      return { ok, content: ok ? '已删除' : '不存在' }
    }
    if (name === 'team_list') {
      return { ok: true, content: JSON.stringify(team.listTeams(projectRoot), null, 2) }
    }
    if (name === 'send_message') {
      const r = await team.sendMessage(projectRoot, args.team, args.to, args.message)
      return { ok: r.ok, content: r.message }
    }
    if (name === 'team_run_member') {
      const r = await team.runMember(projectRoot, args.team, args.member, args.goal || '', {
        sessionId: runtime.sessionId,
        sendEvent: runtime.sendEvent,
        parentRequirePermission: runtime.requirePermission,
        signal: runtime.signal
      })
      return { ok: r.ok, content: r.ok ? ('【' + r.member + '】\n' + r.result) : r.message }
    }
    if (name === 'cron_create') {
      const r = await cron.createCron(projectRoot, args)
      return { ok: r.ok, content: r.ok ? JSON.stringify(r.job, null, 2) : r.message }
    }
    if (name === 'cron_list') {
      return { ok: true, content: JSON.stringify(await cron.listCron(projectRoot), null, 2) }
    }
    if (name === 'cron_delete') {
      const r = await cron.deleteCron(projectRoot, args.id)
      return { ok: r.ok, content: r.message }
    }
    if (name === 'cron_tick') {
      const due = await cron.tickCron(projectRoot)
      return { ok: true, content: due.length ? JSON.stringify(due, null, 2) : '(无到期任务)' }
    }
    if (name === 'repl') {
      const code = String(args.code || '')
      if (/require|process|child_process|fs\b|while\s*\(|for\s*\(/.test(code)) {
        return { ok: false, content: 'REPL 拒绝潜在危险代码' }
      }
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('"use strict"; return (' + code + ')')
        const val = fn()
        return { ok: true, content: String(val) }
      } catch (e1) {
        try {
          // eslint-disable-next-line no-new-func
          const fn2 = new Function('"use strict"; ' + code)
          const val2 = fn2()
          return { ok: true, content: val2 === undefined ? '(undefined)' : String(val2) }
        } catch (e2) {
          return { ok: false, content: e2.message }
        }
      }
    }


    if (name === 'lsp_diagnostics') {
      const r = await lsp.getDiagnostics(projectRoot, args.path)
      return { ok: r.ok !== false, content: r.content || r.message }
    }
    if (name === 'lsp_query') {
      const r = await lsp.lspQuery(projectRoot, args)
      return { ok: r.ok !== false, content: r.content || '' }
    }
    if (name === 'swarm_run') {
      const report = await swarm.runSwarm(projectRoot, args.goal || '', {
        onProgress: (k, m) => { if (runtime.sendEvent) runtime.sendEvent('step', { message: m }) },
        sessionId: runtime.sessionId,
        sendEvent: runtime.sendEvent
      })
      return {
        ok: true,
        content: ['【Swarm ' + report.id + '】', report.synthesis, '', 'Workers:', ...(report.workers||[]).map(w => '- ' + w.id + ' (' + w.role + '): ' + w.status)].join('\n'),
        meta: { swarmId: report.id }
      }
    }
    if (name === 'swarm_list') {
      return { ok: true, content: JSON.stringify(swarm.listSwarms(projectRoot), null, 2) }
    }
    if (name === 'swarm_get') {
      const g = swarm.getSwarm(projectRoot, args.id)
      return { ok: !!g, content: g ? JSON.stringify(g, null, 2) : '不存在' }
    }


    if (name === 'agent_fork') {
      const agentFork = require('./agentFork')
      const report = await agentFork.runFork(projectRoot, {
        goal: args.goal || '',
        type: args.type || args.subagent_type || 'fork',
        writable: !!args.writable || args.type === 'implementer',
        parentSessionId: runtime.sessionId,
        forkContextMessages: runtime.sidechainMessages || [],
        readFileState: runtime.readFileState,
        parentRequirePermission: runtime.requirePermission,
        parentMode: runtime.mode,
        parentContext: runtime.context,
        systemPrompt: null,
        model: args.model || 'inherit',
        permissionMode: args.permission_mode || (args.type === 'explore' || args.type === 'plan' ? 'plan' : 'bubble'),
        onProgress: (k, m) => { if (runtime.sendEvent) runtime.sendEvent('step', { message: m }) },
        sendEvent: runtime.sendEvent
      })
      return {
        ok: report.status !== 'error',
        content: [
          '【Fork ' + report.id + ' · ' + report.type + '】',
          'permission=' + report.permissionMode + ' model=' + report.model,
          report.result || ''
        ].join('\n\n'),
        meta: { forkId: report.id }
      }
    }
    if (name === 'agent_resume') {
      const agentFork = require('./agentFork')
      const r = await agentFork.resumeFork(projectRoot, args.id, args.follow_up || '', {
        parentRequirePermission: runtime.requirePermission,
        parentMode: runtime.mode,
        parentContext: runtime.context,
        sendEvent: runtime.sendEvent
      })
      return { ok: !!r.ok, content: r.ok ? r.result : r.message }
    }
    if (name === 'agent_list') {
      const agentFork = require('./agentFork')
      return { ok: true, content: JSON.stringify(agentFork.listForks(projectRoot), null, 2) }
    }

    if (name === 'verify_plan') {
      const plan = String(args.plan || runtime.lastPlan || '').trim()
      const changed = (runtime.changedFiles || []).map(f => f.file || f)
      const todos = Array.isArray(runtime.todos) ? runtime.todos : []
      const open = todos.filter(t => t && t.status !== 'completed' && t.status !== 'cancelled')
      const notes = String(args.notes || '').trim()
      const lines = [
        'VerifyPlanExecution',
        'plan_chars: ' + plan.length,
        'changed_files: ' + (changed.length ? changed.slice(0, 30).join(', ') : '(none)'),
        'open_todos: ' + open.length
      ]
      if (notes) lines.push('notes: ' + notes.slice(0, 800))
      let verdict = 'PASS'
      if (!plan && !changed.length) {
        verdict = 'PARTIAL'
        lines.push('reason: no plan text and no changed files')
      } else if (open.length) {
        verdict = 'PARTIAL'
        lines.push('reason: incomplete todos remain')
        open.slice(0, 8).forEach(t => lines.push('  - [' + t.status + '] ' + (t.content || t.id)))
      } else if (changed.length && plan) {
        // 粗检：计划关键词是否在改动路径中出现（非充分必要）
        const tokens = plan.toLowerCase().match(/[a-z0-9_./-]{4,}/g) || []
        const hit = tokens.filter(tok => changed.some(c => String(c).toLowerCase().includes(tok))).length
        if (tokens.length >= 5 && hit === 0) {
          verdict = 'PARTIAL'
          lines.push('reason: plan tokens not reflected in changed paths (weak signal)')
        }
      }
      if (runtime.verifyFailed) {
        verdict = 'FAIL'
        lines.push('reason: prior agent_verify FAIL')
      }
      runtime.didVerify = true
      runtime.didVerifyPlan = true
      lines.unshift('VERDICT: ' + verdict)
      return { ok: verdict !== 'FAIL', content: lines.join('\n'), meta: { verdict, verifyPlan: true } }
    }

    if (name === 'powershell') {
      const cmd = String(args.command || '')
      if (!cmd) return { ok: false, content: '空命令' }
      if (runtime.requirePermission) {
        const allowed = await runtime.requirePermission({
          tool: 'powershell',
          detail: cmd.slice(0, 120),
          risk: 'bash',
          args: { command: cmd }
        })
        if (!allowed) return { ok: false, content: '用户拒绝了 PowerShell 命令' }
      }
      const { spawnSync } = require('child_process')
      const shells = process.platform === 'win32'
        ? ['pwsh.exe', 'powershell.exe']
        : ['pwsh', 'powershell']
      let bin = null
      for (const b of shells) {
        try {
          const wh = spawnSync(process.platform === 'win32' ? 'where' : 'which', [b], { encoding: 'utf8' })
          if (wh.status === 0 && String(wh.stdout || '').trim()) {
            bin = b
            break
          }
        } catch (e) { /* ignore */ }
      }
      if (!bin) {
        return {
          ok: false,
          content: '未找到 pwsh/powershell。macOS/Linux 可 `brew install powershell`；或改用 bash 工具。'
        }
      }
      const timeout = Math.min(120000, Math.max(5000, parseInt(args.timeout_ms, 10) || 30000))
      const r = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout,
        env: process.env
      })
      const code = r.status == null ? -1 : r.status
      return {
        ok: code === 0,
        content: truncate(
          'shell=' + bin + '\nexit=' + code + '\nstdout:\n' + (r.stdout || '') + '\nstderr:\n' + (r.stderr || r.error && r.error.message || '')
        )
      }
    }

    if (name === 'team_perm_list') {
      const swarmPerm = require('./swarmPerm')
      const list = await swarmPerm.listPending(projectRoot, args.team_id)
      return { ok: true, content: list.length ? JSON.stringify(list, null, 2) : '(no pending team permissions)' }
    }
    if (name === 'team_perm_resolve') {
      const swarmPerm = require('./swarmPerm')
      const r = await swarmPerm.resolveTeamPermission(
        projectRoot,
        args.team_id,
        args.id,
        args.allow !== false,
        args.reason || ''
      )
      return { ok: !!r.ok, content: r.ok ? JSON.stringify(r.request, null, 2) : (r.reason || 'fail') }
    }
    if (name === 'custom_agents') {
      const list = await require('./customAgents').listCustomAgents(projectRoot)
      return {
        ok: true,
        content: list.length
          ? list.map(a => '- ' + a.id + (a.description ? ': ' + a.description : '')).join('\n')
          : '（无自定义 Agent。可在 .panda/agents/<name>.md 添加 frontmatter + 提示词）'
      }
    }

    return { ok: false, content: '未知工具：' + name }
  } catch (e) {
    return { ok: false, content: '工具执行失败：' + (e.message || String(e)) }
  }
}

const READONLY_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'web_fetch', 'web_search', 'memory_read',
  'tool_search', 'task_list', 'task_get', 'skill', 'diagnostics', 'browser_console', 'capture_page', 'sleep',
  'Agent', 'agent', 'agent_explore', 'agent_plan', 'agent_verify',
  'mcp_list', 'mcp_resources', 'mcp_read_resource', 'config_get', 'brief',
  'coordinator', 'task_output', 'task_bg_list', 'team_list', 'cron_list', 'cron_tick', 'repl',
  'lsp_diagnostics', 'lsp_query', 'swarm_list', 'swarm_get', 'agent_list',
  'custom_agents', 'team_perm_list', 'verify_plan'
])

function isReadonlyTool (name) {
  return READONLY_TOOLS.has(name)
}

module.exports = {
  getToolDefinitions,
  executeTool,
  truncate,
  isReadonlyTool
}
