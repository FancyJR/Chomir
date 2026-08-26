<template>
  <div class="command-detail-container">
    <!-- 面包屑导航 -->
    <el-breadcrumb separator="/" class="breadcrumb">
      <el-breadcrumb-item :to="{ path: '/command-market' }">指令市场</el-breadcrumb-item>
      <el-breadcrumb-item>指令详情</el-breadcrumb-item>
    </el-breadcrumb>

    <!-- 主要内容区域 -->
    <div class="detail-content">
      <!-- 指令基本信息卡片 -->
      <el-card class="info-card">
        <div slot="header" class="card-header">
          <span class="card-title">基本信息</span>
          <el-button type="primary" size="small" @click="handleUseCommand">使用此指令</el-button>
        </div>
        <div class="info-content">
          <div class="info-row">
            <span class="info-label">指令名称：</span>
            <span class="info-value name-value">{{ commandInfo.name }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">指令ID：</span>
            <span class="info-value id-value">{{ commandInfo.id }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">创建者：</span>
            <span class="info-value">{{ commandInfo.creator }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">创建时间：</span>
            <span class="info-value">{{ commandInfo.createTime }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">使用次数：</span>
            <span class="info-value">{{ commandInfo.usageCount }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">指令描述：</span>
            <span class="info-value desc-value">{{ commandInfo.description }}</span>
          </div>
        </div>
      </el-card>

      <!-- 指令内容卡片 -->
      <el-card class="content-card">
        <div slot="header" class="card-header">
          <span class="card-title">指令内容</span>
        </div>
        <div class="command-content">
          <pre>{{ commandInfo.content }}</pre>
        </div>
      </el-card>

      <!-- 相关参数卡片 -->
      <el-card class="params-card" v-if="commandInfo.params && commandInfo.params.length">
        <div slot="header" class="card-header">
          <span class="card-title">相关参数</span>
        </div>
        <el-table :data="commandInfo.params" border style="width: 100%">
          <el-table-column prop="name" label="参数名" width="180"></el-table-column>
          <el-table-column prop="type" label="类型" width="120"></el-table-column>
          <el-table-column prop="description" label="描述"></el-table-column>
          <el-table-column prop="defaultValue" label="默认值" width="120"></el-table-column>
        </el-table>
      </el-card>

      <!-- 操作按钮 -->
      <div class="action-buttons">
        <el-button @click="goBack">返回</el-button>
        <el-button type="primary" @click="handleUseCommand">使用指令</el-button>
        <el-button type="success" @click="handleCopyCommand">复制指令</el-button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CommandDetail',
  data() {
    return {
      // 本地mock数据，模拟指令详情
      commandInfo: {
        id: 'CMD001',
        name: '数据统计指令',
        creator: '张三',
        createTime: '2023-10-15 14:30:00',
        usageCount: 156,
        description: '这是一个用于数据统计的指令，可以快速生成统计报表。',
        content: `SELECT 
  user_id,
  COUNT(*) as total_orders,
  SUM(amount) as total_amount
FROM orders
WHERE order_date >= '2023-01-01'
GROUP BY user_id
ORDER BY total_amount DESC
LIMIT 10;`,
        params: [
          { name: 'start_date', type: 'string', description: '开始日期', defaultValue: '2023-01-01' },
          { name: 'end_date', type: 'string', description: '结束日期', defaultValue: '2023-12-31' },
          { name: 'limit', type: 'number', description: '返回结果数量', defaultValue: '10' }
        ]
      }
    }
  },
  created() {
    // 从路由参数获取指令ID，这里模拟从路由获取
    const routeId = this.$route.params.id
    if (routeId) {
      // 实际开发中这里可以调用接口获取详情数据
      console.log('获取指令详情，ID:', routeId)
      // 这里可以更新commandInfo数据
    }
  },
  methods: {
    // 返回上一页
    goBack() {
      this.$router.go(-1)
    },
    // 使用指令
    handleUseCommand() {
      this.$message({
        message: '指令已应用，正在执行...',
        type: 'success'
      })
      // 实际开发中可以跳转到指令执行页面或执行相关操作
    },
    // 复制指令内容
    handleCopyCommand() {
      const textarea = document.createElement('textarea')
      textarea.value = this.commandInfo.content
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      
      this.$message({
        message: '指令内容已复制到剪贴板',
        type: 'success'
      })
    }
  }
}
</script>

<style scoped>
.command-detail-container {
  padding: 48px 56px;
  background: linear-gradient(135deg, #f5f7fa 0%, #f0f4f8 100%);
  min-height: calc(100vh - 60px);
}

.breadcrumb {
  margin-bottom: 48px;
}

.detail-content {
  max-width: 1440px;
  margin: 0 auto;
}

.info-card,
.content-card,
.params-card,
.feedback-section {
  margin-bottom: 40px;
  border-radius: 24px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.1);
  transition: box-shadow 0.3s ease, transform 0.3s ease;
  background-color: #ffffff;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 420px;
}

.info-card:hover,
.content-card:hover,
.params-card:hover,
.feedback-section:hover {
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.16);
  transform: translateY(-8px);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 32px 48px;
  border-bottom: 1px solid #f1f5f9;
  background-color: #fafbfc;
  flex-shrink: 0;
}

.card-title {
  font-size: 28px;
  font-weight: 700;
  color: #1f2937;
  letter-spacing: 0.5px;
}

.card-header .card-title {
  display: flex;
  align-items: center;
  gap: 20px;
}

.card-header .card-title .icon {
  color: #3b82f6;
  font-size: 28px;
}

.info-content {
  display: flex;
  flex-direction: column;
  gap: 36px;
  padding: 48px;
  flex: 1;
}

.info-row {
  display: flex;
  align-items: flex-start;
  min-height: 44px;
}

.info-label {
  width: 180px;
  font-weight: 600;
  color: #4b5563;
  flex-shrink: 0;
  line-height: 44px;
  font-size: 18px;
}

.info-value {
  flex: 1;
  color: #1f2937;
  line-height: 44px;
  font-size: 18px;
}

.name-value {
  font-size: 28px;
  font-weight: 700;
  color: #3b82f6;
  letter-spacing: 0.5px;
}

.id-value {
  font-family: 'Courier New', monospace;
  background: linear-gradient(90deg, #f0f2f5 0%, #e5e9f0 100%);
  padding: 14px 20px;
  border-radius: 16px;
  display: inline-block;
  border: 1px solid #e2e8f0;
  font-size: 18px;
  color: #374151;
}

.desc-value {
  line-height: 2.0;
  color: #4b5563;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 18px;
  padding-right: 28px;
}

.command-content {
  background: linear-gradient(90deg, #f8f9fa 0%, #f1f5f9 100%);
  border-radius: 18px;
  padding: 40px;
  overflow-x: auto;
  margin: 24px 48px 48px;
  border: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.command-content pre {
  margin: 0;
  font-family: 'Courier New', monospace;
  font-size: 18px;
  line-height: 2.0;
  color: #111827;
  white-space: pre-wrap;
  word-wrap: break-word;
  padding: 12px 0;
}

.action-buttons {
  display: flex;
  justify-content: center;
  gap: 40px;
  margin-top: 52px;
  padding: 48px;
  border-top: 1px solid #f1f5f9;
  background-color: #ffffff;
  border-radius: 24px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.08);
}

.action-buttons .el-button {
  min-width: 200px;
}

.command-card-footer {
  padding: 28px 48px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfc;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  box-sizing: border-box;
  margin-top: auto;
}

.command-card-footer .meta-left {
  display: flex;
  align-items: center;
  gap: 40px;
  flex-wrap: wrap;
}

.command-card-footer .meta-right {
  display: flex;
  align-items: center;
  gap: 40px;
  flex-wrap: wrap;
}

.command-card-footer .meta-item {
  display: flex;
  align-items: center;
  gap: 16px;
  color: #64748b;
  font-size: 18px;
}

.command-card-footer .meta-item .icon {
  color: #94a3b8;
}

.command-card-footer .meta-item .value {
  font-weight: 500;
  color: #334155;
}

.info-card {
  min-height: 420px;
}

.content-card {
  min-height: 580px;
}

.params-card {
  min-height: 420px;
}

.feedback-section {
  min-height: 400px;
}

.info-card .card-header {
  padding-bottom: 32px;
}

.content-card .card-header {
  padding-bottom: 32px;
}

.params-card .card-header {
  padding-bottom: 32px;
}

.info-content .info-row:last-child {
  margin-bottom: 24px;
}

.info-row .info-value .tags {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
}

.info-row .info-value .tag {
  background: linear-gradient(90deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #bae6fd;
  color: #0369a1;
  padding: 12px 20px;
  border-radius: 14px;
  font-size: 17px;
  font-weight: 500;
}

.command-content {
  margin-top: 24px;
}

.action-buttons {
  margin-top: 48px;
}

.feedback-section {
  margin-top: 60px;
  margin-bottom: 48px;
}

.el-button--primary {
  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);
  border-color: #3b82f6;
  box-shadow: 0 16px 36px rgba(59, 130, 246, 0.45);
  border-radius: 16px;
  font-weight: 600;
  padding: 18px 40px;
  font-size: 18px;
}

.el-button--primary:hover {
  filter: brightness(1.08);
  transform: translateY(-4px);
  box-shadow: 0 20px 40px rgba(59, 130, 246, 0.55);
}

.name-row, .name-zh, .name-en {
  writing-mode: horizontal-tb !important;
}

.content-card {
  min-height: 580px;
}

.feedback-section .card-header {
  padding-bottom: 32px;
}

.feedback-content {
  padding: 48px;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 36px;
}

.feedback-rating {
  display: flex;
  align-items: center;
  gap: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid #f1f5f9;
}

.feedback-rating-label {
  font-weight: 600;
  color: #4b5563;
  font-size: 18px;
}

.feedback-comment {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.feedback-comment-label {
  font-weight: 600;
  color: #4b5563;
  font-size: 18px;
}

.feedback-submit {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
}

.feedback-submit .el-button {
  min-width: 180px;
}

.command-card-footer {
  padding: 28px 48px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfc;
  display: flex;
  align-items: center;
  justify-content: space-between;
}</style>