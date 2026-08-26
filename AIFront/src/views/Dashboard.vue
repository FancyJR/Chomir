<template>
  <div class="page-dashboard">
    <!-- 欢迎横幅 -->
    <div class="welcome-banner">
      <div class="banner-content">
        <div class="banner-text">
          <div class="banner-greeting">{{ greeting }}，欢迎回来 👋</div>
          <div class="banner-title">后台管理系统</div>
          <div class="banner-subtitle">这里是你的数据总览，实时掌握系统运行状态与业务动态</div>
        </div>
        <div class="banner-date">
          <div class="date-day">{{ today.day }}</div>
          <div class="date-info">
            <div class="date-week">{{ today.week }}</div>
            <div class="date-full">{{ today.full }}</div>
          </div>
        </div>
      </div>
      <div class="banner-decoration"></div>
    </div>

    <!-- KPI 统计卡片 -->
    <el-row :gutter="16" class="kpi-row">
      <el-col :xs="12" :sm="12" :md="6" v-for="item in kpiCards" :key="item.label">
        <div class="kpi-card" :style="{ background: item.bg }">
          <div class="kpi-icon" :style="{ background: item.iconBg, color: item.color }">
            <i :class="item.icon"></i>
          </div>
          <div class="kpi-info">
            <div class="kpi-value">{{ item.value }}</div>
            <div class="kpi-label">{{ item.label }}</div>
            <div class="kpi-trend" :class="item.trend > 0 ? 'trend-up' : 'trend-down'">
              <i :class="item.trend > 0 ? 'el-icon-top' : 'el-icon-bottom'"></i>
              {{ Math.abs(item.trend) }}% 较上周
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 图表区 -->
    <el-row :gutter="16" class="chart-row">
      <el-col :xs="24" :sm="24" :md="14">
        <div class="panel-card">
          <div class="panel-header">
            <div class="panel-title">
              <i class="el-icon-data-line panel-title-icon"></i>
              访问量趋势
            </div>
            <div class="panel-actions">
              <el-radio-group v-model="visitRange" size="mini">
                <el-radio-button label="week">本周</el-radio-button>
                <el-radio-button label="month">本月</el-radio-button>
              </el-radio-group>
            </div>
          </div>
          <div class="chart-container" ref="visitChart"></div>
        </div>
      </el-col>
      <el-col :xs="24" :sm="24" :md="10">
        <div class="panel-card">
          <div class="panel-header">
            <div class="panel-title">
              <i class="el-icon-pie-chart panel-title-icon"></i>
              功能使用占比
            </div>
          </div>
          <div class="chart-container" ref="pieChart"></div>
        </div>
      </el-col>
    </el-row>

    <!-- 快捷入口 -->
    <div class="panel-card quick-panel">
      <div class="panel-header">
        <div class="panel-title">
          <i class="el-icon-magic-stick panel-title-icon"></i>
          快捷入口
        </div>
      </div>
      <div class="quick-grid">
        <div
          v-for="item in quickLinks"
          :key="item.path"
          class="quick-item"
          @click="$router.push(item.path)"
        >
          <div class="quick-icon" :style="{ background: item.bg, color: item.color }">
            <i :class="item.icon"></i>
          </div>
          <div class="quick-name">{{ item.name }}</div>
          <div class="quick-desc">{{ item.desc }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import * as echarts from 'echarts'

export default {
  name: 'Dashboard',
  data () {
    return {
      visitChart: null,
      pieChart: null,
      visitRange: 'week',
      today: {
        day: '',
        week: '',
        full: ''
      },
      kpiCards: [
        {
          label: '总用户数',
          value: '8,846',
          trend: 12.5,
          icon: 'el-icon-user',
          color: '#3b82f6',
          iconBg: 'rgba(59, 130, 246, 0.12)',
          bg: 'linear-gradient(135deg, #ffffff 0%, #f0f7ff 100%)'
        },
        {
          label: '今日访问量',
          value: '1,286',
          trend: 8.2,
          icon: 'el-icon-view',
          color: '#10b981',
          iconBg: 'rgba(16, 185, 129, 0.12)',
          bg: 'linear-gradient(135deg, #ffffff 0%, #ecfdf5 100%)'
        },
        {
          label: '订单数量',
          value: '3,420',
          trend: -3.1,
          icon: 'el-icon-shopping-cart-2',
          color: '#f59e0b',
          iconBg: 'rgba(245, 158, 11, 0.12)',
          bg: 'linear-gradient(135deg, #ffffff 0%, #fffbeb 100%)'
        },
        {
          label: '系统消息',
          value: '128',
          trend: 5.4,
          icon: 'el-icon-message',
          color: '#8b5cf6',
          iconBg: 'rgba(139, 92, 246, 0.12)',
          bg: 'linear-gradient(135deg, #ffffff 0%, #f5f3ff 100%)'
        }
      ],
      quickLinks: [
        { name: 'Panda 工作台', desc: '智能体编排与执行', icon: 'el-icon-cpu', path: '/panda', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)' },
        { name: '编排', desc: '可视化流程编排', icon: 'el-icon-connection', path: '/orchestration', color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
        { name: '指令市场', desc: '浏览与发布指令', icon: 'el-icon-s-operation', path: '/command-market', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
        { name: '今日股票推荐', desc: '强势标的量化筛选', icon: 'el-icon-star-on', path: '/today-stock-recommendation', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
        { name: '无代码开发', desc: '拖拽式应用构建', icon: 'el-icon-magic-stick', path: '/no-code', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' },
        { name: '足球数据统计', desc: '进球数据分析', icon: 'el-icon-data-analysis', path: '/football-goals-chart', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)' },
        { name: '篮球数据统计', desc: '篮球赛事数据', icon: 'el-icon-data-analysis', path: '/basketball-chart', color: '#f97316', bg: 'rgba(249, 115, 22, 0.12)' },
        { name: '期货预测', desc: '期货行情预测', icon: 'el-icon-trend-charts', path: '/futures-prediction', color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)' }
      ]
    }
  },
  computed: {
    greeting () {
      const h = new Date().getHours()
      if (h < 6) return '夜深了'
      if (h < 12) return '早上好'
      if (h < 14) return '中午好'
      if (h < 18) return '下午好'
      return '晚上好'
    }
  },
  mounted () {
    this.initDate()
    this.$nextTick(() => {
      this.initVisitChart()
      this.initPieChart()
    })
    window.addEventListener('resize', this.handleResize)
  },
  beforeDestroy () {
    window.removeEventListener('resize', this.handleResize)
    if (this.visitChart) this.visitChart.dispose()
    if (this.pieChart) this.pieChart.dispose()
  },
  methods: {
    initDate () {
      const now = new Date()
      const weeks = ['日', '一', '二', '三', '四', '五', '六']
      this.today = {
        day: String(now.getDate()).padStart(2, '0'),
        week: '星期' + weeks[now.getDay()],
        full: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
      }
    },
    initVisitChart () {
      const chartDom = this.$refs.visitChart
      if (!chartDom) return
      this.visitChart = echarts.init(chartDom)
      const option = {
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(255,255,255,0.95)',
          borderColor: '#e2e8f0',
          textStyle: { color: '#334155' }
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          top: '12%',
          containLabel: true
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisLabel: { color: '#64748b' }
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: '#f1f5f9' } },
          axisLabel: { color: '#64748b' }
        },
        series: [
          {
            name: '访问量',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            data: [120, 200, 150, 80, 70, 110, 130],
            lineStyle: {
              color: '#3b82f6',
              width: 3
            },
            itemStyle: {
              color: '#3b82f6',
              borderColor: '#fff',
              borderWidth: 2
            },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(59, 130, 246, 0.35)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0.02)' }
              ])
            }
          }
        ]
      }
      this.visitChart.setOption(option)
    },
    initPieChart () {
      const chartDom = this.$refs.pieChart
      if (!chartDom) return
      this.pieChart = echarts.init(chartDom)
      const option = {
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(255,255,255,0.95)',
          borderColor: '#e2e8f0',
          textStyle: { color: '#334155' }
        },
        legend: {
          bottom: '0%',
          left: 'center',
          icon: 'circle',
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: '#64748b' }
        },
        series: [
          {
            name: '功能使用',
            type: 'pie',
            radius: ['45%', '72%'],
            center: ['50%', '45%'],
            avoidLabelOverlap: false,
            itemStyle: {
              borderRadius: 8,
              borderColor: '#fff',
              borderWidth: 3
            },
            label: {
              show: false,
              position: 'center'
            },
            emphasis: {
              label: {
                show: true,
                fontSize: '18',
                fontWeight: 'bold',
                color: '#0f172a'
              }
            },
            labelLine: {
              show: false
            },
            data: [
              { value: 335, name: '用户管理' },
              { value: 310, name: '订单管理' },
              { value: 234, name: '数据分析' },
              { value: 135, name: '系统设置' },
              { value: 154, name: '消息中心' }
            ],
            color: ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444']
          }
        ]
      }
      this.pieChart.setOption(option)
    },
    handleResize () {
      if (this.visitChart) this.visitChart.resize()
      if (this.pieChart) this.pieChart.resize()
    }
  }
}
</script>

<style scoped>
.page-dashboard {
  padding: 24px 28px;
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(59, 130, 246, 0.12), transparent 60%),
    radial-gradient(1000px 400px at 90% 0%, rgba(99, 102, 241, 0.1), transparent 60%),
    linear-gradient(160deg, #eef4ff 0%, #e0ecff 40%, #d6e6ff 100%);
  min-height: calc(100vh - 84px);
  box-sizing: border-box;
}

/* 欢迎横幅 */
.welcome-banner {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  padding: 32px 36px;
  margin-bottom: 20px;
  background: linear-gradient(120deg, #3b82f6 0%, #6366f1 55%, #8b5cf6 100%);
  box-shadow: 0 12px 32px rgba(59, 130, 246, 0.25);
  color: #fff;
}

.banner-content {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.banner-greeting {
  font-size: 15px;
  opacity: 0.9;
  margin-bottom: 8px;
}

.banner-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 1px;
  margin-bottom: 10px;
}

.banner-subtitle {
  font-size: 14px;
  opacity: 0.85;
  max-width: 560px;
  line-height: 1.6;
}

.banner-date {
  display: flex;
  align-items: center;
  gap: 16px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 16px;
  padding: 14px 22px;
  backdrop-filter: blur(4px);
}

.date-day {
  font-size: 44px;
  font-weight: 800;
  line-height: 1;
}

.date-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.date-week {
  font-size: 16px;
  font-weight: 600;
}

.date-full {
  font-size: 13px;
  opacity: 0.85;
}

.banner-decoration {
  position: absolute;
  right: -60px;
  top: -60px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
}

.banner-decoration::after {
  content: '';
  position: absolute;
  right: 40px;
  top: 40px;
  width: 140px;
  height: 140px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
}

/* KPI 卡片 */
.kpi-row {
  margin-bottom: 20px;
}

.kpi-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 20px;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  margin-bottom: 16px;
  height: 100%;
  box-sizing: border-box;
}

.kpi-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.1);
}

.kpi-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
}

.kpi-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kpi-value {
  font-size: 26px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1.2;
}

.kpi-label {
  font-size: 13px;
  color: #64748b;
}

.kpi-trend {
  font-size: 12px;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.trend-up {
  color: #10b981;
}

.trend-down {
  color: #ef4444;
}

/* 面板卡片 */
.panel-card {
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
  padding: 20px 20px 16px;
  margin-bottom: 20px;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.panel-card:hover {
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.1);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-title-icon {
  color: #3b82f6;
  font-size: 18px;
}

.chart-row .el-col {
  display: flex;
  flex-direction: column;
}

.chart-row .panel-card {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.chart-container {
  flex: 1;
  height: 300px;
  min-height: 300px;
}

/* 快捷入口 */
.quick-panel {
  padding-bottom: 24px;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.quick-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px 12px;
  border-radius: 14px;
  border: 1px solid #f1f5f9;
  background: #fafbfc;
  cursor: pointer;
  transition: all 0.3s ease;
}

.quick-item:hover {
  transform: translateY(-4px);
  border-color: #3b82f6;
  background: #f0f7ff;
  box-shadow: 0 8px 20px rgba(59, 130, 246, 0.12);
}

.quick-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin-bottom: 12px;
}

.quick-name {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}

.quick-desc {
  font-size: 12px;
  color: #94a3b8;
}

@media (max-width: 992px) {
  .quick-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .page-dashboard {
    padding: 16px;
  }
  .welcome-banner {
    padding: 24px;
  }
  .banner-content {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  .banner-title {
    font-size: 24px;
  }
  .quick-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .chart-container {
    height: 240px;
    min-height: 240px;
  }
}
</style>
