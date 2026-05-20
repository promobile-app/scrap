// Адрес бэкенда RankRadar на Railway. Поменяйте, если домен другой.
const API = 'https://scrap-production-c0db.up.railway.app';

const goBtn = document.getElementById('go');
const recalcBtn = document.getElementById('recalcBtn');
const resultEl = document.getElementById('result');
const targetEl = document.getElementById('target');
const kwInput = document.getElementById('kwInput');
const checkBtn = document.getElementById('checkBtn');
const metricResultEl = document.getElementById('metricResult');
const histResult = document.getElementById('histResult');
const histRefresh = document.getElementById('histRefresh');

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

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

// --- Вкладки ---
let histLoaded = false;
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'hist' && !histLoaded) {
      histLoaded = true;
      loadHistory();
    }
  });
});

// Мини-спарклайн динамики позиции.
function miniSpark(history) {
  const pts = (history || []).filter((h) => h.rank != null);
  if (pts.length < 2) return '<span style="width:64px;flex:none"></span>';
  const W = 64, H = 22;
  const ranks = pts.map((p) => p.rank);
  const mn = Math.min(...ranks), mx = Math.max(...ranks);
  const fx = (i) => (i * W) / (pts.length - 1);
  const fy = (r) => (mx === mn ? H / 2 : 3 + ((r - mn) / (mx - mn)) * (H - 6));
  const line = pts.map((p, i) => `${fx(i).toFixed(1)},${fy(p.rank).toFixed(1)}`).join(' ');
  return `<svg width="${W}" height="${H}" style="flex:none">
    <polyline points="${line}" fill="none" stroke="#5b8bff" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// --- Вкладка «История» (общая с дашбордом — одна БД) ---
async function loadHistory() {
  histResult.innerHTML = '<p class="muted" style="margin-top:12px"><span class="spinner"></span>загрузка…</p>';
  try {
    const d = await fetch(API + '/history/all').then((r) => r.json());
    const items = d.items || [];
    if (!items.length) {
      histResult.innerHTML = '<p class="muted" style="margin-top:12px">Пока нет сохранённых замеров.</p>';
      return;
    }
    histResult.innerHTML = items.map((it) => {
      const hist = it.history || [];
      const last = hist[hist.length - 1] || {};
      const flag = FLAGS[it.country] || (it.country || '').toUpperCase();
      return `<div class="hrow">
        <div class="hmain">
          <div class="ht">${platformIcon(it.platform)} ${flag} «${it.term}»</div>
          <div class="hs">${it.appTitle || it.appId}</div>
        </div>
        ${miniSpark(hist)}
        <div class="hr ${last.rank ? (last.rank <= 10 ? 'rank-top' : '') : ''}">
          ${last.rank ? '#' + last.rank : '—'}</div>
      </div>`;
    }).join('');
  } catch (e) {
    histResult.innerHTML = '<p class="muted">Не удалось загрузить историю: ' + (e.message || e) + '</p>';
  }
}

// Скачивание CSV: тянем файл и сохраняем через blob-ссылку.
async function exportCsv(url, filename) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) {
    alert('Не удалось выгрузить CSV: ' + (e.message || e));
  }
}

// --- Вкладка «Ключи приложения» ---
function renderKeywords(d) {
  targetEl.style.display = 'flex';
  targetEl.innerHTML = `${platformIcon(d.platform)}
    <span>${FLAGS[d.country] || (d.country || '').toUpperCase()}</span>
    <b>${d.appTitle || d.appId}</b>`;
  const ranked = (d.keywords || []).filter((k) => k.rank != null);
  const queued = d.status === 'pending';
  const running = d.status === 'running';
  const active = queued || running;
  const head = queued
    ? `<p class="muted" style="margin:8px 0"><span class="spinner"></span>в очереди — ждём свободный слот…</p>`
    : running
      ? `<p class="muted" style="margin:8px 0"><span class="spinner"></span>идёт подбор:
         ${d.processed} / ${d.total || '…'} — заполняется на ходу</p>`
      : `<p class="muted" style="margin:8px 0">${ranked.length} ключей с позицией
         · из ${(d.keywords || []).length} найденных</p>`;
  if (!ranked.length) {
    resultEl.innerHTML = head + (active ? '' :
      '<p class="muted">Приложение не ранжируется ни по одному из найденных ключей.</p>');
    return;
  }
  const sBtn = 'padding:8px 12px;border-radius:11px;background:var(--surface-2);'
    + 'color:var(--ink);border:1px solid var(--line);font-weight:700;font-size:12px;cursor:pointer';
  const exportRow = active ? '' : `<div style="display:flex;gap:8px;margin:10px 0 2px">
    <button style="${sBtn}" onclick="exportCsv('${API}/discover/job/${d.jobId}/export.csv','keywords-${d.appId}.csv')">⬇ Экспорт CSV</button>
    <button style="${sBtn}" onclick="exportCsv('${API}/discover/export.csv','all-keywords.csv')">Все приложения</button>
  </div>`;
  resultEl.innerHTML = `
    ${head}
    ${exportRow}
    <div class="tw"><table>
      <tr><th>Ключ</th><th class="num">Поз.</th><th class="num">Объём</th>
        <th class="num">Сложн.</th><th class="num">Конк.</th></tr>
      ${ranked.map((k) => `<tr>
        <td>${k.term}</td>
        <td class="num ${k.rank <= 10 ? 'rank-top' : ''}">#${k.rank}</td>
        <td class="num">${k.volume}</td>
        <td class="num">${k.difficulty}</td>
        <td class="num">${k.totalResults}</td>
      </tr>`).join('')}
    </table></div>
    <p class="muted" style="margin-top:9px">Объём и сложность — приближённые оценки,
    не данные Apple Search Ads.</p>`;
}

async function discoverKeywords(force) {
  const url = await activeTabUrl();
  if (!parsePage(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store (apps.apple.com)
      или Google Play (play.google.com).</p>`;
    return;
  }
  goBtn.disabled = true;
  recalcBtn.disabled = true;
  targetEl.style.display = 'none';
  resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
    <span class="spinner"></span>запускаем подбор ключей…</p>`;
  try {
    let state = await fetch(API + '/discover/by-url?url=' + encodeURIComponent(url)
      + (force ? '&fresh=1' : '')).then((r) => r.json());
    if (state.error) {
      resultEl.innerHTML = '<p class="muted">Ошибка: ' + state.error + '</p>';
      return;
    }
    renderKeywords(state);
    let guard = 0;
    while ((state.status === 'pending' || state.status === 'running') && guard < 500) {
      guard++;
      await new Promise((r) => setTimeout(r, 4000));
      state = await fetch(API + '/discover/job/' + state.jobId).then((r) => r.json());
      if (state.error && !state.jobId) break;
      renderKeywords(state);
    }
    if (state.status === 'error') {
      resultEl.innerHTML = '<p class="muted">Ошибка подбора: ' + (state.error || '') + '</p>';
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="muted">Не удалось получить ключи: ' + (e.message || e) + '</p>';
  } finally {
    goBtn.disabled = false;
    recalcBtn.disabled = false;
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
  const url = await activeTabUrl();
  const p = parsePage(url);
  if (!p) {
    metricResultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store или Google Play.</p>`;
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

goBtn.addEventListener('click', () => discoverKeywords(false));
recalcBtn.addEventListener('click', () => discoverKeywords(true));
checkBtn.addEventListener('click', checkKeyword);
kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkKeyword(); });
histRefresh.addEventListener('click', () => { histLoaded = true; loadHistory(); });

// Подсказываем, если вкладка — не страница магазина.
activeTabUrl().then((url) => {
  if (!parsePage(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store или Google Play.</p>`;
  }
});
