<template>
  <div class="futures-prediction">
    <el-container>
      <el-header>
        <h1>期货预测</h1>
        <p class="subtitle">基于历史数据和模型分析的期货价格预测</p>
      </el-header>
      <el-main>
        <div v-if="pageError" class="error-container">
          <el-result icon="error" title="页面加载失败" :sub-title="errorMessage">
            <template #extra>
              <el-button type="primary" @click="retryLoadPage">重试</el-button>
            </template>
          </el-result>
        </div>
        <template v-else-if="!pageLoading">
          <el-row :gutter="20" v-loading="contentLoading">
            <el-col :span="16">
              <el-card class="chart-card">
                <div slot="header">
                  <span>期货价格趋势预测</span>
                  <el-select v-model="selectedFuture" placeholder="选择期货品种" size="small" style="float: right; width: 150px">
                    <el-option v-for="item in futuresOptions" :key="item.value" :label="item.label" :value="item.value"></el-option>
                  </el-select>
                </div>
                <div ref="chartContainer" style="height: 400px"></div>
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card class="prediction-card">
                <div slot="header">
                  <span>预测结果</span>
                </div>
                <div class="prediction-content">
                  <div class="prediction-item">
                    <span class="label">当前价格：</span>
                    <span class="value">{{ currentPrice }}</span>
                  </div>
                  <div class="prediction-item">
                    <span class="label">预测价格：</span>
                    <span class="value" :class="{ 'up': predictionTrend === 'up', 'down': predictionTrend === 'down' }">{{ predictedPrice }}</span>
                  </div>
                  <div class="prediction-item">
                    <span class="label">预测趋势：</span>
                    <el-tag :type="predictionTrend === 'up' ? 'success' : 'danger'">{{ predictionText }}</el-tag>
                  </div>
                  <div class="prediction-item">
                    <span class="label">置信度：</span>
                    <el-progress :percentage="confidence" :color="confidenceColor"></el-progress>
                  </div>
                  <div class="prediction-item">
                    <span class="label">预测时间：</span>
                    <span class="value">{{ predictionDate }}</span>
                  </div>
                </div>
                <div class="prediction-actions">
                  <el-button type="primary" @click="refreshPrediction" :loading="loading">刷新预测</el-button>
                  <el-button @click="showHistory">查看历史</el-button>
                </div>
              </el-card>
            </el-col>
          </el-row>
          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="24">
              <el-card>
                <div slot="header">
                  <span>期货数据表</span>
                  <el-button type="text" @click="exportData" style="float: right">导出数据</el-button>
                </div>
                <el-table :data="tableData" style="width: 100%" border stripe v-loading="tableLoading">
                  <el-table-column prop="date" label="日期" width="120"></el-table-column>
                  <el-table-column prop="future" label="期货品种" width="120"></el-table-column>
                  <el-table-column prop="open" label="开盘价" width="100"></el-table-column>
                  <el-table-column prop="close" label="收盘价" width="100"></el-table-column>
                  <el-table-column prop="high" label="最高价" width="100"></el-table-column>
                  <el-table-column prop="low" label="最低价" width="100"></el-table-column>
                  <el-table-column prop="volume" label="成交量" width="100"></el-table-column>
                  <el-table-column prop="prediction" label="预测价" width="100"></el-table-column>
                  <el-table-column prop="trend" label="趋势" width="100">
                    <template slot-scope="scope">
                      <el-tag :type="scope.row.trend === '上涨' ? 'success' : 'danger'" size="small">{{ scope.row.trend }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="120">
                    <template slot-scope="scope">
                      <el-button type="text" size="small" @click="viewDetail(scope.row)">详情</el-button>
                    </template>
                  </el-table-column>
                </el-table>
                <el-pagination
                  @size-change="handleSizeChange"
                  @current-change="handleCurrentChange"
                  :current-page="currentPage"
                  :page-sizes="[10, 20, 50, 100]"
                  :page-size="pageSize"
                  layout="total, sizes, prev, pager, next, jumper"
                  :total="total"
                  style="margin-top: 20px; text-align: right"
                ></el-pagination>
              </el-card>
            </el-col>
          </el-row>
        </template>
        <div v-else class="loading-container">
          <el-result icon="info" title="页面加载中">
            <template #extra>
              <el-button type="text" @click="retryLoadPage">若加载时间过长，请点击重试</el-button>
            </template>
          </el-result>
        </div>
      </el-main>
    </el-container>
  </div>
</template>

<script>
import * as echarts from 'echarts';

export default {
  name: 'FuturesPrediction',
  data() {
    return {
      selectedFuture: 'gold',
      futuresOptions: [
        { label: '黄金期货', value: 'gold' },
        { label: '原油期货', value: 'oil' },
        { label: '大豆期货', value: 'soybean' },
        { label: '铜期货', value: 'copper' },
        { label: '白银期货', value: 'silver' }
      ],
      currentPrice: 1850.50,
      predictedPrice: 1885.75,
      predictionTrend: 'up',
      confidence: 85,
      predictionDate: '2023-10-15',
      loading: false,
      tableData: [],
      tableLoading: false,
      currentPage: 1,
      pageSize: 10,
      total: 50,
      chartInstance: null,
      pageError: false,
      errorMessage: '',
      pageLoading: true,
      contentLoading: false
    };
  },
  computed: {
    predictionText() {
      return this.predictionTrend === 'up' ? '上涨' : '下跌';
    },
    confidenceColor() {
      if (this.confidence >= 80) return '#67c23a';
      if (this.confidence >= 60) return '#e6a23c';
      return '#f56c6c';
    }
  },
  mounted() {
    this.loadPageData();
  },
  beforeDestroy() {
    if (this.chartInstance) {
      this.chartInstance.dispose();
    }
    window.removeEventListener('resize', this.handleResize);
  },
  methods: {
    async loadPageData() {
      this.pageError = false;
      this.errorMessage = '';
      this.pageLoading = true;
      this.contentLoading = true;
      try {
        // 先结束全局加载状态，让包含图表容器的 DOM 分支渲染出来
        this.pageLoading = false;
        await this.$nextTick();
        await Promise.all([
          this.initChart(),
          this.loadTableData()
        ]);
      } catch (error) {
        console.error('页面数据加载失败:', error);
        this.pageError = true;
        this.errorMessage = error.message || '页面加载失败，请检查网络或稍后重试';
        this.$message.error('页面加载失败: ' + (error.message || '未知错误'));
      } finally {
        this.contentLoading = false;
      }
    },
    retryLoadPage() {
      this.loadPageData();
    },
    initChart() {
      return new Promise((resolve, reject) => {
        // 使用 $nextTick 确保 DOM 已渲染
        this.$nextTick(() => {
          if (!this.$refs.chartContainer) {
            const error = new Error('图表容器未找到');
            console.error('Chart container not found');
            this.pageError = true;
            this.errorMessage = '图表初始化失败，请重试';
            reject(error);
            return;
          }
          try {
            if (this.chartInstance) {
              this.chartInstance.dispose();
            }
            this.chartInstance = echarts.init(this.$refs.chartContainer);
            const option = {
              title: {
                text: '黄金期货价格预测',
                left: 'center'
              },
              tooltip: {
                trigger: 'axis',
                formatter: function(params) {
                  let result = params[0].name + '<br/>';
                  params.forEach(param => {
                    result += param.seriesName + ': ' + param.value + '<br/>';
                  });
                  return result;
                }
              },
              legend: {
                data: ['历史价格', '预测价格'],
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
                data: ['10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', '10-08', '10-09', '10-10', '10-11', '10-12', '10-13', '10-14', '10-15']
              },
              yAxis: {
                type: 'value'
              },
              series: [
                {
                  name: '历史价格',
                  type: 'line',
                  data: [1820, 1835, 1842, 1838, 1845, 1850, 1848, 1852, 1855, 1850, 1853, 1858, 1860, 1855, 1850],
                  itemStyle: {
                    color: '#2563eb'
                  },
                  lineStyle: {
                    width: 3
                  }
                },
                {
                  name: '预测价格',
                  type: 'line',
                  data: [null, null, null, null, null, null, null, null, null, null, null, null, null, 1855, 1885],
                  itemStyle: {
                    color: '#3b82f6'
                  },
                  lineStyle: {
                    type: 'dashed',
                    width: 3
                  }
                }
              ]
            };
            this.chartInstance.setOption(option);
            window.addEventListener('resize', this.handleResize);
            resolve();
          } catch (error) {
            console.error('Failed to initialize chart:', error);
            this.pageError = true;
            this.errorMessage = '图表初始化失败: ' + error.message;
            reject(error);
          }
        });
      });
    },
    handleResize() {
      if (this.chartInstance) {
        this.chartInstance.resize();
      }
    },
    async loadTableData() {
      this.tableLoading = true;
      try {
        // 模拟异步请求
        await new Promise(resolve => setTimeout(resolve, 500));
        const futures = ['黄金期货', '原油期货', '大豆期货', '铜期货', '白银期货'];
        const trends = ['上涨', '下跌'];
        this.tableData = Array.from({ length: 10 }, (_, index) => ({
          date: `2023-10-${String(index + 1).padStart(2, '0')}`,
          future: futures[index % 5],
          open: (1800 + Math.random() * 100).toFixed(2),
          close: (1810 + Math.random() * 100).toFixed(2),
          high: (1820 + Math.random() * 100).toFixed(2),
          low: (1790 + Math.random() * 100).toFixed(2),
          volume: (10000 + Math.random() * 5000).toFixed(0),
          prediction: (1825 + Math.random() * 100).toFixed(2),
          trend: trends[Math.floor(Math.random() * 2)]
        }));
        this.total = 50;
      } catch (error) {
        console.error('Failed to load table data:', error);
        this.$message.error('数据加载失败: ' + (error.message || '未知错误'));
        this.tableData = [];
        this.total = 0;
        throw error;
      } finally {
        this.tableLoading = false;
      }
    },
    refreshPrediction() {
      this.loading = true;
      // 模拟异步请求
      setTimeout(() => {
        try {
          this.currentPrice = (1850 + Math.random() * 50).toFixed(2);
          this.predictedPrice = (this.currentPrice * 1.02).toFixed(2);
          this.predictionTrend = Math.random() > 0.5 ? 'up' : 'down';
          this.confidence = Math.floor(Math.random() * 30) + 70;
          this.predictionDate = new Date().toISOString().split('T')[0];
          this.$message.success('预测数据已刷新');
        } catch (error) {
          console.error('Failed to refresh prediction:', error);
          this.$message.error('刷新失败: ' + (error.message || '未知错误'));
        } finally {
          this.loading = false;
        }
      }, 1000);
    },
    showHistory() {
      this.$message.info('查看历史功能待实现');
    },
    exportData() {
      this.$message.success('数据导出成功（模拟）');
    },
    viewDetail(row) {
      this.$message.info(`查看详情：${row.future} - ${row.date}`);
    },
    handleSizeChange(val) {
      this.pageSize = val;
      this.loadTableData();
    },
    handleCurrentChange(val) {
      this.currentPage = val;
      this.loadTableData();
    }
  }
};
</script>

<style scoped>
.futures-prediction {
  height: 100%;
  padding: 20px;
  background: radial-gradient(circle at top left, #dbeafe 0, #eff6ff 45%, #f0f9ff 100%);
}

.el-header {
  background: linear-gradient(135deg, #2563eb, #3b82f6);
  border-bottom: none;
  padding: 20px 24px;
  margin-bottom: 20px;
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(37, 99, 235, 0.35);
  color: #eff6ff;
}

.el-header h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.subtitle {
  margin: 10px 0 0 0;
  font-size: 14px;
  color: #bfdbfe;
}

.chart-card,
.prediction-card {
  height: 100%;
  border-radius: 14px;
  border: none;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  background: linear-gradient(145deg, #ffffff, #eff6ff);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.chart-card:hover,
.prediction-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.2);
}

.chart-card >>> .el-card__header,
.prediction-card >>> .el-card__header {
  padding: 18px 20px;
  border-bottom: 1px solid rgba(191, 219, 254, 0.8);
  background: linear-gradient(to right, #eff6ff, #ffffff);
  border-radius: 14px 14px 0 0;
  color: #1e293b;
  font-weight: 600;
}

.prediction-content {
  padding: 20px;
}

.prediction-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px dashed rgba(191, 219, 254, 0.8);
}

.prediction-item:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.prediction-item .label {
  font-size: 14px;
  color: #64748b;
  font-weight: 500;
}

.prediction-item .value {
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.prediction-item .value.up {
  color: #22c55e;
}

.prediction-item .value.down {
  color: #f97316;
}

.prediction-actions {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
  text-align: center;
}

.prediction-actions .el-button--primary {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  border-color: #3b82f6;
}

.prediction-actions .el-button--primary:hover {
  filter: brightness(1.06);
}

.el-row {
  margin-bottom: 20px;
}

.el-card {
  border-radius: 14px;
  overflow: hidden;
}

.el-card >>> .el-card__header {
  padding: 18px 20px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
  background: linear-gradient(to right, #eff6ff, #ffffff);
}

.el-card >>> .el-card__body {
  padding: 20px;
}

.error-container,
.loading-container {
  padding: 40px 20px;
  background-color: #ffffff;
  border-radius: 12px;
  text-align: center;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.15);
}</style>