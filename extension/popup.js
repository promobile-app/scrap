// Адрес бэкенда RankRadar на Railway. Поменяйте, если домен другой.
const API = 'https://scrap-production-c0db.up.railway.app';

const goBtn = document.getElementById('go');
const resultEl = document.getElementById('result');
const targetEl = document.getElementById('target');
const kwInput = document.getElementById('kwInput');
const checkBtn = document.getElementById('checkBtn');
const metricResultEl = document.getElementById('metricResult');

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
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
  });
});

// --- Вкладка «Ключи приложения» ---
function renderKeywords(d) {
  targetEl.style.display = 'flex';
  targetEl.innerHTML = `${platformIcon(d.platform)}
    <span>${FLAGS[d.country] || (d.country || '').toUpperCase()}</span>
    <b>${d.title}</b>`;
  const ranked = (d.keywords || []).filter((k) => k.rank != null);
  if (!ranked.length) {
    resultEl.innerHTML = '<p class="muted">Приложение не ранжируется ни по одному из найденных ключей.</p>';
    return;
  }
  resultEl.innerHTML = `
    <p class="muted" style="margin:8px 0">${ranked.length} ключей с позицией
      · из ${(d.keywords || []).length} найденных</p>
    <table>
      <tr><th>Ключ</th><th class="num">Поз.</th><th class="num">Объём</th>
        <th class="num">Сложн.</th><th class="num">Конк.</th></tr>
      ${ranked.map((k) => `<tr>
        <td>${k.term}</td>
        <td class="num ${k.rank <= 10 ? 'rank-top' : ''}">#${k.rank}</td>
        <td class="num">${k.volume}</td>
        <td class="num">${k.difficulty}</td>
        <td class="num">${k.totalResults}</td>
      </tr>`).join('')}
    </table>
    <p class="muted" style="margin-top:9px">Объём и сложность — приближённые оценки,
    не данные Apple Search Ads.</p>`;
}

async function discoverKeywords() {
  const url = await activeTabUrl();
  if (!parsePage(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store (apps.apple.com)
      или Google Play (play.google.com).</p>`;
    return;
  }
  goBtn.disabled = true;
  targetEl.style.display = 'none';
  resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
    <span class="spinner"></span>ищем ключи и метрики (до ~150) — несколько минут.
    Не закрывайте окно.</p>`;
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
        ${d.rank ? '#' + d.rank : '—'}</div><div class="ml">Позиция «${d.term}»</div></div>
      <div class="mtile"><div class="mv">${d.volume ? d.volume.score : '—'}</div>
        <div class="ml">Объём${d.volume ? ' (' + d.volume.source + ')' : ''}</div></div>
      <div class="mtile"><div class="mv">${d.difficulty ? d.difficulty.score : '—'}</div>
        <div class="ml">Сложность</div></div>
      <div class="mtile"><div class="mv">${d.totalResults ?? '—'}</div>
        <div class="ml">Конкурентов</div></div>
    </div>
    ${top ? `<table><tr><th class="num">#</th><th>Топ выдачи по «${d.term}»</th></tr>${top}</table>` : ''}`;
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

goBtn.addEventListener('click', discoverKeywords);
checkBtn.addEventListener('click', checkKeyword);
kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkKeyword(); });

// Подсказываем, если вкладка — не страница магазина.
activeTabUrl().then((url) => {
  if (!parsePage(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store или Google Play.</p>`;
  }
});
