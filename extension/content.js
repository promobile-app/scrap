// RankRadar — панель прямо на странице App Store / Google Play.
// Изолирована в Shadow DOM, чтобы стили магазина её не ломали.
(() => {
  if (window.__rankradarInjected) return;
  window.__rankradarInjected = true;

  const API = 'https://scrap-production-c0db.up.railway.app';

  const FLAGS = {
    us: '🇺🇸', gb: '🇬🇧', de: '🇩🇪', ua: '🇺🇦', ru: '🇷🇺', fr: '🇫🇷', pl: '🇵🇱',
    es: '🇪🇸', it: '🇮🇹', ca: '🇨🇦', br: '🇧🇷', in: '🇮🇳', jp: '🇯🇵', tr: '🇹🇷',
  };

  function platformIcon(platform) {
    if (platform === 'android') {
      return `<svg viewBox="0 0 512 512" width="14" height="14" style="vertical-align:-2px">
        <path fill="#34A853" d="M104.6 13c-2.8 1.4-5.5 3.3-7.9 5.5-9.3 8.7-15 22.3-15 39.5v396c0 17.2 5.7 30.8 15 39.5 2.4 2.2 5.1 4.1 7.9 5.5l220.7-243z"/>
        <path fill="#EA4335" d="M325.3 234.3 104.6 13l280.8 161.2z"/>
        <path fill="#FBBC04" d="M104.6 499 325.3 277.7l60.1 60.1z"/>
        <path fill="#4285F4" d="M447.1 256c0 19.6-10.5 36.9-26.6 46.1l-35.2 20.4-60.1-66.5 60.1-66.5 35.4 20.5c16 9.1 26.4 26.3 26.4 46z"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px">
      <rect width="24" height="24" rx="5.4" fill="#1f9bf5"/>
      <g stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <path d="M7.4 17 12 7.4 16.6 17"/><path d="M9.2 14.1h5.6"/>
      </g>
    </svg>`;
  }

  function isStorePage(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (h.endsWith('play.google.com')) return new URL(url).pathname.includes('/store/apps/details');
      return h.endsWith('apple.com') && /\/app\//.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  const host = document.createElement('div');
  host.id = 'rankradar-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
      .fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        display: flex; align-items: center; gap: 8px;
        padding: 11px 15px; border-radius: 999px; cursor: pointer;
        background: linear-gradient(135deg, #5b5ef4, #8b5cf6); color: #fff;
        font-size: 13px; font-weight: 700;
        box-shadow: 0 6px 20px rgba(91,94,244,.45); border: 0;
      }
      .fab:hover { transform: translateY(-1px); }
      .fab svg { display: block; }
      .panel {
        position: fixed; top: 0; right: 0; z-index: 2147483647;
        width: 420px; max-width: 100vw; height: 100vh;
        background: #0e0f15; color: #e9eaf2;
        box-shadow: -10px 0 40px rgba(0,0,0,.5);
        display: flex; flex-direction: column;
        transform: translateX(100%); transition: transform .22s ease;
      }
      .panel.open { transform: translateX(0); }
      .head {
        display: flex; align-items: center; gap: 9px;
        padding: 15px 16px; border-bottom: 1px solid #2b2d3a; flex: none;
      }
      .logo {
        width: 28px; height: 28px; border-radius: 8px; flex: none;
        background: linear-gradient(135deg, #5b5ef4, #8b5cf6);
        display: flex; align-items: center; justify-content: center;
      }
      .ttl { font-weight: 700; font-size: 14px; }
      .ttl span { color: #8b8dff; }
      .x {
        margin-left: auto; cursor: pointer; border: 0; border-radius: 8px;
        background: #1f2230; color: #9498a8; width: 30px; height: 30px;
        font-size: 16px; line-height: 1;
      }
      .x:hover { color: #e9eaf2; }
      .body { padding: 14px 16px; overflow-y: auto; flex: 1; }
      .go {
        width: 100%; padding: 11px 14px; border: 0; border-radius: 9px; cursor: pointer;
        background: linear-gradient(135deg, #5b5ef4, #8b5cf6); color: #fff;
        font-size: 13px; font-weight: 700;
      }
      .go:disabled { opacity: .55; cursor: not-allowed; }
      .muted { color: #9498a8; font-size: 12px; }
      .target {
        display: flex; align-items: center; gap: 7px; margin: 12px 0;
        background: #1f2230; border: 1px solid #2b2d3a; border-radius: 9px; padding: 9px 11px;
      }
      .target b { font-size: 13px; }
      table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      th {
        text-align: left; padding: 7px 8px; color: #9498a8;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
        border-bottom: 1px solid #2b2d3a; background: #1f2230; position: sticky; top: 0;
      }
      td { padding: 7px 8px; border-bottom: 1px solid #2b2d3a; }
      tr:last-child td { border-bottom: 0; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .rank-top { color: #22c55e; font-weight: 700; }
      .rank-none { color: #9498a8; opacity: .6; }
      .spinner {
        width: 15px; height: 15px; border-radius: 50%;
        border: 2px solid #2b2d3a; border-top-color: #8b8dff;
        display: inline-block; vertical-align: -3px; margin-right: 7px;
        animation: rrspin .7s linear infinite;
      }
      @keyframes rrspin { to { transform: rotate(360deg); } }
    </style>
    <button class="fab" id="fab">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9.5" stroke="#fff" stroke-width="1.7" opacity=".55"/>
        <circle cx="12" cy="12" r="5.5" stroke="#fff" stroke-width="1.7" opacity=".85"/>
        <circle cx="12" cy="12" r="2" fill="#fff"/>
        <path d="M12 12 L20 6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>
      </svg>
      RankRadar
    </button>
    <div class="panel" id="panel">
      <div class="head">
        <div class="logo">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.5" stroke="#fff" stroke-width="1.6" opacity=".5"/>
            <circle cx="12" cy="12" r="5.5" stroke="#fff" stroke-width="1.6" opacity=".8"/>
            <circle cx="12" cy="12" r="2" fill="#fff"/>
            <path d="M12 12 L20 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="ttl">Rank<span>Radar</span></div>
        <button class="x" id="close">✕</button>
      </div>
      <div class="body">
        <button class="go" id="go">Подобрать ключи</button>
        <div id="result"></div>
      </div>
    </div>`;

  const fab = root.getElementById('fab');
  const panel = root.getElementById('panel');
  const goBtn = root.getElementById('go');
  const resultEl = root.getElementById('result');

  function renderResult(d) {
    const flag = FLAGS[d.country] || (d.country || '').toUpperCase();
    const rows = (d.keywords || []).map((k) => `<tr>
      <td>${k.term}</td>
      <td class="num ${k.rank ? (k.rank <= 10 ? 'rank-top' : '') : 'rank-none'}">
        ${k.rank ? '#' + k.rank : '—'}</td>
      <td class="num">${k.volume}</td>
      <td class="num">${k.difficulty}</td>
      <td class="num">${k.totalResults}</td>
    </tr>`).join('');
    resultEl.innerHTML = `
      <div class="target">${platformIcon(d.platform)}
        <span>${flag}</span><b>${d.title}</b></div>
      ${rows ? `<table>
        <tr><th>Ключ</th><th class="num">Поз.</th><th class="num">Объём</th>
          <th class="num">Сложн.</th><th class="num">Конк.</th></tr>${rows}</table>
        <p class="muted" style="margin-top:9px">Объём и сложность — приближённые оценки,
        не данные Apple Search Ads.</p>`
        : '<p class="muted">Релевантные ключи не найдены.</p>'}`;
  }

  async function run() {
    const url = location.href;
    if (!isStorePage(url)) {
      resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
        Откройте страницу конкретного приложения в App Store или Google Play.</p>`;
      return;
    }
    goBtn.disabled = true;
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      <span class="spinner"></span>ищем релевантные ключи и метрики… до минуты.</p>`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 150000);
      const res = await fetch(API + '/discover/by-url?url=' + encodeURIComponent(url),
        { signal: ctrl.signal });
      clearTimeout(timer);
      const d = await res.json();
      if (d.error) {
        resultEl.innerHTML = '<p class="muted">Ошибка: ' + d.error + '</p>';
      } else {
        renderResult(d);
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'превышено время ожидания' : (e.message || e);
      resultEl.innerHTML = '<p class="muted">Не удалось получить ключи: ' + msg + '</p>';
    } finally {
      goBtn.disabled = false;
    }
  }

  fab.addEventListener('click', () => {
    panel.classList.add('open');
    fab.style.display = 'none';
  });
  root.getElementById('close').addEventListener('click', () => {
    panel.classList.remove('open');
    fab.style.display = '';
  });
  goBtn.addEventListener('click', run);
})();
