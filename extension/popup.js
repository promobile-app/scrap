// RankRadar Chrome Extension — ASO keyword analyzer.
// Flow по плану: auth → auto-analyze → summary → paywall → unlocked + .xlsx.

const API = 'https://scrap-production-c0db.up.railway.app';

const FLAGS = {
  us: '🇺🇸', gb: '🇬🇧', de: '🇩🇪', ua: '🇺🇦', ru: '🇷🇺', fr: '🇫🇷', pl: '🇵🇱',
  es: '🇪🇸', it: '🇮🇹', ca: '🇨🇦', br: '🇧🇷', in: '🇮🇳', jp: '🇯🇵', tr: '🇹🇷',
};

// chrome.storage недоступен на open-in-browser preview — даём fallback на localStorage.
const storage = {
  get(keys) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }
    const out = {};
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
      const v = localStorage.getItem('rr_' + k);
      if (v != null) {
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      }
    });
    return Promise.resolve(out);
  },
  set(obj) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    }
    Object.entries(obj).forEach(([k, v]) => {
      localStorage.setItem('rr_' + k, JSON.stringify(v));
    });
    return Promise.resolve();
  },
  remove(keys) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
    }
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => localStorage.removeItem('rr_' + k));
    return Promise.resolve();
  },
};

// --- DOM ---
const screens = {
  auth: document.getElementById('screen-auth'),
  unsupported: document.getElementById('screen-unsupported'),
  loading: document.getElementById('screen-loading'),
  summary: document.getElementById('screen-summary'),
  payment: document.getElementById('screen-payment'),
  unlocked: document.getElementById('screen-unlocked'),
  error: document.getElementById('screen-error'),
};

function show(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
}

const userbarEl = document.getElementById('userbar');

// --- State ---
let token = null;
let userEmail = null;
let currentJobId = null;
let currentPaymentId = null;
let pollAnalysisTimer = null;
let pollPaymentTimer = null;
let analysisStartedAt = 0;

// --- API helper ---
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function logEvent(event, payload = {}) {
  fetch(API + '/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ event, payload }),
  }).catch(() => {});
}

// --- Store-page parsing (popup нужен лишь URL активной вкладки) ---
function parsePage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.endsWith('apple.com')) {
      const id = u.pathname.match(/id(\d+)/);
      if (!id || !/\/app\//.test(u.pathname)) return null;
      const country = (u.pathname.match(/\/([a-z]{2})\/app\//i)?.[1] || 'us').toLowerCase();
      const language = u.searchParams.get('l') || null;
      return { platform: 'ios', appId: id[1], country, language };
    }
    if (h.endsWith('play.google.com')) {
      if (!u.pathname.includes('/store/apps/details')) return null;
      const appId = u.searchParams.get('id');
      if (!appId) return null;
      const country = (u.searchParams.get('gl') || 'us').toLowerCase();
      const language = u.searchParams.get('hl') || null;
      return { platform: 'android', appId, country, language };
    }
  } catch { return null; }
  return null;
}

async function activeTabUrl() {
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ?? '';
  }
  return location.href; // preview-режим
}

function openTab(url) {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank');
  }
}

function appCardHtml(d) {
  const flag = FLAGS[d.country] || (d.country || '').toUpperCase();
  const platformIcon = d.platform === 'android'
    ? '<span style="color:#34A853;font-weight:700">▶</span>'
    : '<span style="color:#1f9bf5;font-weight:700">A</span>';
  return `${platformIcon}
    <span>${flag}</span>
    <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ${d.appTitle || d.appId}</b>`;
}

// --- AUTH SCREEN ---
let authMode = 'login'; // 'login' | 'register'

const authTitleEl = document.getElementById('auth-title');
const authSubmitEl = document.getElementById('auth-submit');
const authSwitchEl = document.getElementById('auth-switch');
const authSwitchTextEl = document.getElementById('auth-switch-text');
const authErrEl = document.getElementById('auth-err');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');

function renderAuthMode() {
  if (authMode === 'login') {
    authTitleEl.textContent = 'Sign in';
    authSubmitEl.textContent = 'Sign in';
    authSwitchTextEl.textContent = 'No account?';
    authSwitchEl.textContent = 'Create one';
  } else {
    authTitleEl.textContent = 'Create account';
    authSubmitEl.textContent = 'Create account';
    authSwitchTextEl.textContent = 'Have an account?';
    authSwitchEl.textContent = 'Sign in';
  }
  authErrEl.style.display = 'none';
}

authSwitchEl.addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  renderAuthMode();
});

authSubmitEl.addEventListener('click', submitAuth);
passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

async function submitAuth() {
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || !password) {
    authErrEl.textContent = 'Email and password are required';
    authErrEl.style.display = 'block';
    return;
  }
  authSubmitEl.disabled = true;
  try {
    const path = authMode === 'login' ? '/auth/login' : '/auth/register';
    const d = await api(path, { method: 'POST', body: JSON.stringify({ email, password }) });
    token = d.token;
    userEmail = d.user.email;
    await storage.set({ token, userEmail });
    renderUserbar();
    boot();
  } catch (e) {
    authErrEl.textContent = e.message || 'Auth failed';
    authErrEl.style.display = 'block';
  } finally {
    authSubmitEl.disabled = false;
  }
}

function renderUserbar() {
  if (!userEmail) { userbarEl.innerHTML = ''; return; }
  userbarEl.innerHTML = `${userEmail.split('@')[0]} · <a id="logout">log out</a>`;
  document.getElementById('logout').addEventListener('click', logout);
}

async function logout() {
  await storage.remove(['token', 'userEmail']);
  token = null;
  userEmail = null;
  renderUserbar();
  stopAllPolling();
  show('auth');
  renderAuthMode();
}

// --- ANALYSIS ---
function setProgress(state) {
  const total = state.total || 0;
  const processed = state.processed || 0;
  let pct = 5;
  if (state.status === 'pending') pct = 8;
  else if (state.status === 'running') {
    pct = total > 0 ? Math.min(95, 10 + (processed / total) * 80) : 30;
  } else if (state.status === 'done') pct = 100;
  document.getElementById('progress-bar').style.width = pct + '%';
  const stage = document.getElementById('stage');
  if (state.status === 'pending') stage.textContent = 'Queued — waiting for a free slot...';
  else if (state.status === 'running')
    stage.textContent = total
      ? `Analyzing keyword rankings... ${processed} / ${total}`
      : 'Fetching app data...';
  else if (state.status === 'done') stage.textContent = 'Preparing report...';
  const appBox = document.getElementById('loading-app');
  if (state.appTitle) {
    appBox.innerHTML = appCardHtml(state);
    appBox.style.display = 'flex';
  }
}

function stopAllPolling() {
  if (pollAnalysisTimer) { clearTimeout(pollAnalysisTimer); pollAnalysisTimer = null; }
  if (pollPaymentTimer) { clearTimeout(pollPaymentTimer); pollPaymentTimer = null; }
}

async function startAnalysis(force = false) {
  stopAllPolling();
  const url = await activeTabUrl();
  if (!parsePage(url)) {
    show('unsupported');
    return;
  }
  show('loading');
  setProgress({ status: 'pending', processed: 0, total: 0 });
  analysisStartedAt = Date.now();
  logEvent('analysis_started', { url });
  try {
    const state = await api('/ext/analyze?url=' + encodeURIComponent(url) + (force ? '&fresh=1' : ''));
    currentJobId = state.jobId;
    await storage.set({ lastJobId: currentJobId });
    handleJobState(state);
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
    showError(e.message || 'Service is temporarily unavailable. Please try again later.');
  }
}

async function pollJob() {
  if (!currentJobId) return;
  if (Date.now() - analysisStartedAt > 90_000) {
    showError('Analysis is taking longer than expected.\nPlease try again later.');
    return;
  }
  try {
    const state = await api('/ext/job/' + currentJobId);
    handleJobState(state);
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
    if (e.status === 404) { showError('Job not found.'); return; }
    // Сеть/бэк недоступен — продолжаем поллить мягко.
    pollAnalysisTimer = setTimeout(pollJob, 4000);
  }
}

function handleJobState(state) {
  if (state.status === 'pending' || state.status === 'running') {
    setProgress(state);
    // Бэкенд ускорен (кэш app-info + пул слотов) — джоб обновляется чаще,
    // поэтому поллим живее для отзывчивого прогресс-бара.
    pollAnalysisTimer = setTimeout(pollJob, 1500);
    return;
  }
  if (state.status === 'error') {
    showError(state.error || 'Analysis failed. Please try again.');
    return;
  }
  // done
  logEvent('analysis_completed', { jobId: state.jobId });
  if (state.paid) renderUnlocked(state);
  else renderSummary(state);
}

// --- SUMMARY ---
function renderSummary(state) {
  show('summary');
  document.getElementById('summary-app').innerHTML = appCardHtml(state);
  const s = state.summary || { rankedKeywords: 0, top3: 0, top10: 0 };
  document.getElementById('m-ranked').textContent = s.rankedKeywords;
  document.getElementById('m-top3').textContent = s.top3;
  document.getElementById('m-top10').textContent = s.top10;
  document.getElementById('summary-empty').style.display =
    s.rankedKeywords === 0 ? 'block' : 'none';
}

document.getElementById('unlock-btn').addEventListener('click', startCheckout);
document.getElementById('reanalyze-btn').addEventListener('click', () => startAnalysis(true));

// --- PAYMENT ---
async function startCheckout() {
  if (!currentJobId) return;
  logEvent('payment_started', { jobId: currentJobId });
  try {
    const d = await api('/payment/checkout', {
      method: 'POST',
      body: JSON.stringify({ jobId: currentJobId }),
    });
    currentPaymentId = d.paymentId;
    openTab(API + d.checkoutUrl);
    show('payment');
    pollPaymentTimer = setTimeout(pollPayment, 2500);
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
    showError(e.message || 'Could not start payment.');
  }
}

async function pollPayment() {
  if (!currentPaymentId) return;
  try {
    const d = await api('/payment/status/' + currentPaymentId);
    if (d.status === 'success') {
      logEvent('payment_success', { paymentId: currentPaymentId });
      const job = await api('/ext/job/' + currentJobId);
      renderUnlocked(job);
      return;
    }
    if (d.status === 'failed') {
      logEvent('payment_failed', { paymentId: currentPaymentId });
      showError('Payment failed.\nPlease try again.');
      return;
    }
    pollPaymentTimer = setTimeout(pollPayment, 2500);
  } catch {
    pollPaymentTimer = setTimeout(pollPayment, 4000);
  }
}

document.getElementById('payment-cancel').addEventListener('click', () => {
  stopAllPolling();
  currentPaymentId = null;
  // Возвращаемся к summary текущей job.
  if (currentJobId) {
    api('/ext/job/' + currentJobId).then(handleJobState).catch(() => show('error'));
  }
});

// --- UNLOCKED ---
let unlockedKeywords = [];      // ВСЕ ключи (ранжированные + возможности), отсортированы
let unlockedFilter = 'all';     // 'all' | 'ranked' | 'top3' | 'top10'
let currentApp = { appId: '', country: 'us', platform: 'ios' }; // для SERP-запросов
let expandedTerm = null;        // развёрнутый ключ (показываем топ выдачи)
const serpCache = {};           // term -> { loading?, error?, total?, apps? }
let currentGoal = 'rank_up';    // 'rank_up' | 'expand' | 'defend'
let currentLang = 'en';         // 'en' | 'ru' — язык инсайтов и подписей
let langExplicit = false;       // пользователь выбрал язык вручную (не трогаем автодетект)
let insightsByGoal = {};        // (goal|lang) -> ответ /ext/insights (для текущей job)
let insightsReq = 0;            // токен против гонки при быстром переключении goal/языка

// Подписи интерфейса инсайтов. Пояснения и summary приходят с бэкенда по locale.
const I18N = {
  en: {
    goals: { rank_up: 'Rank up', expand: 'Expand', defend: 'Defend' },
    download: '⬇ Download Excel', reanalyze: '↻ Re-analyze',
    aiOn: 'AI', aiOff: 'rules',
    serpLoading: 'Loading results…', serpError: "Couldn't load results.", serpTop: 'Top results for',
    tbl: { keyword: 'Keyword', rank: 'Rank', demand: 'Demand', diff: 'Diff' },
    kwEmpty: { all: 'No keywords found.', ranked: 'No ranked keywords.', top3: 'No keywords in Top 3.', top10: 'No keywords in Top 10.' },
    quadCap: 'Quadrant', quadAxis: '· demand × difficulty',
    quad: { quickWins: 'Quick wins', longShots: 'Long shots', pushNow: 'Push now', ignore: 'Ignore' },
    plan: 'Action plan',
    dq: { estimated: 'estimated data', measured: 'measured data' },
    move: { 'push-qw': 'Push · quick win', push: 'Push', monitor: 'Monitor', skip: 'Skip' },
    loading: 'Building your action plan…',
    errText: "Couldn't build the action plan.", retry: 'Retry',
  },
  ru: {
    goals: { rank_up: 'Рост', expand: 'Охват', defend: 'Защита' },
    download: '⬇ Скачать Excel', reanalyze: '↻ Пересчитать',
    aiOn: 'AI', aiOff: 'правила',
    serpLoading: 'Загружаю выдачу…', serpError: 'Не удалось загрузить выдачу.', serpTop: 'Топ выдачи по',
    tbl: { keyword: 'Ключ', rank: 'Поз.', demand: 'Спрос', diff: 'Слож.' },
    kwEmpty: { all: 'Ключи не найдены.', ranked: 'Нет ранжированных ключей.', top3: 'Нет ключей в топ-3.', top10: 'Нет ключей в топ-10.' },
    quadCap: 'Квадрант', quadAxis: '· спрос × сложность',
    quad: { quickWins: 'Быстрые победы', longShots: 'Тяжёлая ниша', pushNow: 'Качать сейчас', ignore: 'Пропустить' },
    plan: 'План действий',
    dq: { estimated: 'оценочные данные', measured: 'точные данные' },
    move: { 'push-qw': 'Качать · быстрая победа', push: 'Качать', monitor: 'Держать', skip: 'Пропустить' },
    loading: 'Готовлю план действий…',
    errText: 'Не удалось построить план.', retry: 'Повторить',
  },
};
const t = () => I18N[currentLang] || I18N.en;
const RU_COUNTRIES = new Set(['ru', 'ua', 'by', 'kz']);

function renderUnlocked(state) {
  show('unlocked');
  document.getElementById('unlocked-app').innerHTML = appCardHtml(state);
  const s = state.summary || { rankedKeywords: 0, top3: 0, top10: 0 };
  document.getElementById('u-ranked').textContent = s.rankedKeywords;
  document.getElementById('u-top3').textContent = s.top3;
  document.getElementById('u-top10').textContent = s.top10;
  // Контекст приложения для разворота выдачи по ключу.
  currentApp = {
    appId: String(state.appId || ''),
    country: state.country || 'us',
    platform: state.platform === 'android' ? 'android' : 'ios',
  };
  expandedTerm = null;
  // Полный список: сначала ранжированные по позиции (1→100), затем возможности
  // (без позиции) по убыванию спроса.
  unlockedKeywords = [...(state.keywords || [])].sort((a, b) => {
    const ar = a.rank == null, br = b.rank == null;
    if (ar !== br) return ar ? 1 : -1;
    if (!ar && a.rank !== b.rank) return a.rank - b.rank;
    return (b.volume || 0) - (a.volume || 0);
  });
  unlockedFilter = 'all';
  renderKwTable();

  // AI-план: сбрасываем кэш под новую job, ставим goal по умолчанию и грузим.
  insightsByGoal = {};
  currentGoal = 'rank_up';
  // Язык: уважаем явный выбор пользователя, иначе автодетект по стране витрины.
  if (!langExplicit) currentLang = RU_COUNTRIES.has((state.country || '').toLowerCase()) ? 'ru' : 'en';
  document.querySelectorAll('.goal-pill').forEach((p) =>
    p.classList.toggle('active', p.dataset.goal === currentGoal));
  renderLangUI();
  document.getElementById('ai-insights').innerHTML = '';
  loadInsights();
}

function renderKwTable() {
  const list = document.getElementById('kw-list');
  if (!list) return;
  // Подсветка активного тайла (ни один не активен при показе всех).
  ['ranked', 'top3', 'top10'].forEach((f) => {
    document.getElementById('u-tile-' + f).classList.toggle('active', unlockedFilter === f);
  });
  let rows = unlockedKeywords;
  if (unlockedFilter === 'ranked') rows = rows.filter((k) => k.rank != null);
  else if (unlockedFilter === 'top3') rows = rows.filter((k) => k.rank != null && k.rank <= 3);
  else if (unlockedFilter === 'top10') rows = rows.filter((k) => k.rank != null && k.rank <= 10);

  const L = t().tbl;
  if (!rows.length) {
    list.innerHTML = `<p class="muted" style="padding:14px;text-align:center">${t().kwEmpty[unlockedFilter] || t().kwEmpty.all}</p>`;
    return;
  }
  list.innerHTML = `<table>
    <thead><tr>
      <th>${L.keyword}</th>
      <th class="num">${L.rank}</th>
      <th class="num">${L.demand}</th>
      <th class="num">${L.diff}</th>
    </tr></thead>
    <tbody>${rows.map((k) => {
      const open = expandedTerm === k.term;
      const main = `<tr class="kw-row${open ? ' open' : ''}" data-term="${escAttr(k.term)}">
        <td class="kw-term" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(k.term)}</td>
        <td class="num ${k.rank != null && k.rank <= 10 ? 'rank-top' : ''}">${k.rank != null ? '#' + k.rank : '—'}</td>
        <td class="num">${k.volume != null ? k.volume : '—'}</td>
        <td class="num">${k.difficulty != null ? k.difficulty : '—'}</td>
      </tr>`;
      const detail = open ? `<tr class="serp-row"><td colspan="4">${serpHtml(k.term)}</td></tr>` : '';
      return main + detail;
    }).join('')}</tbody></table>`;
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

// HTML топа выдачи по ключу (внутри развёрнутой строки).
function serpHtml(term) {
  const s = serpCache[term];
  if (!s || s.loading) return `<div class="serp-load"><span class="spinner"></span> ${t().serpLoading}</div>`;
  if (s.error) return `<div class="serp-load">${t().serpError}</div>`;
  if (!s.apps || !s.apps.length) return '<div class="serp-load">—</div>';
  const head = `<div class="serp-head">${t().serpTop} «${escHtml(term)}» · ${s.apps.length}/${s.total}</div>`;
  const items = s.apps.map((a) => `<div class="serp-item${a.isTarget ? ' me' : ''}">
    <span class="sp-pos">${a.position}</span>
    <span class="sp-title">${escHtml(a.title)}</span>
  </div>`).join('');
  return head + `<div class="serp">${items}</div>`;
}

function toggleSerp(term) {
  if (expandedTerm === term) { expandedTerm = null; renderKwTable(); return; }
  expandedTerm = term;
  renderKwTable();
  if (!serpCache[term]) loadSerp(term);
}

async function loadSerp(term) {
  serpCache[term] = { loading: true };
  if (expandedTerm === term) renderKwTable();
  try {
    const q = 'term=' + encodeURIComponent(term)
      + '&country=' + encodeURIComponent(currentApp.country)
      + '&platform=' + currentApp.platform
      + '&appId=' + encodeURIComponent(currentApp.appId);
    const d = await api('/ext/keyword-apps?' + q);
    serpCache[term] = { apps: d.apps || [], total: d.total || (d.apps || []).length };
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
    serpCache[term] = { error: true };
  }
  if (expandedTerm === term) renderKwTable();
}

// Делегирование клика по строкам таблицы — раскрытие выдачи.
document.getElementById('kw-list').addEventListener('click', (e) => {
  const row = e.target.closest && e.target.closest('tr.kw-row');
  if (!row) return;
  const term = row.getAttribute('data-term');
  if (term != null) toggleSerp(term);
});

function setKwFilter(f) {
  unlockedFilter = unlockedFilter === f ? 'all' : f;
  renderKwTable();
}
document.getElementById('u-tile-ranked').addEventListener('click', () => setKwFilter('ranked'));
document.getElementById('u-tile-top3').addEventListener('click', () => setKwFilter('top3'));
document.getElementById('u-tile-top10').addEventListener('click', () => setKwFilter('top10'));

// --- AI INSIGHTS (action plan) ---
document.querySelectorAll('.goal-pill').forEach((el) => {
  el.addEventListener('click', () => {
    if (el.classList.contains('active')) return;
    currentGoal = el.dataset.goal;
    document.querySelectorAll('.goal-pill').forEach((p) => p.classList.toggle('active', p === el));
    loadInsights();
  });
});

// Переключатель языка EN/RU — меняет и пояснения (locale на бэкенд), и подписи.
document.querySelectorAll('#lang-seg button').forEach((el) => {
  el.addEventListener('click', () => {
    if (el.dataset.lang === currentLang) return;
    currentLang = el.dataset.lang;
    langExplicit = true;
    storage.set({ insightsLang: currentLang });
    renderLangUI();
    loadInsights();
  });
});

// Применяет язык к статичным подписям (пилюли цели + активная кнопка языка).
function renderLangUI() {
  document.querySelectorAll('.goal-pill').forEach((p) => {
    p.textContent = t().goals[p.dataset.goal] || p.textContent;
  });
  document.querySelectorAll('#lang-seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
  // Локализуем кнопки действий под таблицей.
  const dl = document.getElementById('download-btn');
  if (dl) dl.textContent = t().download;
  const re = document.getElementById('u-reanalyze-btn');
  if (re) re.textContent = t().reanalyze;
  // Перерисовать таблицу ключей — её заголовки тоже локализованы.
  if (unlockedKeywords && unlockedKeywords.length) renderKwTable();
}

function moveClass(action, quickWins) {
  if (action.move === 'monitor') return 'monitor';
  if (action.move === 'skip') return 'skip';
  return quickWins.has(action.term) ? 'push-qw' : 'push';
}
function moveLabel(cls) {
  return t().move[cls] || cls;
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadInsights() {
  const box = document.getElementById('ai-insights');
  if (!box || !currentJobId) { if (box) box.innerHTML = ''; return; }
  const goal = currentGoal;
  const lang = currentLang;
  const key = goal + '|' + lang;
  if (insightsByGoal[key]) { renderInsights(insightsByGoal[key]); return; }
  const reqId = ++insightsReq;
  box.innerHTML = `<div class="ai-loading"><span class="spinner"></span> ${t().loading}</div>`;
  try {
    const data = await api('/ext/insights', {
      method: 'POST',
      body: JSON.stringify({ jobId: currentJobId, goal, lang }),
    });
    insightsByGoal[key] = data;
    if (reqId === insightsReq && goal === currentGoal && lang === currentLang) renderInsights(data);
  } catch (e) {
    if (reqId !== insightsReq) return; // ответ устарел — пользователь сменил goal/язык
    if (e.status === 401) { await logout(); return; }
    box.innerHTML = `<div class="ai-loading">${t().errText} `
      + `<a class="ai-retry" style="color:#5b8bff;cursor:pointer">${t().retry}</a></div>`;
    const r = box.querySelector('.ai-retry');
    if (r) r.addEventListener('click', () => { delete insightsByGoal[key]; loadInsights(); });
  }
}

function quadCell(cls, title, terms) {
  const list = terms || [];
  const shown = list.slice(0, 5);
  const more = list.length - shown.length;
  const chips = shown.map((t) => `<span class="qchip">${escHtml(t)}</span>`).join('')
    + (more > 0 ? `<span class="qmore">+${more}</span>` : '');
  return `<div class="qcell ${cls}${list.length ? '' : ' empty'}">
    <div class="qh"><span class="qt">${title}</span><span class="qn">${list.length}</span></div>
    <div class="qchips">${chips || '<span class="qmore">—</span>'}</div>
  </div>`;
}

function quadrantHtml(q) {
  if (!q) return '';
  const L = t().quad;
  // Колонки = сложность (слева легче), строки = приоритет действия.
  return `<div class="quad-cap"><span>${t().quadCap}</span><span class="sub">${t().quadAxis}</span></div>
    <div class="quad">
      ${quadCell('qw', L.quickWins, q.quickWins)}
      ${quadCell('long', L.longShots, q.longShots)}
      ${quadCell('push', L.pushNow, q.pushNow)}
      ${quadCell('ignore', L.ignore, q.ignore)}
    </div>`;
}

function renderInsights(data) {
  const box = document.getElementById('ai-insights');
  if (!box) return;
  const quickWins = new Set((data.quadrant && data.quadrant.quickWins) || []);
  const actions = (data.actions || []).slice(0, 12);
  if (!actions.length) { box.innerHTML = ''; return; }
  const rows = actions.map((a) => {
    const cls = moveClass(a, quickWins);
    const rkTop = a.currentRank != null && a.currentRank <= 10;
    const rk = a.currentRank != null ? '#' + a.currentRank : '—';
    return `<div class="act ${cls}">
      <div class="pr">${a.priority}</div>
      <div class="body">
        <div class="top">
          <span class="term">${escHtml(a.term)}</span>
          <span class="badge ${cls}">${moveLabel(cls)}</span>
          <span class="rk ${rkTop ? 'rank-top' : ''}">${rk}</span>
        </div>
        <div class="why">${escHtml(a.reason)}</div>
      </div>
    </div>`;
  }).join('');
  const dqKey = data.meta && data.meta.dataQuality;
  const model = data.meta && data.meta.model;
  const aiLabel = model && model !== 'rule-based' ? t().aiOn : t().aiOff;
  const dq = [dqKey ? (t().dq[dqKey] || dqKey + ' data') : '', aiLabel].filter(Boolean).join(' · ');
  box.innerHTML = `
    <div class="ai-summary"><span class="ic">✦</span><div>${escHtml(data.summary)}</div></div>
    ${quadrantHtml(data.quadrant)}
    <div class="plan-head"><span class="lbl">${t().plan}</span><span class="dq">${dq}</span></div>
    <div class="plan">${rows}</div>`;
  logEvent('insights_viewed', {
    jobId: currentJobId,
    goal: currentGoal,
    model: (data.meta && data.meta.model) || null,
  });
}

document.getElementById('download-btn').addEventListener('click', downloadExcel);
document.getElementById('u-reanalyze-btn').addEventListener('click', () => startAnalysis(true));

async function downloadExcel() {
  if (!currentJobId) return;
  try {
    const res = await fetch(API + '/ext/job/' + currentJobId + '/export.xlsx', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keywords-report.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    logEvent('report_downloaded', { jobId: currentJobId });
  } catch (e) {
    alert('Could not download: ' + (e.message || e));
  }
}

// --- ERROR ---
function showError(msg) {
  stopAllPolling();
  show('error');
  document.getElementById('error-text').textContent = msg;
}
document.getElementById('error-retry').addEventListener('click', () => startAnalysis(false));

// --- BOOTSTRAP ---
async function boot() {
  logEvent('extension_opened');
  if (!token) { show('auth'); renderAuthMode(); return; }
  const url = await activeTabUrl();
  if (!parsePage(url)) { show('unsupported'); return; }
  startAnalysis(false);
}

async function init() {
  const stored = await storage.get(['token', 'userEmail', 'insightsLang']);
  if (stored.token) {
    token = stored.token;
    userEmail = stored.userEmail || null;
    renderUserbar();
  }
  if (stored.insightsLang === 'en' || stored.insightsLang === 'ru') {
    currentLang = stored.insightsLang;
    langExplicit = true;
  }
  boot();
}

init();
