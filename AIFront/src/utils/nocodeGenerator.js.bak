function escapeHtml (str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toSafeTextLines (text, maxLines) {
  const lines = String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  return lines.slice(0, maxLines)
}

// 这是一个“可替换的大模型生成器”：
// - 现在：基于上传图片（可选）+ 文字描述，生成一个合理的落地页骨架
// - 未来：把此处替换为后端大模型生成的 html/css 即可
export function generatePageFromInputs (input) {
  const title = (input && input.title) || '生成页面'
  const description = (input && input.description) || ''
  const images = (input && input.images) || []

  const bullets = toSafeTextLines(description, 8)
  const heroImage = images[0] && images[0].dataUrl ? images[0].dataUrl : ''

  const html = `
  <div class="nc-page">
    <div class="nc-hero">
      <div class="nc-hero-left">
        <div class="nc-title">${escapeHtml(title)}</div>
        <div class="nc-desc">${escapeHtml(description || '（未提供文字描述）')}</div>
        ${bullets.length
          ? `<ul class="nc-bullets">${bullets
              .map(b => `<li>${escapeHtml(b)}</li>`)
              .join('')}</ul>`
          : ''}
        <div class="nc-actions">
          <button class="nc-btn primary">立即开始</button>
          <button class="nc-btn">了解更多</button>
        </div>
      </div>
      <div class="nc-hero-right">
        ${
          heroImage
            ? `<img class="nc-hero-img" src="${heroImage}" alt="设计图" />`
            : `<div class="nc-hero-placeholder">未上传主视觉图片</div>`
        }
      </div>
    </div>

    ${
      images.length > 1
        ? `<div class="nc-gallery">
            <div class="nc-section-title">参考图片</div>
            <div class="nc-gallery-grid">
              ${images
                .slice(1, 7)
                .map(
                  img => `<div class="nc-gallery-item">
                    <img src="${img.dataUrl}" alt="${escapeHtml(img.name || '')}" />
                  </div>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }

    <div class="nc-section">
      <div class="nc-section-title">模块示例</div>
      <div class="nc-cards">
        <div class="nc-card">
          <div class="nc-card-title">模块 A</div>
          <div class="nc-card-text">根据描述自动生成的内容区块，可继续迭代为真实业务组件。</div>
        </div>
        <div class="nc-card">
          <div class="nc-card-title">模块 B</div>
          <div class="nc-card-text">未来接入大模型后，将输出更贴近 UI 设计稿的布局与样式。</div>
        </div>
        <div class="nc-card">
          <div class="nc-card-title">模块 C</div>
          <div class="nc-card-text">当前版本支持预览与保存，后续可扩展导出 Vue 文件/路由等。</div>
        </div>
      </div>
    </div>
  </div>
  `.trim()

  const css = `
  :root{
    --nc-bg: #f5f7fa;
    --nc-card: #ffffff;
    --nc-text: #1f1f1f;
    --nc-sub: #6b7280;
    --nc-border: rgba(0,0,0,.08);
    --nc-primary: #1677ff;
  }

  html,body{ height:100%; }
  body{
    margin:0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    background: var(--nc-bg);
    color: var(--nc-text);
  }

  .nc-page{
    padding: 20px;
  }

  .nc-hero{
    display:flex;
    gap: 18px;
    align-items: stretch;
    background: var(--nc-card);
    border: 1px solid var(--nc-border);
    border-radius: 12px;
    padding: 18px;
    box-shadow: 0 2px 10px rgba(0,0,0,.04);
  }

  .nc-hero-left{
    flex: 1;
    min-width: 0;
  }

  .nc-title{
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 10px;
  }

  .nc-desc{
    color: var(--nc-sub);
    line-height: 1.6;
    font-size: 14px;
    margin-bottom: 10px;
    white-space: pre-wrap;
  }

  .nc-bullets{
    padding-left: 18px;
    margin: 8px 0 12px;
    color: var(--nc-sub);
    font-size: 13px;
    line-height: 1.7;
  }

  .nc-actions{
    display:flex;
    gap: 10px;
    margin-top: 10px;
  }

  .nc-btn{
    border: 1px solid var(--nc-border);
    background: #fff;
    color: var(--nc-text);
    padding: 8px 14px;
    border-radius: 8px;
    cursor:pointer;
    font-size: 13px;
  }

  .nc-btn.primary{
    background: var(--nc-primary);
    border-color: var(--nc-primary);
    color: #fff;
  }

  .nc-hero-right{
    width: 46%;
    min-width: 320px;
    display:flex;
    align-items:center;
    justify-content:center;
  }

  .nc-hero-img{
    width: 100%;
    height: 260px;
    object-fit: cover;
    border-radius: 10px;
    border: 1px solid var(--nc-border);
    background: #fff;
  }

  .nc-hero-placeholder{
    width: 100%;
    height: 260px;
    border-radius: 10px;
    border: 1px dashed var(--nc-border);
    display:flex;
    align-items:center;
    justify-content:center;
    color: var(--nc-sub);
    background: #fafafa;
    font-size: 13px;
  }

  .nc-section{
    margin-top: 16px;
    background: var(--nc-card);
    border: 1px solid var(--nc-border);
    border-radius: 12px;
    padding: 16px 18px;
  }

  .nc-section-title{
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 12px;
  }

  .nc-cards{
    display:grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .nc-card{
    border: 1px solid var(--nc-border);
    border-radius: 10px;
    padding: 12px;
    background: #fff;
  }

  .nc-card-title{
    font-weight: 700;
    margin-bottom: 6px;
  }

  .nc-card-text{
    color: var(--nc-sub);
    font-size: 13px;
    line-height: 1.6;
  }

  .nc-gallery{
    margin-top: 16px;
    background: var(--nc-card);
    border: 1px solid var(--nc-border);
    border-radius: 12px;
    padding: 16px 18px;
  }

  .nc-gallery-grid{
    display:grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }

  .nc-gallery-item{
    border-radius: 10px;
    border: 1px solid var(--nc-border);
    overflow: hidden;
    background: #fff;
  }

  .nc-gallery-item img{
    width: 100%;
    height: 140px;
    object-fit: cover;
    display:block;
  }

  @media (max-width: 980px){
    .nc-hero{ flex-direction: column; }
    .nc-hero-right{ width: 100%; min-width: 0; }
    .nc-cards{ grid-template-columns: 1fr; }
    .nc-gallery-grid{ grid-template-columns: 1fr; }
  }
  `.trim()

  return {
    html,
    css,
    meta: {
      generator: 'local-fallback',
      version: 1
    }
  }
}

