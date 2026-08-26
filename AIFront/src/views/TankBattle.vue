<template>
  <div class="tank-battle">
    <div class="game-header">
      <div class="game-title">
        <i class="el-icon-aim"></i>
        <span>坦克大战</span>
      </div>
      <div class="game-stats">
        <div class="stat">
          <span class="stat-label">得分</span>
          <span class="stat-value score">{{ score }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">生命</span>
          <span class="stat-value lives">{{ lives }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">关卡</span>
          <span class="stat-value level">{{ level }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">剩余敌人</span>
          <span class="stat-value enemies">{{ enemiesOnField }}/{{ remainingEnemies }}</span>
        </div>
      </div>
      <div class="game-controls">
        <el-button size="small" type="primary" @click="startGame">开始</el-button>
        <el-button size="small" @click="togglePause">{{ paused ? '继续' : '暂停' }}</el-button>
        <el-button size="small" type="danger" plain @click="resetGame">重置</el-button>
      </div>
    </div>

    <div class="game-body">
      <div class="canvas-wrap">
        <canvas
          ref="gameCanvas"
          :width="canvasW"
          :height="canvasH"
          @mousemove="onMouseMove"
          @mousedown="onMouseDown"
        ></canvas>
        <div v-if="!started" class="overlay">
          <div class="overlay-box">
            <h2><i class="el-icon-aim"></i> 坦克大战</h2>
            <p>方向键 ↑↓←→ 控制移动</p>
            <p>鼠标左键 朝鼠标方向发射炮弹</p>
            <el-button type="primary" @click="startGame">开始游戏</el-button>
          </div>
        </div>
        <div v-else-if="gameOver" class="overlay">
          <div class="overlay-box">
            <h2>游戏结束</h2>
            <p class="result-lose">你输了</p>
            <p class="result-score">最终得分：{{ score }} · 击杀 {{ kills }}</p>
            <el-button type="primary" @click="startGame">再来一局</el-button>
          </div>
        </div>
        <div v-else-if="paused" class="overlay">
          <div class="overlay-box">
            <h2>已暂停</h2>
            <el-button type="primary" @click="togglePause">继续</el-button>
          </div>
        </div>
      </div>

      <div class="side-panel">
        <div class="panel-section">
          <div class="panel-title">操作说明</div>
          <ul class="help-list">
            <li><b>↑ ↓ ← →</b> 移动坦克</li>
            <li><b>鼠标左键</b> 发射炮弹</li>
            <li><b>空格</b> 暂停/继续</li>
          </ul>
        </div>
        <div class="panel-section">
          <div class="panel-title">图例</div>
          <div class="legend">
            <div class="legend-item"><span class="legend-box player"></span> 玩家坦克</div>
            <div class="legend-item"><span class="legend-box enemy"></span> 敌方坦克</div>
            <div class="legend-item"><span class="legend-box brick"></span> 砖墙（可摧毁）</div>
            <div class="legend-item"><span class="legend-box steel"></span> 钢墙（不可摧毁）</div>
            <div class="legend-item"><span class="legend-box bullet"></span> 炮弹</div>
          </div>
        </div>
        <div class="panel-section">
          <div class="panel-title">战绩</div>
          <div class="record">
            <div>击杀数：<b>{{ kills }}</b></div>
            <div>最高分：<b>{{ bestScore }}</b></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
const TILE = 40
const COLS = 13
const ROWS = 13

// 地图：0=空地 1=砖墙 2=钢墙
const MAP = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0],
  [0,1,0,1,0,1,2,1,0,1,0,1,0],
  [0,1,0,1,0,0,0,0,0,1,0,1,0],
  [0,0,0,0,0,1,0,1,0,0,0,0,0],
  [0,0,0,1,0,1,0,1,0,1,0,0,0],
  [1,1,0,1,0,0,0,0,0,1,0,1,1],
  [0,0,0,1,0,1,0,1,0,1,0,0,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0]
]

export default {
  name: 'TankBattle',
  data () {
    return {
      canvasW: COLS * TILE,
      canvasH: ROWS * TILE,
      started: false,
      paused: false,
      gameOver: false,
      score: 0,
      lives: 3,
      level: 1,
      kills: 0,
      bestScore: 0,
      enemiesLeft: 0,
      // 游戏内部状态
      player: null,
      enemies: [],
      bullets: [],
      walls: [],
      keys: {},
      mouse: { x: 0, y: 0 },
      rafId: null,
      lastTime: 0,
      spawnTimer: 0,
      enemyTotal: 0
    }
  },
  computed: {
    // 剩余敌人总数 = 场上敌人 + 待生成敌人
    remainingEnemies () {
      // 待生成 + 场上存活 = 本关还要消灭的总数
      return this.enemiesLeft + this.enemiesOnField
    },
    enemiesOnField () {
      return (this.enemies || []).filter(e => e && e.alive).length
    }
  },
  mounted () {
    this.initWalls()
    this.bindKeys()
    this.bestScore = parseInt(localStorage.getItem('tank_battle_best') || '0', 10)
  },
  beforeDestroy () {
    this.stopLoop()
    this.unbindKeys()
  },
  methods: {
    initWalls () {
      this.walls = []
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const t = MAP[r][c]
          if (t > 0) {
            this.walls.push({
              x: c * TILE,
              y: r * TILE,
              w: TILE,
              h: TILE,
              type: t,
              alive: true
            })
          }
        }
      }
    },
    bindKeys () {
      this._keydown = (e) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
          e.preventDefault()
        }
        if (e.key === ' ') {
          this.togglePause()
          return
        }
        this.keys[e.key] = true
      }
      this._keyup = (e) => {
        this.keys[e.key] = false
      }
      window.addEventListener('keydown', this._keydown)
      window.addEventListener('keyup', this._keyup)
    },
    unbindKeys () {
      window.removeEventListener('keydown', this._keydown)
      window.removeEventListener('keyup', this._keyup)
    },
    startGame () {
      this.score = 0
      this.lives = 3
      this.level = 1
      this.kills = 0
      this.started = true
      this.paused = false
      this.gameOver = false
      this.initLevel()
      this.startLoop()
    },
    resetGame () {
      this.stopLoop()
      this.started = false
      this.paused = false
      this.gameOver = false
      this.score = 0
      this.lives = 3
      this.level = 1
      this.kills = 0
      this.enemies = []
      this.bullets = []
      this.initWalls()
      this.draw()
    },
    initLevel () {
      this.initWalls()
      this.enemies = []
      this.bullets = []
      this.enemyTotal = 4 + this.level * 2
      this.enemiesLeft = this.enemyTotal
      this.spawnTimer = 0
      // 玩家初始位置：底部中央
      this.player = {
        x: Math.floor(COLS / 2) * TILE + TILE / 2,
        y: (ROWS - 1) * TILE + TILE / 2,
        w: TILE - 8,
        h: TILE - 8,
        dir: 'up',
        speed: 3,
        cooldown: 0,
        alive: true
      }
      // 初始生成 2 个敌人
      this.spawnEnemy()
      this.spawnEnemy()
    },
    spawnEnemy () {
      if (this.enemiesLeft <= 0) return false
      const spots = [
        { x: TILE / 2, y: TILE / 2 },
        { x: (COLS - 1) * TILE + TILE / 2, y: TILE / 2 },
        { x: Math.floor(COLS / 2) * TILE + TILE / 2, y: TILE / 2 }
      ]
      const free = spots.find(s => !this.enemies.some(e => e.alive && Math.abs(e.x - s.x) < TILE && Math.abs(e.y - s.y) < TILE))
      if (!free) return false
      this.enemies.push({
        x: free.x,
        y: free.y,
        w: TILE - 8,
        h: TILE - 8,
        dir: 'down',
        speed: 1.5,
        cooldown: 0,
        alive: true,
        moveTimer: 0
      })
      this.enemiesLeft--
      return true
    },
    startLoop () {
      this.stopLoop()
      this.lastTime = performance.now()
      const loop = (t) => {
        const dt = Math.min((t - this.lastTime) / 16.67, 3)
        this.lastTime = t
        if (!this.paused && !this.gameOver) {
          this.update(dt)
        }
        this.draw()
        this.rafId = requestAnimationFrame(loop)
      }
      this.rafId = requestAnimationFrame(loop)
    },
    stopLoop () {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    },
    togglePause () {
      if (!this.started || this.gameOver) return
      this.paused = !this.paused
    },
    onMouseMove (e) {
      const rect = this.$refs.gameCanvas.getBoundingClientRect()
      this.mouse.x = e.clientX - rect.left
      this.mouse.y = e.clientY - rect.top
    },
    onMouseDown (e) {
      if (e.button !== 0) return
      if (!this.started || this.paused || this.gameOver) return
      this.firePlayer()
    },
    firePlayer () {
      if (!this.player || !this.player.alive || this.player.cooldown > 0) return
      const angle = Math.atan2(this.mouse.y - this.player.y, this.mouse.x - this.player.x)
      // 根据角度决定坦克朝向
      const deg = angle * 180 / Math.PI
      if (deg > -45 && deg <= 45) this.player.dir = 'right'
      else if (deg > 45 && deg <= 135) this.player.dir = 'down'
      else if (deg > 135 || deg <= -135) this.player.dir = 'left'
      else this.player.dir = 'up'
      this.bullets.push({
        x: this.player.x,
        y: this.player.y,
        vx: Math.cos(angle) * 6,
        vy: Math.sin(angle) * 6,
        owner: 'player',
        alive: true
      })
      this.player.cooldown = 18
    },
    update (dt) {
      // 玩家移动
      if (this.player && this.player.alive) {
        let dx = 0
        let dy = 0
        if (this.keys['ArrowUp'] || this.keys['w'] || this.keys['W']) { dy = -1; this.player.dir = 'up' }
        else if (this.keys['ArrowDown'] || this.keys['s'] || this.keys['S']) { dy = 1; this.player.dir = 'down' }
        else if (this.keys['ArrowLeft'] || this.keys['a'] || this.keys['A']) { dx = -1; this.player.dir = 'left' }
        else if (this.keys['ArrowRight'] || this.keys['d'] || this.keys['D']) { dx = 1; this.player.dir = 'right' }
        this.moveTank(this.player, dx * this.player.speed * dt, dy * this.player.speed * dt)
        if (this.player.cooldown > 0) this.player.cooldown -= dt
      }

      // 敌人 AI
      for (const e of this.enemies) {
        if (!e.alive) continue
        e.moveTimer -= dt
        if (e.moveTimer <= 0) {
          const dirs = ['up', 'down', 'left', 'right']
          e.dir = dirs[Math.floor(Math.random() * 4)]
          e.moveTimer = 40 + Math.random() * 60
        }
        const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[e.dir]
        this.moveTank(e, d[0] * e.speed * dt, d[1] * e.speed * dt)
        if (e.cooldown > 0) e.cooldown -= dt
        // 敌人射击
        if (e.cooldown <= 0 && Math.random() < 0.02 * dt) {
          const angle = Math.atan2(this.player.y - e.y, this.player.x - e.x)
          this.bullets.push({
            x: e.x,
            y: e.y,
            vx: Math.cos(angle) * 4,
            vy: Math.sin(angle) * 4,
            owner: 'enemy',
            alive: true
          })
          e.cooldown = 60
        }
      }

      // 子弹移动
      for (const b of this.bullets) {
        if (!b.alive) continue
        b.x += b.vx * dt
        b.y += b.vy * dt
        // 边界
        if (b.x < 0 || b.x > this.canvasW || b.y < 0 || b.y > this.canvasH) {
          b.alive = false
          continue
        }
        // 撞墙
        for (const w of this.walls) {
          if (!w.alive) continue
          if (this.rectHit(b.x, b.y, 4, 4, w.x, w.y, w.w, w.h)) {
            if (w.type === 1) w.alive = false // 砖墙被摧毁
            b.alive = false
            break
          }
        }
        if (!b.alive) continue
        // 子弹命中坦克
        if (b.owner === 'player') {
          if (this.gameOver) continue
          for (const e of this.enemies) {
            if (!e.alive) continue
            if (this.rectHit(b.x, b.y, 4, 4, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
              e.alive = false
              b.alive = false
              this.kills++
              this.score += 100
              this.spawnTimer = 0
              break
            }
          }
        } else {
          if (this.player && this.player.alive && this.rectHit(b.x, b.y, 4, 4, this.player.x - this.player.w / 2, this.player.y - this.player.h / 2, this.player.w, this.player.h)) {
            b.alive = false
            this.player.alive = false
            this.lives--
            if (this.lives <= 0) {
              this.gameOver = true
              // 终局冻结：清子弹，避免死后飘弹再加分造成「输了还跳分」
              this.bullets = []
              if (this.score > this.bestScore) {
                this.bestScore = this.score
                localStorage.setItem('tank_battle_best', String(this.bestScore))
              }
            } else {
              // 重生
              this.player.x = Math.floor(COLS / 2) * TILE + TILE / 2
              this.player.y = (ROWS - 1) * TILE + TILE / 2
              this.player.dir = 'up'
              this.player.alive = true
            }
          }
        }
      }

      // 清理
      this.bullets = this.bullets.filter(b => b.alive)
      this.enemies = this.enemies.filter(e => e.alive)

      // 生成新敌人
      if (this.enemiesLeft > 0 && this.enemies.length < 4) {
        this.spawnTimer += dt
        if (this.spawnTimer > 120) {
          this.spawnTimer = 0
          this.spawnEnemy()
        }
      }

      // 过关
      if (this.enemiesLeft <= 0 && this.enemies.length === 0) {
        this.level++
        this.initLevel()
      }
    },
    moveTank (tank, dx, dy) {
      const halfW = tank.w / 2
      const halfH = tank.h / 2
      let nx = tank.x + dx
      let ny = tank.y + dy
      // 边界
      nx = Math.max(halfW, Math.min(this.canvasW - halfW, nx))
      ny = Math.max(halfH, Math.min(this.canvasH - halfH, ny))
      // 撞墙
      if (!this.collidesWall(nx, ny, halfW, halfH)) {
        tank.x = nx
        tank.y = ny
      }
    },
    collidesWall (x, y, halfW, halfH) {
      for (const w of this.walls) {
        if (!w.alive) continue
        if (this.rectHit(x, y, halfW * 2, halfH * 2, w.x, w.y, w.w, w.h)) {
          return true
        }
      }
      return false
    },
    rectHit (ax, ay, aw, ah, bx, by, bw, bh) {
      return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
    },
    draw () {
      const canvas = this.$refs.gameCanvas
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      // 背景
      ctx.fillStyle = '#0d1526'
      ctx.fillRect(0, 0, this.canvasW, this.canvasH)
      // 网格
      ctx.strokeStyle = 'rgba(148,163,184,0.08)'
      ctx.lineWidth = 1
      for (let i = 0; i <= COLS; i++) {
        ctx.beginPath()
        ctx.moveTo(i * TILE, 0)
        ctx.lineTo(i * TILE, this.canvasH)
        ctx.stroke()
      }
      for (let i = 0; i <= ROWS; i++) {
        ctx.beginPath()
        ctx.moveTo(0, i * TILE)
        ctx.lineTo(this.canvasW, i * TILE)
        ctx.stroke()
      }
      // 背景装饰 - 碎石/草地纹理
      ctx.fillStyle = 'rgba(148,163,184,0.06)'
      for (let i = 0; i < 60; i++) {
        const px = (i * 97) % this.canvasW
        const py = (i * 53) % this.canvasH
        ctx.fillRect(px, py, 2, 2)
      }
      // 墙
      for (const w of this.walls) {
        if (!w.alive) continue
        if (w.type === 1) {
          // 砖墙 - 经典红砖交错纹理
          ctx.fillStyle = '#b45309'
          ctx.fillRect(w.x, w.y, w.w, w.h)
          const brickH = 8
          const brickW = 16
          ctx.strokeStyle = 'rgba(0,0,0,0.35)'
          ctx.lineWidth = 1
          for (let by = w.y; by < w.y + w.h; by += brickH) {
            const offset = ((by - w.y) / brickH) % 2 === 0 ? 0 : brickW / 2
            for (let bx = w.x - offset; bx < w.x + w.w; bx += brickW) {
              ctx.strokeRect(bx, by, brickW, brickH)
            }
          }
          // 砖块高光
          ctx.fillStyle = 'rgba(255,255,255,0.10)'
          for (let by = w.y; by < w.y + w.h; by += brickH) {
            ctx.fillRect(w.x, by, w.w, 1)
          }
        } else {
          // 钢墙 - 银色金属质感
          const g = ctx.createLinearGradient(w.x, w.y, w.x + w.w, w.y + w.h)
          g.addColorStop(0, '#cbd5e1')
          g.addColorStop(0.5, '#94a3b8')
          g.addColorStop(1, '#64748b')
          ctx.fillStyle = g
          ctx.fillRect(w.x, w.y, w.w, w.h)
          ctx.strokeStyle = '#475569'
          ctx.lineWidth = 1
          ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1)
          // 高光
          ctx.fillStyle = 'rgba(255,255,255,0.25)'
          ctx.fillRect(w.x + 2, w.y + 2, w.w - 4, 2)
          // 铆钉
          ctx.fillStyle = '#475569'
          ctx.beginPath()
          ctx.arc(w.x + 4, w.y + 4, 1.5, 0, Math.PI * 2)
          ctx.arc(w.x + w.w - 4, w.y + 4, 1.5, 0, Math.PI * 2)
          ctx.arc(w.x + 4, w.y + w.h - 4, 1.5, 0, Math.PI * 2)
          ctx.arc(w.x + w.w - 4, w.y + w.h - 4, 1.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      // 子弹
      for (const b of this.bullets) {
        ctx.fillStyle = b.owner === 'player' ? '#fbbf24' : '#f87171'
        ctx.beginPath()
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
      // 敌人
      for (const e of this.enemies) {
        this.drawTank(ctx, e, '#ef4444', '#7f1d1d')
      }
      // 玩家
      if (this.player && this.player.alive) {
        this.drawTank(ctx, this.player, '#22c55e', '#14532d')
      }
    },
    drawTank (ctx, tank, color, dark) {
      const x = tank.x - tank.w / 2
      const y = tank.y - tank.h / 2
      // 履带（带纹理）
      ctx.fillStyle = dark
      if (tank.dir === 'up' || tank.dir === 'down') {
        ctx.fillRect(x, y, 8, tank.h)
        ctx.fillRect(x + tank.w - 8, y, 8, tank.h)
        ctx.fillStyle = 'rgba(0,0,0,0.3)'
        for (let ty = y + 2; ty < y + tank.h; ty += 4) {
          ctx.fillRect(x, ty, 8, 1)
          ctx.fillRect(x + tank.w - 8, ty, 8, 1)
        }
      } else {
        ctx.fillRect(x, y, tank.w, 8)
        ctx.fillRect(x, y + tank.h - 8, tank.w, 8)
        ctx.fillStyle = 'rgba(0,0,0,0.3)'
        for (let tx = x + 2; tx < x + tank.w; tx += 4) {
          ctx.fillRect(tx, y, 1, 8)
          ctx.fillRect(tx, y + tank.h - 8, 1, 8)
        }
      }
      // 车身（渐变）
      const g = ctx.createLinearGradient(x, y, x + tank.w, y + tank.h)
      g.addColorStop(0, color)
      g.addColorStop(1, dark)
      ctx.fillStyle = g
      ctx.fillRect(x + 8, y + 8, tank.w - 16, tank.h - 16)
      // 车身高光
      ctx.fillStyle = 'rgba(255,255,255,0.15)'
      ctx.fillRect(x + 8, y + 8, tank.w - 16, 2)
      // 炮塔
      ctx.fillStyle = dark
      const cx = tank.x
      const cy = tank.y
      if (tank.dir === 'up') ctx.fillRect(cx - 3, y - 4, 6, 12)
      else if (tank.dir === 'down') ctx.fillRect(cx - 3, y + tank.h - 8, 6, 12)
      else if (tank.dir === 'left') ctx.fillRect(x - 4, cy - 3, 12, 6)
      else ctx.fillRect(x + tank.w - 8, cy - 3, 12, 6)
      // 炮塔圆
      ctx.fillStyle = '#f8fafc'
      ctx.beginPath()
      ctx.arc(cx, cy, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = dark
      ctx.beginPath()
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
</script>

<style scoped>
.tank-battle {
  height: calc(100vh - 84px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #0b1220 0%, #0f172a 50%, #111a2e 100%);
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  overflow: hidden;
}
.game-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.game-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 700;
  background: linear-gradient(90deg, #22d3ee, #3b82f6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.game-title i {
  -webkit-text-fill-color: #22d3ee;
  color: #22d3ee;
}
.game-stats {
  display: flex;
  gap: 20px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat-label {
  font-size: 11px;
  color: #64748b;
}
.stat-value {
  font-size: 20px;
  font-weight: 700;
}
.stat-value.score { color: #fbbf24; }
.stat-value.lives { color: #f87171; }
.stat-value.level { color: #38bdf8; }
.stat-value.enemies { color: #a78bfa; }
.game-controls {
  display: flex;
  gap: 8px;
}
.game-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  min-height: 0;
}
.canvas-wrap {
  position: relative;
  flex-shrink: 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  background: #0d1526;
}
.canvas-wrap canvas {
  display: block;
  cursor: crosshair;
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(11, 18, 32, 0.85);
  backdrop-filter: blur(4px);
  z-index: 5;
}
.overlay-box {
  text-align: center;
  padding: 32px 40px;
  background: rgba(30, 41, 59, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  box-shadow: 0 0 40px rgba(56, 189, 248, 0.15);
}
.overlay-box h2 {
  margin: 0 0 12px;
  font-size: 28px;
  background: linear-gradient(90deg, #22d3ee, #3b82f6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.overlay-box h2 i {
  margin-right: 8px;
  -webkit-text-fill-color: #22d3ee;
  color: #22d3ee;
}
.overlay-box p {
  margin: 6px 0;
  color: #94a3b8;
  font-size: 14px;
}
.overlay-box .result-lose {
  color: #f87171;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 2px;
}
.overlay-box .result-score {
  color: #fbbf24;
  font-size: 15px;
  margin: 8px 0 4px;
}
.overlay-box .el-button {
  margin-top: 16px;
}
.side-panel {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}
.panel-section {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 14px 16px;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.help-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.help-list li {
  padding: 4px 0;
  font-size: 13px;
  color: #94a3b8;
}
.help-list b {
  color: #38bdf8;
}
.legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #cbd5e1;
}
.legend-box {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
}
.legend-box.player { background: #22c55e; }
.legend-box.enemy { background: #ef4444; }
.legend-box.brick { background: #b45309; }
.legend-box.steel { background: #94a3b8; }
.legend-box.bullet { background: #fbbf24; border-radius: 50%; }
.record {
  font-size: 13px;
  color: #94a3b8;
  line-height: 1.8;
}
.record b {
  color: #fbbf24;
}
</style>
