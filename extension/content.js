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

  // Разбор страницы магазина: платформа, ID приложения, гео.
  function parsePage(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase();
      if (h.endsWith('apple.com')) {
        const id = u.pathname.match(/id(\d+)/);
        if (!id || !/\/app\//.test(u.pathname)) return null;
        const country = (u.pathname.match(/\/([a-z]{2})\/app\//i)?.[1] || 'us').toLowerCase();
        return { platform: 'ios', appId: id[1], country };
      }
      if (h.endsWith('play.google.com')) {
        if (!u.pathname.includes('/store/apps/details')) return null;
        const appId = u.searchParams.get('id');
        if (!appId) return null;
        return { platform: 'android', appId, country: (u.searchParams.get('gl') || 'us').toLowerCase() };
      }
    } catch {
      return null;
    }
    return null;
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
        background: linear-gradient(135deg, #4a7bff, #2f5fe0); color: #fff;
        font-size: 13px; font-weight: 700;
        box-shadow: 0 6px 20px rgba(59,110,246,.45); border: 0;
      }
      .fab:hover { transform: translateY(-1px); }
      .fab svg { display: block; }
      .panel {
        position: fixed; top: 0; right: 0; z-index: 2147483647;
        width: 420px; max-width: 100vw; height: 100vh;
        background: #0c0c0f; color: #f1f1f3;
        box-shadow: -10px 0 40px rgba(0,0,0,.5);
        border-radius: 22px 0 0 22px;
        display: flex; flex-direction: column;
        transform: translateX(100%); transition: transform .22s ease;
      }
      .panel.open { transform: translateX(0); }
      .head {
        display: flex; align-items: center; gap: 9px;
        padding: 15px 16px; border-bottom: 1px solid #2c2c31; flex: none;
      }
      .logo {
        width: 30px; height: 30px; border-radius: 11px; flex: none;
        background: linear-gradient(135deg, #4a7bff, #2f5fe0);
        display: flex; align-items: center; justify-content: center;
      }
      .ttl { font-weight: 700; font-size: 14px; }
      .ttl span { color: #5b8bff; }
      .x {
        margin-left: auto; cursor: pointer; border: 0; border-radius: 11px;
        background: #202024; color: #87878f; width: 32px; height: 32px;
        font-size: 16px; line-height: 1;
      }
      .x:hover { color: #f1f1f3; }
      .tabs {
        display: flex; gap: 6px; margin: 12px 16px 0; flex: none;
        background: #202024; padding: 5px; border-radius: 14px;
      }
      .tab {
        flex: 1; padding: 9px 8px; border: 0; cursor: pointer;
        background: transparent; color: #87878f; font-size: 12px; font-weight: 700;
        border-radius: 10px; transition: background .15s, color .15s;
      }
      .tab.active { background: #18181c; color: #f1f1f3; }
      .body { padding: 14px 16px; overflow-y: auto; flex: 1; }
      .pane { display: none; }
      .pane.active { display: block; }
      input {
        width: 100%; padding: 11px 14px; margin-bottom: 10px;
        border: 1px solid #2c2c31; border-radius: 13px; outline: none;
        background: #18181c; color: #f1f1f3; font-size: 13px;
      }
      input:focus { border-color: #3b6ef6; }
      .go {
        width: 100%; padding: 12px 16px; border: 0; border-radius: 15px; cursor: pointer;
        background: #3b6ef6; color: #fff;
        font-size: 13px; font-weight: 700;
      }
      .go:hover { background: #345fdb; }
      .go:disabled { opacity: .55; cursor: not-allowed; }
      .muted { color: #87878f; font-size: 12px; }
      .target {
        display: flex; align-items: center; gap: 8px; margin: 13px 0;
        background: #202024; border: 1px solid #2c2c31; border-radius: 15px; padding: 11px 13px;
      }
      .target b { font-size: 13px; }
      .mgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 13px 0; }
      .mtile {
        background: #202024; border: 1px solid #2c2c31; border-radius: 18px;
        padding: 14px 15px;
      }
      .mtile .mv { font-size: 22px; font-weight: 800; line-height: 1; }
      .mtile .ml { font-size: 11px; color: #87878f; margin-top: 6px; font-weight: 600; }
      .tw {
        border: 1px solid #2c2c31; border-radius: 16px;
        overflow: hidden; margin-top: 12px;
      }
      table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      th {
        text-align: left; padding: 9px 11px; color: #87878f;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
        border-bottom: 1px solid #2c2c31; background: #202024;
      }
      td { padding: 9px 11px; border-bottom: 1px solid #2c2c31; }
      tr:last-child td { border-bottom: 0; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .rank-top { color: #22c55e; font-weight: 700; }
      .tgt { color: #5b8bff; font-weight: 700; }
      .spinner {
        width: 15px; height: 15px; border-radius: 50%;
        border: 2px solid #2c2c31; border-top-color: #5b8bff;
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
      <div class="tabs">
        <button class="tab active" data-tab="kw">Ключи приложения</button>
        <button class="tab" data-tab="metric">Метрики по ключу</button>
      </div>
      <div class="body">
        <div class="pane active" id="pane-kw">
          <button class="go" id="go">Подобрать ключи</button>
          <div id="result"></div>
        </div>
        <div class="pane" id="pane-metric">
          <input id="kwInput" placeholder="ключевое слово" />
          <button class="go" id="checkBtn">Проверить позицию</button>
          <div id="metricResult"></div>
        </div>
      </div>
    </div>`;

  const fab = root.getElementById('fab');
  const panel = root.getElementById('panel');
  const goBtn = root.getElementById('go');
  const resultEl = root.getElementById('result');
  const kwInput = root.getElementById('kwInput');
  const checkBtn = root.getElementById('checkBtn');
  const metricResultEl = root.getElementById('metricResult');

  // --- Вкладки ---
  root.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      root.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      root.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      root.getElementById('pane-' + tab.dataset.tab).classList.add('active');
    });
  });

  // --- Вкладка «Ключи приложения» ---
  function renderKeywords(d) {
    const flag = FLAGS[d.country] || (d.country || '').toUpperCase();
    const ranked = (d.keywords || []).filter((k) => k.rank != null);
    const rows = ranked.map((k) => `<tr>
      <td>${k.term}</td>
      <td class="num ${k.rank <= 10 ? 'rank-top' : ''}">#${k.rank}</td>
      <td class="num">${k.volume}</td>
      <td class="num">${k.difficulty}</td>
      <td class="num">${k.totalResults}</td>
    </tr>`).join('');
    resultEl.innerHTML = `
      <div class="target">${platformIcon(d.platform)}
        <span>${flag}</span><b>${d.title}</b></div>
      ${rows ? `<p class="muted" style="margin:0 0 8px">${ranked.length} ключей с позицией
        · из ${(d.keywords || []).length} найденных</p>
        <div class="tw"><table>
        <tr><th>Ключ</th><th class="num">Поз.</th><th class="num">Объём</th>
          <th class="num">Сложн.</th><th class="num">Конк.</th></tr>${rows}</table></div>
        <p class="muted" style="margin-top:9px">Объём и сложность — приближённые оценки,
        не данные Apple Search Ads.</p>`
        : '<p class="muted">Приложение не ранжируется ни по одному из найденных ключей.</p>'}`;
  }

  async function discoverKeywords() {
    const url = location.href;
    if (!parsePage(url)) {
      resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
        Откройте страницу конкретного приложения в App Store или Google Play.</p>`;
      return;
    }
    goBtn.disabled = true;
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      <span class="spinner"></span>ищем ключи и метрики (до ~150) — несколько минут.</p>`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 420000);
      const res = await fetch(API + '/discover/by-url?url=' + encodeURIComponent(url),
        { signal: ctrl.signal });
      clearTimeout(timer);
      const d = await res.json();
      if (d.error) resultEl.innerHTML = '<p class="muted">Ошибка: ' + d.error + '</p>';
      else renderKeywords(d);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'превышено время ожидания' : (e.message || e);
      resultEl.innerHTML = '<p class="muted">Не удалось получить ключи: ' + msg + '</p>';
    } finally {
      goBtn.disabled = false;
    }
  }

  // --- Вкладка «Метрики по ключу» ---
  function renderMetric(d) {
    const top = (d.topApps || []).map((a) => `<tr>
      <td class="num">${a.position}</td>
      <td class="${a.isTarget ? 'tgt' : ''}">${a.isTarget ? '▶ ' : ''}${a.title}</td>
    </tr>`).join('');
    metricResultEl.innerHTML = `
      <div class="target">${platformIcon(d.platform)}
        <span>${FLAGS[d.country] || (d.country || '').toUpperCase()}</span>
        <b>${d.app ? d.app.title : ''}</b></div>
      <div class="mgrid">
        <div class="mtile"><div class="mv ${d.rank ? (d.inTop10 ? 'rank-top' : '') : ''}">
          ${d.rank ? '#' + d.rank : '—'}</div><div class="ml">${d.rank
            ? 'Позиция «' + d.term + '»'
            : '«' + d.term + '» — вне выдачи (топ-' + (d.totalResults ?? '?') + ')'}</div></div>
        <div class="mtile"><div class="mv">${d.volume ? d.volume.score : '—'}</div>
          <div class="ml">Объём${d.volume ? ' (' + d.volume.source + ')' : ''}</div></div>
        <div class="mtile"><div class="mv">${d.difficulty ? d.difficulty.score : '—'}</div>
          <div class="ml">Сложность</div></div>
        <div class="mtile"><div class="mv">${d.totalResults ?? '—'}</div>
          <div class="ml">Конкурентов</div></div>
      </div>
      ${top ? `<div class="tw"><table>
        <tr><th class="num">#</th><th>Топ выдачи по «${d.term}»</th></tr>${top}</table></div>` : ''}`;
  }

  async function checkKeyword() {
    const term = kwInput.value.trim();
    if (!term) return;
    const p = parsePage(location.href);
    if (!p) {
      metricResultEl.innerHTML = `<p class="muted" style="margin-top:12px">
        Откройте страницу конкретного приложения в App Store или Google Play.</p>`;
      return;
    }
    checkBtn.disabled = true;
    metricResultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      <span class="spinner"></span>считаем метрики…</p>`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      const q = `country=${p.country}&platform=${p.platform}&term=${encodeURIComponent(term)}`;
      const res = await fetch(
        `${API}/apps/${encodeURIComponent(p.appId)}/metrics?${q}`, { signal: ctrl.signal });
      clearTimeout(timer);
      const d = await res.json();
      if (d.error) metricResultEl.innerHTML = '<p class="muted">Ошибка: ' + d.error + '</p>';
      else renderMetric(d);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'превышено время ожидания' : (e.message || e);
      metricResultEl.innerHTML = '<p class="muted">Не удалось посчитать метрики: ' + msg + '</p>';
    } finally {
      checkBtn.disabled = false;
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
  goBtn.addEventListener('click', discoverKeywords);
  checkBtn.addEventListener('click', checkKeyword);
  kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkKeyword(); });
})();
