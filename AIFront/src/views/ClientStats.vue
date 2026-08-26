<template>
  <div class="client-stats-container">
    <div class="page-hero">
      <div class="hero-badge"><i class="el-icon-monitor"></i> 埋点统计</div>
      <h1 class="hero-title">客户端统计</h1>
      <p class="hero-subtitle">登录人 · 登录时间 · 退出时间 · 在线时长 实时埋点分析</p>
    </div>

    <!-- 顶部统计卡 -->
    <el-row :gutter="20" class="stat-row">
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon icon-blue"><i class="el-icon-user"></i></div>
          <div class="stat-body">
            <div class="stat-title">总登录人次</div>
            <div class="stat-value">{{ stats.totalLogins }}</div>
            <div class="stat-sub">累计埋点记录</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon icon-green"><i class="el-icon-video-camera"></i></div>
          <div class="stat-body">
            <div class="stat-title">当前在线</div>
            <div class="stat-value">{{ stats.online }}</div>
            <div class="stat-sub">未退出用户</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon icon-orange"><i class="el-icon-time"></i></div>
          <div class="stat-body">
            <div class="stat-title">平均在线时长</div>
            <div class="stat-value">{{ stats.avgDuration }}</div>
            <div class="stat-sub">分钟 / 人次</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon icon-purple"><i class="el-icon-date"></i></div>
          <div class="stat-body">
            <div class="stat-title">今日登录</div>
            <div class="stat-value">{{ stats.todayLogins }}</div>
            <div class="stat-sub">今日新增埋点</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 操作区 -->
    <el-card class="main-card">
      <div slot="header" class="card-header">
        <span class="card-title"><i class="el-icon-aim"></i> 埋点操作</span>
        <div class="header-actions">
          <el-button type="primary" icon="el-icon-plus" @click="openLoginDialog">模拟登录</el-button>
          <el-button type="warning" plain icon="el-icon-switch-button" @click="simulateLogout">模拟退出</el-button>
          <el-button type="danger" plain icon="el-icon-delete" @click="clearRecords">清空记录</el-button>
        </div>
      </div>
      <div class="track-tip">
        <i class="el-icon-info"></i>
        页面加载时已自动为当前用户（Admin）记录一次登录埋点。点击「模拟登录」可录入其他用户，点击「模拟退出」结束最近一次在线会话。
      </div>
    </el-card>

    <!-- D3 图表区 -->
    <el-row :gutter="20" class="chart-row">
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="card-header">
            <span class="card-title"><i class="el-icon-data-line"></i> 在线时长分布</span>
          </div>
          <div id="durationChart" ref="durationChart" class="d3-chart"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="card-header">
            <span class="card-title"><i class="el-icon-time"></i> 登录时段分布</span>
          </div>
          <div id="hourChart" ref="hourChart" class="d3-chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 登录记录表格 -->
    <el-card class="main-card">
      <div slot="header" class="card-header">
        <span class="card-title"><i class="el-icon-tickets"></i> 登录记录明细</span>
        <div class="header-actions">
          <el-input
            v-model="keyword"
            size="small"
            placeholder="搜索登录人"
            prefix-icon="el-icon-search"
            style="width: 200px;"
          ></el-input>
        </div>
      </div>
      <el-table :data="filteredRecords" border stripe style="width: 100%">
        <el-table-column prop="user" label="登录人" width="140">
          <template slot-scope="scope">
            <span class="user-cell"><i class="el-icon-user"></i> {{ scope.row.user }}</span>
          </template>
        </el-table-column>
        <el-table-column label="登录时间" width="180">
          <template slot-scope="scope">{{ formatTime(scope.row.loginTime) }}</template>
        </el-table-column>
        <el-table-column label="退出时间" width="180">
          <template slot-scope="scope">
            <span v-if="scope.row.logoutTime">{{ formatTime(scope.row.logoutTime) }}</span>
            <el-tag v-else type="success" size="mini">在线中</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="在线时长" width="140">
          <template slot-scope="scope">
            <span v-if="scope.row.duration != null">{{ formatDuration(scope.row.duration) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template slot-scope="scope">
            <el-tag :type="scope.row.logoutTime ? 'info' : 'success'" size="mini">
              {{ scope.row.logoutTime ? '已退出' : '在线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template slot-scope="scope">
            <el-button
              v-if="!scope.row.logoutTime"
              type="text"
              size="small"
              @click="logoutRecord(scope.row)"
            >退出</el-button>
            <el-button v-else type="text" size="small" disabled>已完成</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 模拟登录对话框 -->
    <el-dialog title="模拟登录埋点" :visible.sync="loginDialogVisible" width="420px">
      <el-form label-width="80px">
        <el-form-item label="登录人">
          <el-input v-model="newUser" placeholder="请输入用户名"></el-input>
        </el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="loginDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmLogin">确认登录</el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
import * as d3 from 'd3'

const STORAGE_KEY = 'client_stats_records'

export default {
  name: 'ClientStats',
  data () {
    return {
      records: [],
      keyword: '',
      loginDialogVisible: false,
      newUser: '',
      durationChart: null,
      hourChart: null
    }
  },
  computed: {
    stats () {
      const total = this.records.length
      const online = this.records.filter(r => !r.logoutTime).length
      const done = this.records.filter(r => r.duration != null)
      const avg = done.length
        ? Math.round(done.reduce((s, r) => s + r.duration, 0) / done.length)
        : 0
      const today = new Date().toDateString()
      const todayLogins = this.records.filter(r => new Date(r.loginTime).toDateString() === today).length
      return {
        totalLogins: total,
        online,
        avgDuration: avg,
        todayLogins
      }
    },
    filteredRecords () {
      const kw = this.keyword.trim().toLowerCase()
      if (!kw) return this.records
      return this.records.filter(r => r.user.toLowerCase().includes(kw))
    }
  },
  mounted () {
    this.loadRecords()
    // 页面加载自动埋点：当前用户登录
    this.autoTrackLogin()
    this.$nextTick(() => {
      this.renderCharts()
    })
  },
  beforeDestroy () {
    if (this.durationChart) this.durationChart.remove()
    if (this.hourChart) this.hourChart.remove()
  },
  methods: {
    loadRecords () {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        this.records = raw ? JSON.parse(raw) : []
      } catch (e) {
        this.records = []
      }
    },
    saveRecords () {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records))
    },
    autoTrackLogin () {
      // 避免重复自动埋点（同一会话只记一次）
      const sessionKey = 'client_stats_session_tracked'
      if (sessionStorage.getItem(sessionKey)) return
      sessionStorage.setItem(sessionKey, '1')
      this.records.unshift({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        user: 'Admin',
        loginTime: Date.now(),
        logoutTime: null,
        duration: null
      })
      this.saveRecords()
      this.renderCharts()
    },
    openLoginDialog () {
      this.newUser = ''
      this.loginDialogVisible = true
    },
    confirmLogin () {
      const name = this.newUser.trim()
      if (!name) {
        this.$message.warning('请输入登录人姓名')
        return
      }
      this.records.unshift({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        user: name,
        loginTime: Date.now(),
        logoutTime: null,
        duration: null
      })
      this.saveRecords()
      this.loginDialogVisible = false
      this.$message.success(`已为「${name}」记录登录埋点`)
      this.renderCharts()
    },
    simulateLogout () {
      const online = this.records.find(r => !r.logoutTime)
      if (!online) {
        this.$message.info('当前没有在线会话')
        return
      }
      this.logoutRecord(online)
    },
    logoutRecord (record) {
      const now = Date.now()
      record.logoutTime = now
      record.duration = Math.round((now - record.loginTime) / 60000)
      this.saveRecords()
      this.$message.success(`「${record.user}」已退出，在线时长 ${this.formatDuration(record.duration)}`)
      this.renderCharts()
    },
    clearRecords () {
      this.$confirm('确定清空所有埋点记录吗？', '提示', {
        confirmButtonText: '清空',
        cancelButtonText: '取消',
        type: 'warning'
      }).then(() => {
        this.records = []
        this.saveRecords()
        this.$message.success('已清空')
        this.renderCharts()
      }).catch(() => {})
    },
    formatTime (ts) {
      const d = new Date(ts)
      const p = n => (n < 10 ? '0' + n : n)
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    },
    formatDuration (min) {
      if (min < 1) return '<1 分钟'
      if (min < 60) return `${min} 分钟`
      const h = Math.floor(min / 60)
      const m = min % 60
      return m ? `${h} 小时 ${m} 分` : `${h} 小时`
    },
    renderCharts () {
      this.renderDurationChart()
      this.renderHourChart()
    },
    renderDurationChart () {
      const el = this.$refs.durationChart
      if (!el) return
      if (this.durationChart) this.durationChart.remove()
      const width = el.clientWidth || 520
      const height = 320
      const margin = { top: 30, right: 30, bottom: 50, left: 50 }
      const innerW = width - margin.left - margin.right
      const innerH = height - margin.top - margin.bottom

      // 在线时长分桶（分钟）：<5, 5-15, 15-30, 30-60, 60-120, >120
      const buckets = [
        { label: '<5分', min: 0, max: 5 },
        { label: '5-15分', min: 5, max: 15 },
        { label: '15-30分', min: 15, max: 30 },
        { label: '30-60分', min: 30, max: 60 },
        { label: '1-2小时', min: 60, max: 120 },
        { label: '>2小时', min: 120, max: Infinity }
      ]
      const done = this.records.filter(r => r.duration != null)
      const data = buckets.map(b => ({
        label: b.label,
        count: done.filter(r => r.duration >= b.min && r.duration < b.max).length
      }))

      const svg = d3.select(el).append('svg')
        .attr('width', width)
        .attr('height', height)

      const x = d3.scaleBand()
        .domain(data.map(d => d.label))
        .range([0, innerW])
        .padding(0.3)
      const y = d3.scaleLinear()
        .domain([0, d3.max(data, d => d.count) || 1])
        .nice()
        .range([innerH, 0])

      const g = svg.append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`)

      // 网格线
      g.append('g')
        .attr('class', 'grid')
        .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''))
        .selectAll('line')
        .attr('stroke', 'rgba(56,189,248,0.12)')
      g.selectAll('.domain').attr('stroke', 'rgba(56,189,248,0.25)')

      // 坐标轴
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x))
        .selectAll('text')
        .attr('fill', '#94a3b8')
        .attr('font-size', '11px')
      g.append('g')
        .call(d3.axisLeft(y).ticks(5))
        .selectAll('text')
        .attr('fill', '#94a3b8')
        .attr('font-size', '11px')

      // 柱状图（渐变 + 发光）
      const grad = svg.append('defs').append('linearGradient')
        .attr('id', 'durGrad')
        .attr('x1', '0%').attr('y1', '0%')
        .attr('x2', '0%').attr('y2', '100%')
      grad.append('stop').attr('offset', '0%').attr('stop-color', '#38bdf8').attr('stop-opacity', 1)
      grad.append('stop').attr('offset', '100%').attr('stop-color', '#0ea5e9').attr('stop-opacity', 0.4)

      g.selectAll('.bar')
        .data(data)
        .enter()
        .append('rect')
        .attr('class', 'bar')
        .attr('x', d => x(d.label))
        .attr('width', x.bandwidth())
        .attr('y', d => y(d.count))
        .attr('height', d => innerH - y(d.count))
        .attr('rx', 6)
        .attr('fill', 'url(#durGrad)')
        .style('filter', 'drop-shadow(0 0 6px rgba(56,189,248,0.5))')

      // 数值标签
      g.selectAll('.bar-label')
        .data(data)
        .enter()
        .append('text')
        .attr('class', 'bar-label')
        .attr('x', d => x(d.label) + x.bandwidth() / 2)
        .attr('y', d => y(d.count) - 6)
        .attr('text-anchor', 'middle')
        .attr('fill', '#e2f3ff')
        .attr('font-size', '12px')
        .text(d => d.count)
    },
    renderHourChart () {
      const el = this.$refs.hourChart
      if (!el) return
      if (this.hourChart) this.hourChart.remove()
      const width = el.clientWidth || 520
      const height = 320
      const margin = { top: 30, right: 30, bottom: 50, left: 50 }
      const innerW = width - margin.left - margin.right
      const innerH = height - margin.top - margin.bottom

      // 按小时统计登录次数
      const hours = Array.from({ length: 24 }, (_, i) => i)
      const data = hours.map(h => ({
        hour: h,
        count: this.records.filter(r => new Date(r.loginTime).getHours() === h).length
      }))

      const svg = d3.select(el).append('svg')
        .attr('width', width)
        .attr('height', height)

      const x = d3.scaleLinear()
        .domain([0, 23])
        .range([0, innerW])
      const y = d3.scaleLinear()
        .domain([0, d3.max(data, d => d.count) || 1])
        .nice()
        .range([innerH, 0])

      const g = svg.append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`)

      // 网格线
      g.append('g')
        .attr('class', 'grid')
        .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''))
        .selectAll('line')
        .attr('stroke', 'rgba(56,189,248,0.12)')
      g.selectAll('.domain').attr('stroke', 'rgba(56,189,248,0.25)')

      // 面积渐变
      const area = d3.area()
        .x(d => x(d.hour))
        .y0(innerH)
        .y1(d => y(d.count))
        .curve(d3.curveMonotoneX)

      const line = d3.line()
        .x(d => x(d.hour))
        .y(d => y(d.count))
        .curve(d3.curveMonotoneX)

      const grad = svg.append('defs').append('linearGradient')
        .attr('id', 'hourGrad')
        .attr('x1', '0%').attr('y1', '0%')
        .attr('x2', '0%').attr('y2', '100%')
      grad.append('stop').attr('offset', '0%').attr('stop-color', '#22d3ee').attr('stop-opacity', 0.5)
      grad.append('stop').attr('offset', '100%').attr('stop-color', '#22d3ee').attr('stop-opacity', 0.02)

      g.append('path')
        .datum(data)
        .attr('d', area)
        .attr('fill', 'url(#hourGrad)')

      g.append('path')
        .datum(data)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', '#22d3ee')
        .attr('stroke-width', 2.5)
        .style('filter', 'drop-shadow(0 0 6px rgba(34,211,238,0.6))')

      // 数据点
      g.selectAll('.dot')
        .data(data)
        .enter()
        .append('circle')
        .attr('class', 'dot')
        .attr('cx', d => x(d.hour))
        .attr('cy', d => y(d.count))
        .attr('r', 3.5)
        .attr('fill', '#22d3ee')
        .style('filter', 'drop-shadow(0 0 4px rgba(34,211,238,0.8))')

      // X 轴（每 3 小时一个刻度）
      const xAxis = d3.axisBottom(x)
        .tickValues([0, 3, 6, 9, 12, 15, 18, 21, 23])
        .tickFormat(d => d + '时')
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(xAxis)
        .selectAll('text')
        .attr('fill', '#94a3b8')
        .attr('font-size', '11px')
      g.append('g')
        .call(d3.axisLeft(y).ticks(5))
        .selectAll('text')
        .attr('fill', '#94a3b8')
        .attr('font-size', '11px')
    }
  }
}
</script>

<style scoped>
.client-stats-container {
  padding: 24px;
  min-height: 100vh;
  background: linear-gradient(135deg, #0a0e1a 0%, #0d1428 40%, #0a1122 100%);
  background-attachment: fixed;
  box-sizing: border-box;
}

.page-hero {
  text-align: center;
  padding: 24px 0 28px;
}

.hero-badge {
  display: inline-block;
  padding: 4px 16px;
  border-radius: 20px;
  font-size: 13px;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  border: 1px solid rgba(56, 189, 248, 0.3);
  margin-bottom: 12px;
}

.hero-title {
  font-size: 30px;
  font-weight: 700;
  color: #e2f3ff;
  margin: 0 0 8px;
  letter-spacing: 1px;
  text-shadow: 0 0 20px rgba(56, 189, 248, 0.35);
}

.hero-subtitle {
  color: #94a3b8;
  font-size: 14px;
  margin: 0;
}

.stat-row {
  margin-bottom: 20px;
}

.stat-card {
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(56, 189, 248, 0.15);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 30px rgba(56, 189, 248, 0.2);
}

.stat-icon {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
}

.icon-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
.icon-green { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.icon-orange { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
.icon-purple { background: rgba(167, 139, 250, 0.15); color: #a78bfa; }

.stat-title {
  color: #94a3b8;
  font-size: 13px;
  margin-bottom: 4px;
}

.stat-value {
  color: #e2f3ff;
  font-size: 26px;
  font-weight: 700;
  text-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
}

.stat-sub {
  color: #64748b;
  font-size: 12px;
  margin-top: 2px;
}

.main-card,
.chart-card {
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(56, 189, 248, 0.15);
  border-radius: 12px;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  color: #e2f3ff;
  font-size: 15px;
  font-weight: 600;
}

.card-title i {
  color: #38bdf8;
  margin-right: 6px;
}

.track-tip {
  color: #94a3b8;
  font-size: 13px;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 8px;
  padding: 10px 14px;
}

.track-tip i {
  color: #38bdf8;
  margin-right: 6px;
}

.chart-row {
  margin-bottom: 0;
}

.d3-chart {
  width: 100%;
  height: 320px;
}

.user-cell {
  color: #e2f3ff;
}

.muted {
  color: #64748b;
}

/* ElementUI 深色适配 */
.client-stats-container >>> .el-card__header {
  border-bottom: 1px solid rgba(56, 189, 248, 0.15);
}

.client-stats-container >>> .el-table {
  background: transparent;
  color: #cbd5e1;
}

.client-stats-container >>> .el-table th {
  background: rgba(56, 189, 248, 0.08);
  color: #e2f3ff;
  border-bottom: 1px solid rgba(56, 189, 248, 0.15);
}

.client-stats-container >>> .el-table td {
  border-bottom: 1px solid rgba(56, 189, 248, 0.08);
}

.client-stats-container >>> .el-table--striped .el-table__body tr.el-table__row--striped td {
  background: rgba(56, 189, 248, 0.04);
}

.client-stats-container >>> .el-table__body tr:hover > td {
  background: rgba(56, 189, 248, 0.08) !important;
}

.client-stats-container >>> .el-table::before {
  background-color: rgba(56, 189, 248, 0.15);
}

.client-stats-container >>> .el-input__inner {
  background: rgba(15, 23, 42, 0.6);
  border-color: rgba(56, 189, 248, 0.2);
  color: #e2f3ff;
}

.client-stats-container >>> .el-input__inner::placeholder {
  color: #64748b;
}

.client-stats-container >>> .el-dialog {
  background: #0d1428;
}

.client-stats-container >>> .el-dialog__title {
  color: #e2f3ff;
}

.client-stats-container >>> .el-dialog__body {
  color: #cbd5e1;
}
</style>
