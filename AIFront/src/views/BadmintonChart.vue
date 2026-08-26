<template>
  <div class="badminton-chart-container">
    <el-card class="chart-card">
      <div slot="header" class="clearfix">
        <span>山寨版Cursor</span>
        <el-button style="float: right; padding: 3px 0" type="text"
          >帮助</el-button
        >
      </div>
      <div class="filter-section">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-select
              v-model="selectedPlayer"
              placeholder="选择球员"
              clearable
            >
              <el-option
                v-for="player in playerList"
                :key="player.id"
                :label="player.name"
                :value="player.id"
              ></el-option>
            </el-select>
          </el-col>
          <el-col :span="6">
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="yyyy-MM-dd"
            ></el-date-picker>
          </el-col>
          <el-col :span="6">
            <el-select
              v-model="selectedTournament"
              placeholder="选择赛事"
              clearable
            >
              <el-option
                v-for="tournament in tournamentList"
                :key="tournament.id"
                :label="tournament.name"
                :value="tournament.id"
              ></el-option>
            </el-select>
          </el-col>
          <el-col :span="6">
            <el-button type="primary" @click="fetchData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-col>
        </el-row>
      </div>
      <div class="chart-section">
        <div class="chart-wrapper">
          <div ref="chart" style="width: 100%; height: 400px"></div>
        </div>
      </div>
      <div class="data-table-section">
        <el-table :data="tableData" border style="width: 100%">
          <el-table-column
            prop="date"
            label="日期"
            width="180"
          ></el-table-column>
          <el-table-column
            prop="player"
            label="球员"
            width="120"
          ></el-table-column>
          <el-table-column
            prop="tournament"
            label="赛事"
            width="150"
          ></el-table-column>
          <el-table-column
            prop="matchesPlayed"
            label="比赛场次"
            width="100"
          ></el-table-column>
          <el-table-column
            prop="wins"
            label="胜场"
            width="80"
          ></el-table-column>
          <el-table-column
            prop="losses"
            label="负场"
            width="80"
          ></el-table-column>
          <el-table-column
            prop="pointsScored"
            label="得分"
            width="80"
          ></el-table-column>
          <el-table-column
            prop="pointsConceded"
            label="失分"
            width="80"
          ></el-table-column>
          <el-table-column
            prop="smashSuccessRate"
            label="扣杀成功率"
            width="120"
          ></el-table-column>
          <el-table-column
            prop="serveSuccessRate"
            label="发球成功率"
            width="120"
          ></el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>

<script>
import * as echarts from 'echarts'

export default {
  name: 'BadmintonChart',
  data() {
    return {
      selectedPlayer: '',
      selectedTournament: '',
      dateRange: [],
      playerList: [
        { id: 1, name: '林丹' },
        { id: 2, name: '李宗伟' },
        { id: 3, name: '谌龙' },
        { id: 4, name: '桃田贤斗' },
        { id: 5, name: '安赛龙' }
      ],
      tournamentList: [
        { id: 1, name: '全英公开赛' },
        { id: 2, name: '世锦赛' },
        { id: 3, name: '奥运会' },
        { id: 4, name: '亚运会' },
        { id: 5, name: '汤姆斯杯' }
      ],
      tableData: [],
      chartInstance: null
    }
  },
  mounted() {
    this.initChart()
    this.fetchData()
  },
  beforeDestroy() {
    if (this.chartInstance) {
      this.chartInstance.dispose()
    }
  },
  methods: {
    initChart() {
      this.chartInstance = echarts.init(this.$refs.chart)
      const option = {
        title: {
          text: '羽毛球球员数据统计',
          left: 'center'
        },
        tooltip: {
          trigger: 'axis'
        },
        legend: {
          data: ['胜场', '负场', '得分', '失分'],
          top: 30
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: []
        },
        yAxis: {
          type: 'value'
        },
        series: [
          {
            name: '胜场',
            type: 'line',
            stack: 'Total',
            data: []
          },
          {
            name: '负场',
            type: 'line',
            stack: 'Total',
            data: []
          },
          {
            name: '得分',
            type: 'bar',
            data: []
          },
          {
            name: '失分',
            type: 'bar',
            data: []
          }
        ]
      }
      this.chartInstance.setOption(option)
    },
    fetchData() {
      // Mock 数据
      const mockData = [
        {
          date: '2023-01-15',
          player: '林丹',
          tournament: '全英公开赛',
          matchesPlayed: 5,
          wins: 4,
          losses: 1,
          pointsScored: 105,
          pointsConceded: 89,
          smashSuccessRate: '75%',
          serveSuccessRate: '88%'
        },
        {
          date: '2023-02-20',
          player: '李宗伟',
          tournament: '世锦赛',
          matchesPlayed: 6,
          wins: 5,
          losses: 1,
          pointsScored: 120,
          pointsConceded: 95,
          smashSuccessRate: '72%',
          serveSuccessRate: '85%'
        },
        {
          date: '2023-03-10',
          player: '谌龙',
          tournament: '奥运会',
          matchesPlayed: 4,
          wins: 3,
          losses: 1,
          pointsScored: 98,
          pointsConceded: 80,
          smashSuccessRate: '78%',
          serveSuccessRate: '90%'
        },
        {
          date: '2023-04-05',
          player: '桃田贤斗',
          tournament: '亚运会',
          matchesPlayed: 7,
          wins: 6,
          losses: 1,
          pointsScored: 130,
          pointsConceded: 110,
          smashSuccessRate: '80%',
          serveSuccessRate: '92%'
        },
        {
          date: '2023-05-12',
          player: '安赛龙',
          tournament: '汤姆斯杯',
          matchesPlayed: 5,
          wins: 4,
          losses: 1,
          pointsScored: 112,
          pointsConceded: 96,
          smashSuccessRate: '77%',
          serveSuccessRate: '87%'
        }
      ]
      this.tableData = mockData
      this.updateChart(mockData)
    },
    updateChart(data) {
      const dates = data.map((item) => item.date)
      const wins = data.map((item) => item.wins)
      const losses = data.map((item) => item.losses)
      const pointsScored = data.map((item) => item.pointsScored)
      const pointsConceded = data.map((item) => item.pointsConceded)

      const option = {
        xAxis: {
          data: dates
        },
        series: [
          { data: wins },
          { data: losses },
          { data: pointsScored },
          { data: pointsConceded }
        ]
      }
      this.chartInstance.setOption(option)
    },
    resetFilters() {
      this.selectedPlayer = ''
      this.selectedTournament = ''
      this.dateRange = []
      this.fetchData()
    }
  }
}
</script>

<style scoped>
.badminton-chart-container {
  padding: 20px;
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(59, 130, 246, 0.15), transparent 60%),
    radial-gradient(1000px 400px at 90% 0%, rgba(99, 102, 241, 0.12), transparent 60%),
    linear-gradient(160deg, #eef4ff 0%, #e0ecff 40%, #d6e6ff 100%);
  min-height: 100vh;
}

.chart-card {
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.clearfix:before,
.clearfix:after {
  display: table;
  content: '';
}
.clearfix:after {
  clear: both;
}

.filter-section {
  margin-bottom: 20px;
}

.chart-section {
  margin-bottom: 30px;
}

.chart-wrapper {
  background-color: #fff;
  padding: 20px;
  border-radius: 4px;
  border: 1px solid #ebeef5;
}

.data-table-section {
  margin-top: 20px;
}
</style>
