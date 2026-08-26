<template>
  <div class="page-memory">
    <!-- 顶部渐变 Banner -->
    <div class="memory-banner">
      <div class="banner-left">
        <div class="banner-icon">
          <i class="el-icon-collection"></i>
        </div>
        <div class="banner-text">
          <div class="banner-title">长期记忆</div>
          <div class="banner-subtitle">跨会话持久化的项目记忆与团队约定</div>
        </div>
      </div>
      <div class="banner-right">
        <el-button type="primary" size="medium" icon="el-icon-plus" class="banner-add-btn" @click="handleAdd">
          新增记忆
        </el-button>
      </div>
    </div>

    <!-- 统计概览 -->
    <div class="stat-grid">
      <div class="stat-card stat-card-blue">
        <div class="stat-icon"><i class="el-icon-notebook-2"></i></div>
        <div class="stat-info">
          <div class="stat-value">{{ memoryList.length }}</div>
          <div class="stat-label">记忆条目</div>
        </div>
      </div>
      <div class="stat-card stat-card-green">
        <div class="stat-icon"><i class="el-icon-price-tag"></i></div>
        <div class="stat-info">
          <div class="stat-value">{{ tagCount }}</div>
          <div class="stat-label">标签分类</div>
        </div>
      </div>
      <div class="stat-card stat-card-red">
        <div class="stat-icon"><i class="el-icon-star-on"></i></div>
        <div class="stat-info">
          <div class="stat-value">{{ importantCount }}</div>
          <div class="stat-label">重要记忆</div>
        </div>
      </div>
      <div class="stat-card stat-card-purple">
        <div class="stat-icon"><i class="el-icon-time"></i></div>
        <div class="stat-info">
          <div class="stat-value stat-value-sm">{{ lastUpdated }}</div>
          <div class="stat-label">最近更新</div>
        </div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-input
          v-model="keyword"
          size="medium"
          placeholder="搜索记忆内容"
          class="search-input"
          clearable
          prefix-icon="el-icon-search"
          @keyup.enter.native="handleSearch"
        />
        <el-select v-model="filterTag" size="medium" placeholder="按标签筛选" clearable class="tag-select" @change="handleSearch">
          <el-option
            v-for="tag in allTags"
            :key="tag"
            :label="tag"
            :value="tag"
          />
        </el-select>
      </div>
      <div class="toolbar-right">
        <span class="result-count" v-if="filteredList.length">共 {{ filteredList.length }} 条记忆</span>
      </div>
    </div>

    <!-- 记忆列表 -->
    <div class="memory-list" v-loading="loading">
      <div
        v-for="item in filteredList"
        :key="item.id"
        class="memory-item"
        :class="{ 'is-important': item.important }"
      >
        <div class="memory-item-main">
          <div class="memory-item-top">
            <span class="memory-icon" :class="getIconClass(item)">
              <i :class="getIcon(item)"></i>
            </span>
            <div class="memory-title-wrap">
              <div class="memory-title">{{ item.title }}</div>
              <div class="memory-meta">
                <span class="memory-author">
                  <i class="el-icon-user"></i> {{ item.author }}
                </span>
                <span class="memory-time">
                  <i class="el-icon-time"></i> {{ item.updatedAt }}
                </span>
              </div>
            </div>
            <div class="memory-actions">
              <el-tag v-if="item.important" size="mini" type="primary" effect="dark" class="important-tag">
                <i class="el-icon-star-on"></i> 重要
              </el-tag>
              <el-button type="text" icon="el-icon-edit-outline" class="action-btn" @click="handleEdit(item)" />
              <el-button type="text" icon="el-icon-delete" class="action-btn del-btn" @click="handleDelete(item)" />
            </div>
          </div>
          <div class="memory-content" @click="handleExpand(item)">
            <p>{{ item.content }}</p>
          </div>
          <div class="memory-tags">
            <el-tag
              v-for="tag in item.tags"
              :key="tag"
              size="mini"
              class="tag-item"
              :type="getTagType(tag)"
              effect="light"
            >
              {{ tag }}
            </el-tag>
          </div>
        </div>
      </div>

      <div v-if="!filteredList.length" class="empty-block">
        <el-empty description="暂无记忆条目，点击右上角“新增记忆”创建。" />
      </div>
    </div>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog
      :title="isEdit ? '编辑记忆' : '新增记忆'"
      :visible.sync="dialogVisible"
      width="560px"
      @close="handleDialogClose"
      custom-class="memory-dialog"
    >
      <el-form
        ref="memoryFormRef"
        :model="form"
        :rules="rules"
        label-width="90px"
        class="memory-form"
      >
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" placeholder="请输入记忆标题" prefix-icon="el-icon-edit" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="请输入记忆内容"
          />
        </el-form-item>
        <el-form-item label="标签" prop="tags">
          <el-select
            v-model="form.tags"
            multiple
            collapse-tags
            :multiple-limit="5"
            placeholder="请选择标签（最多 5 个）"
          >
            <el-option
              v-for="tag in allTags"
              :key="tag"
              :label="tag"
              :value="tag"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="重要程度">
          <el-switch
            v-model="form.important"
            active-text="重要"
            inactive-text="普通"
            active-color="#1890ff"
          />
        </el-form-item>
      </el-form>

      <div slot="footer" class="dialog-footer">
        <el-button @click="dialogVisible = false">取 消</el-button>
        <el-button type="primary" :loading="submitLoading" @click="handleSubmit">
          保 存
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
export default {
  name: 'LongTermMemory',
  data () {
    return {
      loading: false,
      keyword: '',
      filterTag: '',
      memoryList: [],
      dialogVisible: false,
      isEdit: false,
      currentEditId: null,
      submitLoading: false,
      form: {
        title: '',
        content: '',
        tags: [],
        important: false
      },
      rules: {
        title: [{ required: true, message: '请输入记忆标题', trigger: 'blur' }],
        content: [{ required: true, message: '请输入记忆内容', trigger: 'blur' }]
      }
    }
  },
  computed: {
    allTags () {
      const tagSet = new Set()
      this.memoryList.forEach(item => {
        ;(item.tags || []).forEach(tag => tagSet.add(tag))
      })
      return Array.from(tagSet)
    },
    tagCount () {
      return this.allTags.length
    },
    importantCount () {
      return this.memoryList.filter(item => item.important).length
    },
    lastUpdated () {
      if (!this.memoryList.length) return '--'
      return this.memoryList[0].updatedAt
    },
    filteredList () {
      const kw = this.keyword.trim().toLowerCase()
      return this.memoryList.filter(item => {
        const matchKw = !kw ||
          (item.title && item.title.toLowerCase().includes(kw)) ||
          (item.content && item.content.toLowerCase().includes(kw))
        const matchTag = !this.filterTag ||
          (item.tags && item.tags.includes(this.filterTag))
        return matchKw && matchTag
      })
    }
  },
  created () {
    this.loadData()
  },
  methods: {
    loadData () {
      this.loading = true
      // 模拟从后端读取长期记忆（MEMORY.md 渲染）
      setTimeout(() => {
        this.memoryList = [
          {
            id: 'mem-1',
            title: '项目技术栈约定',
            content: '本项目使用 Vue 2.7 + ElementUI + Vue Router + Express 技术栈。所有页面组件统一放在 src/views 目录下，路由在 src/router/index.js 中注册，左侧菜单在 src/App.vue 中维护。',
            tags: ['技术栈', '约定'],
            important: true,
            author: 'Admin',
            updatedAt: '2024-03-15 10:30:00'
          },
          {
            id: 'mem-2',
            title: '代码风格规范',
            content: '默认使用简体中文回复用户；代码、路径、标识符、命令保持原文。改代码必须遵循 read_file → edit_file 流程，禁止用 bash/sed 直接修改业务文件。',
            tags: ['规范', '编码'],
            important: true,
            author: 'Admin',
            updatedAt: '2024-03-14 16:20:00'
          },
          {
            id: 'mem-3',
            title: '用户偏好',
            content: '用户偏好深色侧边栏（#001529）与蓝色主题色（#409EFF）。页面卡片采用圆角 + 阴影风格，hover 时上浮并加深阴影。',
            tags: ['偏好', 'UI'],
            important: false,
            author: 'Admin',
            updatedAt: '2024-03-12 09:15:00'
          },
          {
            id: 'mem-4',
            title: '数据接口约定',
            content: '列表接口统一返回 { records, total } 结构，分页参数为 pageNum / pageSize。新增、编辑、删除操作完成后需刷新列表。',
            tags: ['接口', '约定'],
            important: false,
            author: 'Admin',
            updatedAt: '2024-03-10 14:45:00'
          },
          {
            id: 'mem-5',
            title: '团队协作约定',
            content: '涉及多文件关联改动时，优先使用 apply_patch 或 edit_lines 保证一致性。复杂未知需求先通过 agent_explore / agent_plan 摸清结构再动手。',
            tags: ['协作', '流程'],
            important: false,
            author: 'Admin',
            updatedAt: '2024-03-08 11:00:00'
          }
        ]
        this.loading = false
      }, 300)
    },
    handleSearch () {
      // 计算属性自动过滤，无需额外逻辑
    },
    handleAdd () {
      this.isEdit = false
      this.currentEditId = null
      this.resetForm()
      this.dialogVisible = true
    },
    handleEdit (row) {
      this.isEdit = true
      this.currentEditId = row.id
      this.form = {
        title: row.title,
        content: row.content,
        tags: (row.tags && row.tags.slice()) || [],
        important: !!row.important
      }
      this.dialogVisible = true
    },
    handleDelete (row) {
      this.$confirm(`确定删除记忆「${row.title}」吗？`, '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.memoryList = this.memoryList.filter(item => item.id !== row.id)
        this.$message.success('删除成功')
      }).catch(() => {})
    },
    handleExpand (item) {
      // 预留：点击内容可展开详情
    },
    handleDialogClose () {
      this.resetForm()
    },
    resetForm () {
      this.$nextTick(() => {
        if (this.$refs.memoryFormRef) {
          this.$refs.memoryFormRef.resetFields()
        }
      })
      this.form = {
        title: '',
        content: '',
        tags: [],
        important: false
      }
      this.submitLoading = false
    },
    handleSubmit () {
      if (!this.$refs.memoryFormRef) return
      this.$refs.memoryFormRef.validate(valid => {
        if (!valid) return
        this.submitLoading = true
        setTimeout(() => {
          if (this.isEdit && this.currentEditId) {
            const idx = this.memoryList.findIndex(item => item.id === this.currentEditId)
            if (idx > -1) {
              this.memoryList.splice(idx, 1, {
                ...this.memoryList[idx],
                ...this.form,
                updatedAt: this.getNow()
              })
            }
            this.$message.success('更新成功')
          } else {
            this.memoryList.unshift({
              id: 'mem-' + Date.now(),
              ...this.form,
              author: 'Admin',
              updatedAt: this.getNow()
            })
            this.$message.success('创建成功')
          }
          this.dialogVisible = false
          this.submitLoading = false
        }, 300)
      })
    },
    getNow () {
      const d = new Date()
      const pad = n => (n < 10 ? '0' + n : '' + n)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    },
    getIcon (item) {
      if (item.important) return 'el-icon-star-on'
      if (item.tags && item.tags.includes('技术栈')) return 'el-icon-cpu'
      if (item.tags && item.tags.includes('规范')) return 'el-icon-document-checked'
      if (item.tags && item.tags.includes('偏好')) return 'el-icon-user'
      if (item.tags && item.tags.includes('接口')) return 'el-icon-connection'
      return 'el-icon-collection'
    },
    getIconClass (item) {
      if (item.important) return 'icon-important'
      if (item.tags && item.tags.includes('技术栈')) return 'icon-tech'
      if (item.tags && item.tags.includes('规范')) return 'icon-rule'
      if (item.tags && item.tags.includes('偏好')) return 'icon-pref'
      if (item.tags && item.tags.includes('接口')) return 'icon-api'
      return 'icon-default'
    },
    getTagType (tag) {
      const map = {
        '技术栈': 'primary',
        '约定': 'success',
        '规范': 'warning',
        '编码': 'primary',
        '偏好': 'info',
        'UI': 'primary',
        '接口': 'success',
        '协作': 'warning',
        '流程': 'info'
      }
      return map[tag] || ''
    }
  }
}
</script>

<style scoped>
.page-memory {
  padding: 16px 20px;
  background: linear-gradient(160deg, #f5f7fb 0%, #eef2f7 100%);
  min-height: calc(100vh - 84px);
  box-sizing: border-box;
}

/* ===== 顶部渐变 Banner ===== */
.memory-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(120deg, #1f3a5f 0%, #2d5a8e 55%, #3a7bd5 100%);
  border-radius: 14px;
  padding: 22px 28px;
  margin-bottom: 20px;
  box-shadow: 0 8px 24px rgba(45, 90, 142, 0.25);
  position: relative;
  overflow: hidden;
}

.memory-banner::after {
  content: '';
  position: absolute;
  right: -40px;
  top: -60px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
}

.memory-banner::before {
  content: '';
  position: absolute;
  right: 60px;
  bottom: -80px;
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
}

.banner-left {
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative;
  z-index: 1;
}

.banner-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  color: #fff;
  backdrop-filter: blur(4px);
}

.banner-title {
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 1px;
}

.banner-subtitle {
  margin-top: 4px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
}

.banner-right {
  position: relative;
  z-index: 1;
}

.banner-add-btn {
  border-radius: 8px;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* ===== 统计卡片 ===== */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  transition: all 0.3s ease;
  border: 1px solid transparent;
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
}

.stat-icon {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.stat-card-blue .stat-icon { background: #e6f7ff; color: #1890ff; }
.stat-card-green .stat-icon { background: #f6ffed; color: #52c41a; }
.stat-card-red .stat-icon { background: #e6f7ff; color: #1890ff; }
.stat-card-purple .stat-icon { background: #f9f0ff; color: #722ed1; }

.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #1a1a1a;
  line-height: 1.1;
}

.stat-value-sm {
  font-size: 15px;
  font-weight: 600;
  color: #722ed1;
  line-height: 1.3;
}

.stat-label {
  margin-top: 4px;
  font-size: 13px;
  color: #8c8c8c;
}

/* ===== 工具栏 ===== */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search-input {
  width: 280px;
}

.tag-select {
  width: 160px;
}

.result-count {
  font-size: 13px;
  color: #8c8c8c;
}

/* ===== 记忆列表 ===== */
.memory-list {
  min-height: 200px;
}

.memory-item {
  border: 1px solid #eef0f4;
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 14px;
  transition: all 0.3s ease;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.memory-item:hover {
  border-color: #d6e4ff;
  box-shadow: 0 8px 24px rgba(24, 144, 255, 0.1);
  transform: translateY(-3px);
}

.memory-item.is-important {
  border-left: 4px solid #1890ff;
  background: linear-gradient(90deg, #f0f7ff 0%, #ffffff 40%);
}

.memory-item-top {
  display: flex;
  align-items: center;
  gap: 14px;
}

.memory-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.icon-important {
  background: linear-gradient(135deg, #69c0ff, #1890ff);
  color: #fff;
  box-shadow: 0 4px 10px rgba(24, 144, 255, 0.3);
}

.icon-tech {
  background: linear-gradient(135deg, #69c0ff, #1890ff);
  color: #fff;
  box-shadow: 0 4px 10px rgba(24, 144, 255, 0.3);
}

.icon-rule {
  background: linear-gradient(135deg, #ffc069, #fa8c16);
  color: #fff;
  box-shadow: 0 4px 10px rgba(250, 140, 22, 0.3);
}

.icon-pref {
  background: linear-gradient(135deg, #95de64, #52c41a);
  color: #fff;
  box-shadow: 0 4px 10px rgba(82, 196, 26, 0.3);
}

.icon-api {
  background: linear-gradient(135deg, #85a5ff, #2f54eb);
  color: #fff;
  box-shadow: 0 4px 10px rgba(47, 84, 235, 0.3);
}

.icon-default {
  background: linear-gradient(135deg, #bfbfbf, #8c8c8c);
  color: #fff;
  box-shadow: 0 4px 10px rgba(140, 140, 140, 0.3);
}

.memory-title-wrap {
  flex: 1;
  min-width: 0;
}

.memory-title {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-meta {
  margin-top: 5px;
  font-size: 12px;
  color: #8c8c8c;
  display: flex;
  gap: 16px;
}

.memory-meta i {
  margin-right: 3px;
}

.memory-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.important-tag {
  border-radius: 4px;
}

.action-btn {
  padding: 4px 6px;
  font-size: 16px;
}

.del-btn {
  color: #1890ff;
}

.memory-content {
  margin-top: 12px;
  padding: 12px 14px;
  background: #f8f9fc;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.8;
  color: #4a5568;
  cursor: pointer;
  border-left: 3px solid #e6e8ef;
  transition: all 0.3s ease;
}

.memory-content:hover {
  background: #f0f5ff;
  border-left-color: #1890ff;
}

.memory-content p {
  margin: 0;
}

.memory-tags {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-item {
  border-radius: 4px;
}

.empty-block {
  padding: 40px 0;
}

/* ===== 弹窗 ===== */
.memory-dialog .el-dialog__header {
  border-bottom: 1px solid #f0f0f0;
  padding-bottom: 14px;
}

/* ===== 响应式 ===== */
@media (max-width: 992px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .page-memory {
    padding: 10px 12px;
  }
  .memory-banner {
    padding: 16px 18px;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .search-input {
    width: 100%;
  }
  .toolbar-left {
    width: 100%;
  }
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .stat-value {
    font-size: 20px;
  }
  .stat-value-sm {
    font-size: 13px;
  }
}
</style>
