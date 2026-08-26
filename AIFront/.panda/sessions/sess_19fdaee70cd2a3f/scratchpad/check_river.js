const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', m => console.log('[console]', m.type(), m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:8081/river-city', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(1000);

  // 点击开始游戏
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const start = btns.find(b => b.textContent.includes('开始游戏') || b.textContent.trim() === '开始');
    if (start) { start.click(); return true; }
    return false;
  });
  console.log('clicked start:', clicked);
  await page.waitForTimeout(1500);

  // 读取 canvas 像素，统计关键颜色
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return { error: 'no canvas' };
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height).data;
    const counts = { playerBlue: 0, enemyOrange: 0, bossRed: 0, skin: 0, hair: 0 };
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], b = img[i + 2];
      // 玩家蓝 #1e88e5
      if (Math.abs(r - 0x1e) < 30 && Math.abs(g - 0x88) < 30 && Math.abs(b - 0xe5) < 30) counts.playerBlue++;
      // 敌人橙 #fb8c00
      if (Math.abs(r - 0xfb) < 30 && Math.abs(g - 0x8c) < 30 && Math.abs(b - 0x00) < 30) counts.enemyOrange++;
      // 头目红 #e53935
      if (Math.abs(r - 0xe5) < 30 && Math.abs(g - 0x39) < 30 && Math.abs(b - 0x35) < 30) counts.bossRed++;
      // 皮肤 #ffcc80
      if (Math.abs(r - 0xff) < 30 && Math.abs(g - 0xcc) < 30 && Math.abs(b - 0x80) < 30) counts.skin++;
      // 头发 #263238
      if (Math.abs(r - 0x26) < 30 && Math.abs(g - 0x32) < 30 && Math.abs(b - 0x38) < 30) counts.hair++;
    }
    return { width, height, counts };
  });
  console.log('canvas result:', JSON.stringify(result, null, 2));

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
