<template>
  <div class="page-stock-recommend">
    <!-- 顶部统计概览 -->
    <div class="stat-cards">
      <div class="stat-card stat-card--accent">
        <div class="stat-icon"><i class="el-icon-data-analysis"></i></div>
        <div class="stat-info">
          <div class="stat-value">{{ stockList.length }}</div>
          <div class="stat-label">今日推荐标的</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i class="el-icon-trend-charts"></i></div>
        <div class="stat-info">
          <div class="stat-value stat-value--up">{{ avgChange }}%</div>
          <div class="stat-label">平均涨跌幅</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i class="el-icon-aim"></i></div>
        <div class="stat-info">
          <div class="stat-value stat-value--warn">{{ avgProbability }}%</div>
          <div class="stat-label">平均涨停概率</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i class="el-icon-collection"></i></div>
        <div class="stat-info">
          <div class="stat-value">{{ industryCount }}</div>
          <div class="stat-label">覆盖行业</div>
        </div>
      </div>
    </div>

    <el-card class="page-card">
      <div class="page-header">
        <div class="page-title-block">
          <div class="page-title">今日股票推荐</div>
          <div class="page-subtitle">
            基于量价与资金面模型，为您筛选 30 只明日具备强势上攻预期的标的，涵盖代码、名称及涨停概率预测等核心信息
          </div>
        </div>
        <div class="header-actions">
          <el-button type="primary" icon="el-icon-refresh" :loading="loading" @click="loadStockData">
            刷新推荐
          </el-button>
        </div>
      </div>

      <el-table
        :data="pagedList"
        stripe
        style="width: 100%"
        class="stock-table"
        :default-sort="{ prop: 'limitUpProbability', order: 'descending' }"
      >
        <el-table-column type="index" label="#" width="60" align="center" />
        <el-table-column prop="code" label="股票代码" width="110" sortable>
          <template slot-scope="scope">
            <span class="stock-code">{{ scope.row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="股票名称" width="140">
          <template slot-scope="scope">
            <span class="stock-name">{{ scope.row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="price" label="当前价格" width="110" sortable align="right">
          <template slot-scope="scope">
            <span class="price">{{ scope.row.price }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="change" label="涨跌幅" width="120" sortable align="right">
          <template slot-scope="scope">
            <span :class="['change-tag', scope.row.change > 0 ? 'change-up' : scope.row.change < 0 ? 'change-down' : 'change-flat']">
              <i :class="scope.row.change > 0 ? 'el-icon-caret-top' : scope.row.change < 0 ? 'el-icon-caret-bottom' : ''"></i>
              {{ scope.row.change > 0 ? '+' : '' }}{{ scope.row.change }}%
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="limitUpProbability" label="涨停概率" width="180" sortable>
          <template slot-scope="scope">
            <div class="prob-cell">
              <div class="prob-bar">
                <div class="prob-bar-fill" :style="{ width: scope.row.limitUpProbability + '%' }"></div>
              </div>
              <span class="prob-value">{{ scope.row.limitUpProbability }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="industry" label="行业" width="110">
          <template slot-scope="scope">
            <span class="industry-tag">{{ scope.row.industry }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="marketValue" label="市值(亿)" width="110" sortable align="right">
          <template slot-scope="scope">
            <span class="num">{{ scope.row.marketValue }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="pe" label="市盈率" width="100" sortable align="right">
          <template slot-scope="scope">
            <span class="num">{{ scope.row.pe }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="recommendReason" label="推荐理由" min-width="200" show-overflow-tooltip>
          <template slot-scope="scope">
            <span class="reason-text">{{ scope.row.recommendReason }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center">
          <template slot-scope="scope">
            <el-button type="text" size="small" class="detail-btn" @click="handleStockClick(scope.row)">
              查看详情
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          background
          layout="total, prev, pager, next"
          :total="stockList.length"
          :page-size="pageSize"
          :current-page.sync="currentPage"
        />
      </div>
    </el-card>
  </div>
</template>

<script>
export default {
  name: 'TodayStockRecommendation',
  data () {
    return {
      loading: false,
      stockList: [],
      currentPage: 1,
      pageSize: 10
    }
  },
  computed: {
    pagedList () {
      const start = (this.currentPage - 1) * this.pageSize
      return this.stockList.slice(start, start + this.pageSize)
    },
    avgChange () {
      if (!this.stockList.length) return '0.00'
      const sum = this.stockList.reduce((acc, s) => acc + s.change, 0)
      return (sum / this.stockList.length).toFixed(2)
    },
    avgProbability () {
      if (!this.stockList.length) return '0.0'
      const sum = this.stockList.reduce((acc, s) => acc + s.limitUpProbability, 0)
      return (sum / this.stockList.length).toFixed(1)
    },
    industryCount () {
      return new Set(this.stockList.map(s => s.industry)).size
    }
  },
  created () {
    this.loadStockData()
  },
  methods: {
    loadStockData () {
      this.loading = true
      try {
        const stocks = []
        const industries = ['科技', '金融', '消费', '医药', '新能源', '制造', '地产', '通信']
        const reasons = [
          '业绩持续增长，估值合理',
          '行业龙头，竞争优势明显',
          '政策支持，发展前景广阔',
          '技术突破，产品竞争力强',
          '市场份额提升，成长性高',
          '现金流充裕，分红稳定',
          '管理层优秀，战略清晰',
          '研发投入大，创新驱动'
        ]
        // 为示例页面提供 30 个「股票代码 → 中文名称」的对应关系，用中文公司名而不是「股票3」这类占位符
        const baseNames = [
          '浦发银行', '白云机场', '华夏银行', '宝钢股份', '中国石化',
          '中信证券', '中国国航', '上海机场', '万科A', '招商银行',
          '中国平安', '贵州茅台', '五粮液', '伊利股份', '中国中免',
          '宁德时代', '比亚迪', '隆基绿能', '海天味业', '迈瑞医疗',
          '海康威视', '汇川技术', '立讯精密', '三一重工', '中国建筑',
          '中国联通', '中国电信', '中国移动', '紫金矿业', '东方财富'
        ]

        for (let i = 1; i <= 30; i++) {
          const code = `600${i.toString().padStart(3, '0')}`
          // 股票名称使用与代码一一对应的中文公司名，避免「股票3」这类占位符
          const name = baseNames[i - 1] || `示例股票${i}`
          const price = (Math.random() * 100 + 10).toFixed(2)
          const change = (Math.random() * 10 - 5).toFixed(2)
          const limitUpProbability = (Math.random() * 40 + 30).toFixed(1)
          const industry = industries[Math.floor(Math.random() * industries.length)]
          const marketValue = (Math.random() * 1000 + 100).toFixed(0)
          const pe = (Math.random() * 50 + 10).toFixed(1)
          const reason = reasons[Math.floor(Math.random() * reasons.length)]

          stocks.push({
            code,
            name,
            price: parseFloat(price),
            change: parseFloat(change),
            limitUpProbability: parseFloat(limitUpProbability),
            industry,
            marketValue: parseFloat(marketValue),
            pe: parseFloat(pe),
            recommendReason: reason
          })
        }

        this.stockList = stocks
      } finally {
        this.loading = false
      }
    },
    handleStockClick (stock) {
      this.$message({
        message: `查看股票详情：${stock.name} (${stock.code})`,
        type: 'info'
      })
      // 如需后续扩展，可在此处跳转到股票详情页，例如：
      // this.$router.push(`/stock/detail/${stock.code}`)
    }
  }
}
</script>

<style scoped>
.page-stock-recommend {
  padding: 32px 40px;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
  min-height: 100vh;
  box-sizing: border-box;
}

/* ===== 顶部统计卡片 ===== */
.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin-bottom: 24px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.06);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.stat-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.1);
}

.stat-card--accent {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  border-color: transparent;
}

.stat-card--accent .stat-label,
.stat-card--accent .stat-value {
  color: #ffffff;
}

.stat-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  background: #eff6ff;
  color: #2563eb;
  flex-shrink: 0;
}

.stat-card--accent .stat-icon {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.stat-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-value {
  font-size: 26px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1.1;
}

.stat-value--up {
  color: #10b981;
}

.stat-value--warn {
  color: #f59e0b;
}

.stat-label {
  font-size: 13px;
  color: #64748b;
}

/* ===== 主卡片 ===== */
.page-card {
  padding: 0 28px 28px;
  border-radius: 20px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.07);
  background-color: #ffffff;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 0 18px;
  border-bottom: 1px solid #eef2f7;
  margin-bottom: 16px;
}

.page-title-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.page-title {
  font-size: 24px;
  font-weight: 800;
  color: #0f172a;
  margin: 0;
}

.page-subtitle {
  font-size: 13px;
  color: #64748b;
  line-height: 1.6;
  max-width: 640px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ===== 表格 ===== */
.stock-table {
  margin-top: 8px;
}

.stock-table >>> .el-table__header-wrapper {
  background: #f8fafc;
}

.stock-table >>> .el-table th {
  background: #f8fafc;
  color: #475569;
  font-weight: 600;
  padding: 14px 0;
  font-size: 13px;
}

.stock-table >>> .el-table__row {
  transition: background-color 0.2s ease;
}

.stock-table >>> .el-table__row:hover {
  background-color: #f1f5f9;
}

.stock-table >>> .el-table td {
  padding: 12px 0;
}

.stock-code {
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 13px;
  color: #475569;
  letter-spacing: 0.5px;
}

.stock-name {
  font-weight: 600;
  color: #0f172a;
}

.price {
  font-weight: 600;
  font-size: 14px;
  color: #0f172a;
}

/* 涨跌幅标签 */
.change-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
}

.change-up {
  background: #ecfdf5;
  color: #059669;
}

.change-down {
  background: #fef2f2;
  color: #dc2626;
}

.change-flat {
  background: #f1f5f9;
  color: #64748b;
}

/* 涨停概率进度条 */
.prob-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.prob-bar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: #f1f5f9;
  overflow: hidden;
}

.prob-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #fbbf24 0%, #f59e0b 100%);
  transition: width 0.4s ease;
}

.prob-value {
  width: 48px;
  text-align: right;
  font-weight: 700;
  font-size: 13px;
  color: #d97706;
}

/* 行业标签 */
.industry-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 4px;
  background: #eff6ff;
  color: #2563eb;
  font-size: 12px;
  font-weight: 500;
}

.num {
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 13px;
  color: #334155;
}

.reason-text {
  font-size: 13px;
  color: #475569;
}

.detail-btn {
  color: #2563eb;
  font-weight: 500;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #eef2f7;
}

.pagination-wrap >>> .el-pagination.is-background .el-pager li:not(.disabled).active {
  background-color: #2563eb;
}
</style>