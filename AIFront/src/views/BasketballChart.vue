<template>
  <div class="basketball-chart-container">
    <el-row :gutter="20">
      <el-col :span="24">
        <el-card class="header-card">
          <div slot="header" class="clearfix">
            <span class="header-title">{{ routeTitle }}</span>
            <el-button style="float: right; padding: 3px 0" type="text" @click="refreshData">刷新数据</el-button>
          </div>
          <div class="description">{{ description }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="chart-row">
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="clearfix">
            <span>场均得分统计</span>
          </div>
          <div ref="scoreChart" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="clearfix">
            <span>篮板统计</span>
          </div>
          <div ref="reboundChart" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="chart-row">
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="clearfix">
            <span>助攻统计</span>
          </div>
          <div ref="assistChart" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="chart-card">
          <div slot="header" class="clearfix">
            <span>三分命中率</span>
          </div>
          <div ref="threePointChart" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="table-row">
      <el-col :span="24">
        <el-card class="table-card">
          <div slot="header" class="clearfix">
            <span>详细数据表</span>
            <el-button style="float: right; padding: 3px 0" type="text" @click="exportData">导出数据</el-button>
          </div>
          <el-table :data="tableData" border style="width: 100%">
            <el-table-column prop="player" label="球员" width="150"></el-table-column>
            <el-table-column prop="team" label="球队" width="120"></el-table-column>
            <el-table-column prop="score" label="场均得分" sortable width="100"></el-table-column>
            <el-table-column prop="rebound" label="场均篮板" sortable width="100"></el-table-column>
            <el-table-column prop="assist" label="场均助攻" sortable width="100"></el-table-column>
            <el-table-column prop="threePointRate" label="三分命中率" sortable width="120">
              <template slot-scope="scope">
                {{ scope.row.threePointRate }}%
              </template>
            </el-table-column>
            <el-table-column prop="games" label="出场次数" sortable width="100"></el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template slot-scope="scope">
                <el-tag :type="scope.row.status === '活跃' ? 'success' : 'info'">{{ scope.row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script>
import echarts from 'echarts'

export default {
  name: 'BasketballChart',
  data() {
    return {
      routeTitle: '篮球统计',
      description: '篮球统计页面，基于足球统计页面（FootballGoalsChart）的规则和样式创建，用于展示篮球相关统计数据',
      scoreChart: null,
      reboundChart: null,
      assistChart: null,
      threePointChart: null,
      tableData: [
        { player: '勒布朗·詹姆斯', team: '湖人', score: 28.5, rebound: 8.2, assist: 9.8, threePointRate: 35.2, games: 65, status: '活跃' },
        { player: '斯蒂芬·库里', team: '勇士', score: 30.1, rebound: 5.5, assist: 6.2, threePointRate: 42.5, games: 70, status: '活跃' },
        { player: '凯文·杜兰特', team: '太阳', score: 29.8, rebound: 7.1, assist: 5.8, threePointRate: 38.7, games: 62, status: '活跃' },
        { player: '扬尼斯·阿德托昆博', team: '雄鹿', score: 31.2, rebound: 11.8, assist: 5.7, threePointRate: 28.5, games: 68, status: '活跃' },
        { player: '卢卡·东契奇', team: '独行侠', score: 32.4, rebound: 8.6, assist: 8.0, threePointRate: 34.8, games: 72, status: '活跃' },
        { player: '尼古拉·约基奇', team: '掘金', score: 26.4, rebound: 12.4, assist: 9.0, threePointRate: 33.7, games: 74, status: '活跃' },
        { player: '乔尔·恩比德', team: '76人', score: 33.1, rebound: 10.2, assist: 4.2, threePointRate: 33.0, games: 66, status: '活跃' },
        { player: '杰森·塔图姆', team: '凯尔特人', score: 30.1, rebound: 8.8, assist: 4.6, threePointRate: 35.0, games: 74, status: '活跃' }
      ]
    }
  },
  mounted() {
    this.initCharts()
    window.addEventListener('resize', this.handleResize)
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.handleResize)
    if (this.scoreChart) {
      this.scoreChart.dispose()
    }
    if (this.reboundChart) {
      this.reboundChart.dispose()
    }
    if (this.assistChart) {
      this.assistChart.dispose()
    }
    if (this.threePointChart) {
      this.threePointChart.dispose()
    }
  },
  methods: {
    initCharts() {
      this.scoreChart = echarts.init(this.$refs.scoreChart)
      this.reboundChart = echarts.init(this.$refs.reboundChart)
      this.assistChart = echarts.init(this.$refs.assistChart)
      this.threePointChart = echarts.init(this.$refs.threePointChart)

      const players = this.tableData.map(item => item.player)
      const scores = this.tableData.map(item => item.score)
      const rebounds = this.tableData.map(item => item.rebound)
      const assists = this.tableData.map(item => item.assist)
      const threePointRates = this.tableData.map(item => item.threePointRate)

      const scoreOption = {
        title: {
          text: '场均得分',
          left: 'center'
        },
        tooltip: {},
        xAxis: {
          type: 'category',
          data: players,
          axisLabel: {
            rotate: 45
          }
        },
        yAxis: {
          type: 'value',
          name: '得分'
        },
        series: [
          {
            name: '场均得分',
            type: 'bar',
            data: scores,
            itemStyle: {
              color: '#409EFF'
            }
          }
        ]
      }

      const reboundOption = {
        title: {
          text: '场均篮板',
          left: 'center'
        },
        tooltip: {},
        xAxis: {
          type: 'category',
          data: players,
          axisLabel: {
            rotate: 45
          }
        },
        yAxis: {
          type: 'value',
          name: '篮板'
        },
        series: [
          {
            name: '场均篮板',
            type: 'bar',
            data: rebounds,
            itemStyle: {
              color: '#67C23A'
            }
          }
        ]
      }

      const assistOption = {
        title: {
          text: '场均助攻',
          left: 'center'
        },
        tooltip: {},
        xAxis: {
          type: 'category',
          data: players,
          axisLabel: {
            rotate: 45
          }
        },
        yAxis: {
          type: 'value',
          name: '助攻'
        },
        series: [
          {
            name: '场均助攻',
            type: 'bar',
            data: assists,
            itemStyle: {
              color: '#E6A23C'
            }
          }
        ]
      }

      const threePointOption = {
        title: {
          text: '三分命中率',
          left: 'center'
        },
        tooltip: {
          formatter: '{b}: {c}%'
        },
        xAxis: {
          type: 'category',
          data: players,
          axisLabel: {
            rotate: 45
          }
        },
        yAxis: {
          type: 'value',
          name: '命中率(%)'
        },
        series: [
          {
            name: '三分命中率',
            type: 'line',
            data: threePointRates,
            itemStyle: {
              color: '#F56C6C'
            },
            lineStyle: {
              width: 3
            }
          }
        ]
      }

      this.scoreChart.setOption(scoreOption)
      this.reboundChart.setOption(reboundOption)
      this.assistChart.setOption(assistOption)
      this.threePointChart.setOption(threePointOption)
    },
    handleResize() {
      if (this.scoreChart) {
        this.scoreChart.resize()
      }
      if (this.reboundChart) {
        this.reboundChart.resize()
      }
      if (this.assistChart) {
        this.assistChart.resize()
      }
      if (this.threePointChart) {
        this.threePointChart.resize()
      }
    },
    refreshData() {
      this.$message({
        message: '数据已刷新',
        type: 'success'
      })
      // 这里可以模拟数据更新，例如随机调整一些值
      this.tableData.forEach(item => {
        item.score = (item.score + Math.random() * 2 - 1).toFixed(1)
        item.rebound = (item.rebound + Math.random() * 1 - 0.5).toFixed(1)
        item.assist = (item.assist + Math.random() * 1 - 0.5).toFixed(1)
        item.threePointRate = (item.threePointRate + Math.random() * 2 - 1).toFixed(1)
      })
      this.initCharts() // 重新初始化图表以更新数据
    },
    exportData() {
      this.$message({
        message: '数据导出功能模拟（实际需后端支持）',
        type: 'info'
      })
      // 这里可以添加导出逻辑，例如生成CSV或调用API
    }
  }
}
</script>

<style scoped>
.basketball-chart-container {
  padding: 20px;
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(59, 130, 246, 0.15), transparent 60%),
    radial-gradient(1000px 400px at 90% 0%, rgba(99, 102, 241, 0.12), transparent 60%),
    linear-gradient(160deg, #eef4ff 0%, #e0ecff 40%, #d6e6ff 100%);
  min-height: 100vh;
}

.header-card {
  margin-bottom: 20px;
}

.header-title {
  font-size: 20px;
  font-weight: bold;
  color: #303133;
}

.description {
  font-size: 14px;
  color: #606266;
  line-height: 1.5;
}

.chart-row {
  margin-bottom: 20px;
}

.chart-card {
  height: 400px;
}

.chart {
  width: 100%;
  height: 320px;
}

.table-row {
  margin-top: 20px;
}

.table-card {
  margin-bottom: 20px;
}

.clearfix:before,
.clearfix:after {
  display: table;
  content: "";
}
.clearfix:after {
  clear: both;
}
</style>