<template>
  <div class="page-table">
    <el-card>
      <div slot="header" class="card-header">
        <span>表格示例</span>
      </div>
      <el-table :data="tableData" border style="width: 100%" class="custom-table">
        <el-table-column prop="date" label="日期" width="180">
          <template slot-scope="scope">
            <el-tooltip :content="scope.row.date" placement="top" effect="light">
              <span class="ellipsis-text">{{ scope.row.date }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="姓名" width="180">
          <template slot-scope="scope">
            <el-tooltip :content="scope.row.name" placement="top" effect="light">
              <span class="ellipsis-text">{{ scope.row.name }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="address" label="地址">
          <template slot-scope="scope">
            <el-tooltip :content="scope.row.address" placement="top" effect="light">
              <span class="ellipsis-text">{{ scope.row.address }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script>
export default {
  name: 'TablePage',
  data () {
    return {
      tableData: [
        {
          date: '2024-01-01',
          name: '王小虎',
          address: '上海市普陀区金沙江路 1518 弄'
        },
        {
          date: '2024-01-02',
          name: '王小虎',
          address: '上海市普陀区金沙江路 1518 弄'
        },
        {
          date: '2024-01-03',
          name: '王小虎',
          address: '上海市普陀区金沙江路 1518 弄'
        }
      ]
    }
  }
}
</script>

<style scoped>
.page-table {
  padding: 12px;
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(59, 130, 246, 0.15), transparent 60%),
    radial-gradient(1000px 400px at 90% 0%, rgba(99, 102, 241, 0.12), transparent 60%),
    linear-gradient(160deg, #eef4ff 0%, #e0ecff 40%, #d6e6ff 100%);
  min-height: calc(100vh - 64px);
  height: 100%;
  box-sizing: border-box;
}

.card-header {
  font-size: 20px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e5e7eb;
}

.custom-table {
  font-size: 14px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  margin-top: 6px;
  height: calc(100% - 60px);
  min-height: 400px;
  display: flex;
  flex-direction: column;
}

.custom-table >>> .el-table {
  flex: 1;
  overflow: auto;
}

.custom-table >>> .el-table__header-wrapper {
  position: sticky;
  top: 0;
  z-index: 1;
}

.custom-table >>> .el-table__body-wrapper {
  flex: 1;
  overflow: auto;
}

.custom-table >>> .el-table__header th {
  background-color: #3b82f6;
  color: #ffffff;
  font-weight: 600;
  font-size: 15px;
  height: 44px;
  border-bottom: none;
}

.custom-table >>> .el-table__row {
  height: 52px;
  transition: background-color 0.2s ease;
}

.custom-table >>> .el-table__row:nth-child(even) {
  background-color: #f9fafb;
}

.custom-table >>> .el-table__row:hover td {
  background-color: #eff6ff;
}

.custom-table >>> .el-table__cell {
  padding: 10px 0;
  color: #4b5563;
  border-bottom: 1px solid #f3f4f6;
}

.custom-table >>> .el-table__cell:first-child {
  padding-left: 12px;
}

.custom-table >>> .el-table__cell:last-child {
  padding-right: 12px;
}

.custom-table >>> .el-pagination {
  margin-top: 12px;
  padding: 10px 0;
  justify-content: flex-end;
  flex-shrink: 0;
}

.custom-table >>> .el-pagination .btn-prev,
.custom-table >>> .el-pagination .btn-next,
.custom-table >>> .el-pagination .number {
  border-radius: 6px;
  margin: 0 2px;
  border: 1px solid #d1d5db;
}

.custom-table >>> .el-pagination .number.active {
  background-color: #3b82f6;
  border-color: #3b82f6;
  color: #ffffff;
}

.custom-table >>> .el-pagination .number:hover {
  border-color: #3b82f6;
  color: #3b82f6;
}

.custom-table >>> .el-pagination .el-input__inner {
  border-radius: 6px;
  border-color: #d1d5db;
}

.custom-table >>> .el-pagination .el-select .el-input .el-input__inner {
  border-radius: 6px;
}

.ellipsis-text {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.2s ease;
}

.ellipsis-text:hover {
  color: #3b82f6;
}</style>