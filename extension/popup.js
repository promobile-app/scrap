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
  keyword: document.getElementById('screen-keyword'),
  tracking: document.getElementById('screen-tracking'),
};

// Экраны, относящиеся к вкладке «App» (анализ открытой страницы стора). 'keyword'
// живёт в своей вкладке, 'auth' — вне таб-бара.
const APP_SCREENS = new Set(['unsupported', 'loading', 'summary', 'payment', 'unlocked', 'error']);
let lastAppScreen = null;
const tabbarEl = document.getElementById('tabbar');

function show(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
  if (APP_SCREENS.has(name)) lastAppScreen = name;
  // Таб-бар: только для залогиненных и не на экране авторизации.
  const showTabs = !!token && name !== 'auth';
  tabbarEl.classList.toggle('show', showTabs);
  if (showTabs) {
    const active = name === 'keyword' ? 'keyword' : name === 'tracking' ? 'tracking' : 'app';
    tabbarEl.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === active));
  }
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
let hasPaid = false;               // аккаунт-левел право на платные фичи (keyword check)
// Контекст проверки ключа — платформа/гео/appId берём из открытой страницы стора.
let kwContext = { platform: 'ios', country: 'us', appId: null, detected: false };
let kwReq = 0;                     // токен против гонки при быстром повторном поиске

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

// Блок приложения: контекст-бар (гео · стор · id) + строка с аватаром и бейджем.
function appCardHtml(d) {
  const flag = FLAGS[d.country] || '';
  const cc = (d.country || 'us').toUpperCase();
  const store = d.platform === 'android' ? 'Google Play' : 'App Store';
  const os = d.platform === 'android' ? 'Android' : 'iOS';
  const title = d.appTitle || String(d.appId || '');
  const letter = (title.trim().charAt(0) || '?').toUpperCase();
  const idPart = d.platform === 'android'
    ? escHtml(String(d.appId || ''))
    : 'id' + escHtml(String(d.appId || ''));
  return `<div class="ctx-strip">${flag ? flag + ' ' : ''}${cc} · ${store} · <span class="id">${idPart}</span></div>
    <div class="app-row">
      <div class="app-ava">${escHtml(letter)}</div>
      <div class="app-meta">
        <div class="app-t">${escHtml(title)}</div>
        <div class="app-d">${escHtml(d.developer || store)}</div>
      </div>
      <div class="app-badge">${os} · ${cc}</div>
    </div>`;
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
    stage.textContent = total ? `${processed} / ${total}` : 'Fetching app data...';
  else if (state.status === 'done') stage.textContent = 'Preparing report...';
  const appBox = document.getElementById('loading-app');
  if (state.appTitle) {
    appBox.innerHTML = appCardHtml(state);
    appBox.style.display = 'block';
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
// Тизер пейволла: строки под блюром + градиент с замком. Реальных ключей до
// оплаты у нас нет — под блюром плейсхолдеры, подпись говорит правду о числе.
const TEASER_ROWS = [
  ['habit tracker', '#3', 68, 72],
  ['daily planner', '#5', 44, 52],
  ['streak tracker', '#7', 35, 44],
  ['routine app', '#9', 29, 31],
  ['goal tracker', '#12', 27, 35],
];

function teaserHtml(n) {
  const rows = TEASER_ROWS.map(([term, rk, vol, diff]) =>
    `<div class="tz-row"><span>${term}</span><span class="rank-top">${rk}</span><span>${vol}</span><span>${diff}</span></div>`
  ).join('');
  return `<div class="tz-blur">${rows}</div>
    <div class="tz-overlay">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="6.5" rx="1.5" stroke="#8b8f9b" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="#8b8f9b" stroke-width="1.4"/></svg>
      <div class="tz-more">${n} keyword${n === 1 ? '' : 's'} in the full report</div>
    </div>`;
}

function renderSummary(state) {
  show('summary');
  document.getElementById('summary-app').innerHTML = appCardHtml(state);
  const s = state.summary || { rankedKeywords: 0, top3: 0, top10: 0 };
  document.getElementById('m-ranked').textContent = s.rankedKeywords;
  document.getElementById('m-top3').textContent = s.top3;
  document.getElementById('m-top10').textContent = s.top10;
  const empty = s.rankedKeywords === 0;
  document.getElementById('summary-empty').style.display = empty ? 'block' : 'none';
  document.getElementById('summary-report').style.display = empty ? 'none' : 'block';
  if (!empty) {
    document.getElementById('summary-count').textContent = s.rankedKeywords + ' keywords found';
    document.getElementById('summary-teaser').innerHTML = teaserHtml(s.rankedKeywords);
  }
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
      hasPaid = true; // первая оплата открывает и keyword-проверку
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
    download: 'Download Excel', reanalyze: 'Re-analyze', allK: 'All keywords',
    aiOn: 'AI', aiOff: 'rules',
    serpLoading: 'Loading results…', serpError: "Couldn't load results.", serpTop: 'Top results for',
    tbl: { keyword: 'Keyword', rank: 'Rank', demand: 'Volume', diff: 'Diff' },
    kwEmpty: { all: 'No keywords found.', ranked: 'No ranked keywords.', top3: 'No keywords in Top 3.', top10: 'No keywords in Top 10.' },
    quadCap: 'Quadrant', quadAxis: '· volume × difficulty',
    quad: { quickWins: 'Quick wins', longShots: 'Long shots', pushNow: 'Push now', ignore: 'Ignore' },
    plan: 'Action plan',
    dq: { estimated: 'estimated data', measured: 'measured data' },
    move: { 'push-qw': 'Push · quick win', push: 'Push', monitor: 'Monitor', skip: 'Skip' },
    loading: 'Building your action plan…',
    errText: "Couldn't build the action plan.", retry: 'Retry',
    kw: {
      placeholder: 'Enter a keyword', check: 'Check',
      demand: 'Volume', difficulty: 'Difficulty', position: 'Position', top: 'Top apps',
      checking: 'Checking…', error: "Couldn't check this keyword.",
      empty: 'No apps found.', deflt: 'default · open a store page to change',
      locked: '<b>Keyword check is a Pro feature</b>Subscribe from any app report to enable it.',
    },
    trk: {
      cap: 'Tracked apps', note: 'checked every 3h',
      track: 'Track', tracking: 'Tracking ✓', untrack: 'Stop tracking',
      empty: 'No tracked apps yet.\nOpen any report and press “Track”.',
      loading: 'Loading…', error: "Couldn't load tracking.",
      kwHead: 'keywords', noChanges: 'no significant moves in 24h',
      locked: '<b>Tracking is a Pro feature</b>Subscribe from any app report to enable it.',
    },
  },
  ru: {
    goals: { rank_up: 'Рост', expand: 'Охват', defend: 'Защита' },
    download: 'Скачать Excel', reanalyze: 'Пересчитать', allK: 'Все ключи',
    aiOn: 'AI', aiOff: 'правила',
    serpLoading: 'Загружаю выдачу…', serpError: 'Не удалось загрузить выдачу.', serpTop: 'Топ выдачи по',
    tbl: { keyword: 'Ключ', rank: 'Поз.', demand: 'Объём', diff: 'Слож.' },
    kwEmpty: { all: 'Ключи не найдены.', ranked: 'Нет ранжированных ключей.', top3: 'Нет ключей в топ-3.', top10: 'Нет ключей в топ-10.' },
    quadCap: 'Квадрант', quadAxis: '· объём × сложность',
    quad: { quickWins: 'Быстрые победы', longShots: 'Тяжёлая ниша', pushNow: 'Качать сейчас', ignore: 'Пропустить' },
    plan: 'План действий',
    dq: { estimated: 'оценочные данные', measured: 'точные данные' },
    move: { 'push-qw': 'Качать · быстрая победа', push: 'Качать', monitor: 'Держать', skip: 'Пропустить' },
    loading: 'Готовлю план действий…',
    errText: 'Не удалось построить план.', retry: 'Повторить',
    kw: {
      placeholder: 'Введите ключевое слово', check: 'Проверить',
      demand: 'Объём', difficulty: 'Сложность', position: 'Позиция', top: 'Топ приложений',
      checking: 'Проверяю…', error: 'Не удалось проверить ключ.',
      empty: 'Приложения не найдены.', deflt: 'по умолчанию · откройте страницу стора',
      locked: '<b>Проверка ключа — функция Pro</b>Оформите подписку с любого отчёта, чтобы включить.',
    },
    trk: {
      cap: 'Отслеживаемые', note: 'замер каждые 3ч',
      track: 'Отслеживать', tracking: 'Отслеживается ✓', untrack: 'Не отслеживать',
      empty: 'Пока нет отслеживаемых приложений.\nОткройте любой отчёт и нажмите «Отслеживать».',
      loading: 'Загрузка…', error: 'Не удалось загрузить трекинг.',
      kwHead: 'ключей', noChanges: 'без значимых движений за 24ч',
      locked: '<b>Трекинг — функция Pro</b>Оформите подписку с любого отчёта, чтобы включить.',
    },
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
  // Кнопка Track: подтягиваем текущий статус отслеживания фоном.
  refreshTrackState();
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

  const cnt = document.getElementById('kw-count');
  if (cnt) cnt.textContent = rows.length || '';

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
  // Локализуем кнопки действий под таблицей (лейблы — в span, иконки не трогаем).
  const dl = document.getElementById('download-label');
  if (dl) dl.textContent = t().download;
  const re = document.getElementById('u-reanalyze-label');
  if (re) re.textContent = t().reanalyze;
  const cap = document.getElementById('kw-list-cap');
  if (cap) cap.textContent = t().allK;
  // Перерисовать таблицу ключей — её заголовки тоже локализованы.
  if (unlockedKeywords && unlockedKeywords.length) renderKwTable();
  // Подписи экрана проверки ключа.
  renderKwLang();
  // Кнопка Track тоже локализована.
  renderTrackBtn();
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

// Отпечаток набора ключей — план пересобираем только при его изменении.
function kwFingerprint() {
  let h = 5381;
  for (const k of unlockedKeywords) {
    const s = k.term + ':' + k.rank;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return unlockedKeywords.length + '.' + (h >>> 0).toString(36);
}
function insightsStoreKey(goal, lang) {
  return 'ins:' + currentApp.platform + '|' + currentApp.appId + '|' + currentApp.country + '|' + goal + '|' + lang;
}

async function loadInsights() {
  const box = document.getElementById('ai-insights');
  if (!box || !currentJobId) { if (box) box.innerHTML = ''; return; }
  const goal = currentGoal;
  const lang = currentLang;
  const key = goal + '|' + lang;
  if (insightsByGoal[key]) { renderInsights(insightsByGoal[key]); return; }
  // Кэш, переживающий закрытие попапа: тот же приложение+гео+goal+язык и тот же
  // набор ключей (отпечаток) — показываем сохранённый план сразу, без пересборки.
  const fp = kwFingerprint();
  const stKey = insightsStoreKey(goal, lang);
  const stored = (await storage.get([stKey]))[stKey];
  if (stored && stored.fp === fp && goal === currentGoal && lang === currentLang) {
    insightsByGoal[key] = stored.data;
    renderInsights(stored.data);
    return;
  }
  const reqId = ++insightsReq;
  box.innerHTML = `<div class="ai-loading"><span class="spinner"></span> ${t().loading}</div>`;
  try {
    const data = await api('/ext/insights', {
      method: 'POST',
      body: JSON.stringify({ jobId: currentJobId, goal, lang }),
    });
    insightsByGoal[key] = data;
    storage.set({ [stKey]: { fp, data } });
    if (reqId === insightsReq && goal === currentGoal && lang === currentLang) renderInsights(data);
  } catch (e) {
    if (reqId !== insightsReq) return; // ответ устарел — пользователь сменил goal/язык
    if (e.status === 401) { await logout(); return; }
    box.innerHTML = `<div class="ai-loading">${t().errText} `
      + `<a class="ai-retry" style="color:var(--accent-text);cursor:pointer">${t().retry}</a></div>`;
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
    <div class="qh"><span class="qdot"></span><span class="qt">${title}</span><span class="qn">${list.length}</span></div>
    <div class="qchips">${chips || '<span class="qmore">—</span>'}</div>
  </div>`;
}

function quadrantHtml(q) {
  if (!q) return '';
  const L = t().quad;
  // Колонки = сложность (слева легче), строки = приоритет действия.
  return `<div class="sec-head"><span class="sec-lbl">${t().quadCap}</span><span class="sec-sub">${t().quadAxis}</span></div>
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
    <div class="ai-summary">${escHtml(data.summary)}</div>
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

// --- TABS + KEYWORD CHECK ---
tabbarEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'keyword') openKeywordTab();
    else if (b.dataset.tab === 'tracking') openTrackingTab();
    else openAppTab();
  });
});

function openAppTab() {
  if (lastAppScreen) show(lastAppScreen);
  else boot();
}

// Платформа/гео для проверки ключа — из активной вкладки стора; иначе дефолт.
async function detectKwContext() {
  const p = parsePage(await activeTabUrl());
  kwContext = p
    ? { platform: p.platform, country: p.country, appId: p.appId, detected: true }
    : { platform: 'ios', country: 'us', appId: null, detected: false };
}

async function openKeywordTab() {
  show('keyword');
  await detectKwContext();
  renderKwLang();
  const locked = !hasPaid;
  document.getElementById('kw-locked').style.display = locked ? 'block' : 'none';
  document.getElementById('kw-main').style.display = locked ? 'none' : 'block';
  if (!locked) {
    const inp = document.getElementById('kw-input');
    inp.value = '';
    document.getElementById('kw-result').innerHTML = '';
    inp.focus();
  }
}

// Локализация статичных подписей экрана ключа + строка контекста (флаг + стор).
function renderKwLang() {
  const k = t().kw;
  const inp = document.getElementById('kw-input');
  if (inp) inp.placeholder = k.placeholder;
  const btn = document.getElementById('kw-check');
  if (btn) btn.textContent = k.check;
  const lt = document.getElementById('kw-locked-text');
  if (lt) lt.innerHTML = k.locked;
  const ctx = document.getElementById('kw-ctx');
  if (ctx) {
    const flag = FLAGS[kwContext.country] || (kwContext.country || '').toUpperCase();
    const store = kwContext.platform === 'android' ? 'Google Play' : 'App Store';
    const hint = kwContext.detected ? '' : ` · ${k.deflt}`;
    ctx.innerHTML = `<span>${flag}</span><span>${store}${hint}</span>`;
  }
}

async function checkKeyword() {
  const inp = document.getElementById('kw-input');
  const box = document.getElementById('kw-result');
  const term = (inp.value || '').trim();
  if (!term) { box.innerHTML = ''; return; }
  const reqId = ++kwReq;
  box.innerHTML = `<div class="ai-loading"><span class="spinner"></span> ${t().kw.checking}</div>`;
  logEvent('keyword_checked', { term, platform: kwContext.platform, country: kwContext.country });
  try {
    const q = 'term=' + encodeURIComponent(term)
      + '&country=' + encodeURIComponent(kwContext.country)
      + '&platform=' + kwContext.platform
      + (kwContext.appId ? '&appId=' + encodeURIComponent(kwContext.appId) : '');
    const d = await api('/ext/keyword?' + q);
    if (reqId === kwReq) renderKeyword(d);
  } catch (e) {
    if (reqId !== kwReq) return; // устаревший ответ — пользователь уже ищет другое
    if (e.status === 401) { await logout(); return; }
    if (e.status === 403) { hasPaid = false; openKeywordTab(); return; }
    box.innerHTML = `<p class="err" style="text-align:center">${t().kw.error}</p>`;
  }
}

function renderKeyword(d) {
  const box = document.getElementById('kw-result');
  const k = t().kw;
  const vol = (d.volume && d.volume.score) || 0;
  const diff = (d.difficulty && d.difficulty.score) || 0;
  // Ячейка позиции — только если открыта страница приложения (есть appId).
  const hasTarget = !!kwContext.appId;
  const rankVal = d.rank != null ? '#' + d.rank : '—';
  const rankCls = d.rank != null && d.rank <= 10 ? ' green' : '';
  const diffCls = diff >= 60 ? ' warn' : '';
  const cells = [
    `<div class="mcell"><div class="mv">${vol}</div><div class="ml">${k.demand}</div></div>`,
    `<div class="mcell"><div class="mv${diffCls}">${diff}</div><div class="ml">${k.difficulty}</div></div>`,
  ];
  if (hasTarget) {
    cells.push(`<div class="mcell"><div class="mv${rankCls}">${rankVal}</div><div class="ml">${k.position}</div></div>`);
  }
  const list = d.topApps || [];
  const apps = list.map((a) => {
    const ic = a.icon
      ? `<img class="kw-ic" src="${a.icon}" loading="lazy" onerror="this.style.visibility='hidden'" />`
      : '<span class="kw-ic"></span>';
    return `<div class="kw-app${a.isTarget ? ' me' : ''}">
      <span class="kw-pos">${a.position}</span>${ic}
      <div class="kw-meta">
        <div class="kw-t">${escHtml(a.title)}</div>
        <div class="kw-d">${escHtml(a.developer || '')}</div>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="mstrip" style="margin-top:12px;border-top:1px solid var(--line)">${cells.join('')}</div>
    <div class="sec-head"><span class="sec-lbl">${k.top}</span><span class="sec-sub">${list.length || ''}</span></div>
    <div class="kw-apps">
      ${apps || `<p class="muted" style="padding:10px 14px;text-align:center;margin:0">${k.empty}</p>`}
    </div>`;
}

document.getElementById('kw-check').addEventListener('click', checkKeyword);
document.getElementById('kw-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkKeyword();
});

// --- TRACKING TAB ---
let trackedState = null;   // { id, terms } для текущего приложения отчёта (или null)
let trkExpanded = null;    // id развёрнутого приложения
const trkDetails = {};     // id -> { loading?, error?, data? }

// Мини-спарклайн позиций: полилиния в SVG, ось Y инвертирована (1 место сверху).
// Пропуски (rank=null) рвут линию — честнее, чем рисовать ноль.
function sparkSvg(series) {
  const pts = (series || []).slice(-20);
  const known = pts.filter((r) => r != null);
  if (known.length < 2) return '<span class="trk-spark"></span>';
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = Math.max(1, max - min);
  const W = 64, H = 18, P = 2;
  const step = pts.length > 1 ? (W - P * 2) / (pts.length - 1) : 0;
  const segs = [];
  let cur = [];
  pts.forEach((r, i) => {
    if (r == null) { if (cur.length > 1) segs.push(cur); cur = []; return; }
    const x = P + i * step;
    const y = P + ((r - min) / span) * (H - P * 2); // меньше rank = выше
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur);
  if (!segs.length) return '<span class="trk-spark"></span>';
  const lines = segs.map((s) => `<polyline points="${s.join(' ')}"/>`).join('');
  return `<svg class="trk-spark" viewBox="0 0 ${W} ${H}">${lines}</svg>`;
}

async function openTrackingTab() {
  show('tracking');
  const L = t().trk;
  document.getElementById('trk-cap').textContent = L.cap;
  document.getElementById('trk-note').textContent = L.note;
  const lockedEl = document.getElementById('trk-locked');
  const mainEl = document.getElementById('trk-main');
  const lt = document.getElementById('trk-locked-text');
  if (lt) lt.innerHTML = L.locked;
  const locked = !hasPaid;
  lockedEl.style.display = locked ? 'block' : 'none';
  mainEl.style.display = locked ? 'none' : 'block';
  if (locked) return;
  const list = document.getElementById('trk-list');
  list.innerHTML = `<div class="ai-loading"><span class="spinner"></span> ${L.loading}</div>`;
  try {
    const d = await api('/ext/tracked');
    renderTrackedList(d.items || []);
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
    if (e.status === 403) { hasPaid = false; openTrackingTab(); return; }
    list.innerHTML = `<div class="trk-empty">${L.error}</div>`;
  }
}

function renderTrackedList(items) {
  const L = t().trk;
  const list = document.getElementById('trk-list');
  if (!items.length) {
    list.innerHTML = `<div class="trk-empty">${escHtml(L.empty).replace(/\n/g, '<br>')}</div>`;
    return;
  }
  list.innerHTML = items.map((a) => {
    const flag = FLAGS[a.country] || (a.country || '').toUpperCase();
    const store = a.platform === 'android' ? 'Google Play' : 'App Store';
    const badges =
      (a.up ? `<span class="trk-badge up">▲${a.up}</span>` : '') +
      (a.down ? `<span class="trk-badge down">▼${a.down}</span>` : '') +
      (!a.up && !a.down ? `<span class="trk-badge flat">—</span>` : '');
    const open = trkExpanded === a.id;
    return `<div class="trk-app" data-id="${a.id}">
      <div class="trk-head-row" data-id="${a.id}">
        <div style="flex:1;min-width:0">
          <div class="trk-t">${escHtml(a.appTitle || a.appId)}</div>
          <div class="trk-sub">${flag} ${store} · ${a.terms} ${L.kwHead}</div>
        </div>
        ${badges}
      </div>
      ${open ? `<div class="trk-body">${trkBodyHtml(a.id)}</div>` : ''}
    </div>`;
  }).join('');
  // Клик по шапке — раскрыть/свернуть; по untrack — снять отслеживание.
  list.querySelectorAll('.trk-head-row').forEach((el) => {
    el.addEventListener('click', () => toggleTrkApp(Number(el.dataset.id), items));
  });
  list.querySelectorAll('.trk-untrack a').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = Number(el.dataset.id);
      try { await api('/ext/track/' + id, { method: 'DELETE' }); } catch {}
      delete trkDetails[id];
      if (trackedState && trackedState.id === id) trackedState = null;
      openTrackingTab();
    });
  });
}

function trkBodyHtml(id) {
  const L = t().trk;
  const d = trkDetails[id];
  if (!d || d.loading) return `<div class="ai-loading"><span class="spinner"></span> ${L.loading}</div>`;
  if (d.error) return `<div class="trk-empty">${L.error}</div>`;
  const kws = (d.data.keywords || []);
  const anySig = kws.some((k) => k.significant);
  const rows = kws.map((k) => {
    const rk = k.currRank != null ? '#' + k.currRank : '—';
    let dl = '·', cls = 'flat';
    if (k.delta != null && k.delta > 0) { dl = '▲' + k.delta; cls = 'up'; }
    else if (k.delta != null && k.delta < 0) { dl = '▼' + Math.abs(k.delta); cls = 'down'; }
    else if (k.enteredTop10) { dl = '▲10'; cls = 'up'; }
    else if (k.leftTop10) { dl = '▼10'; cls = 'down'; }
    return `<div class="trk-kw">
      <span class="term">${escHtml(k.term)}</span>
      ${sparkSvg(k.series)}
      <span class="rk ${k.currRank != null && k.currRank <= 10 ? 'rank-top' : ''}">${rk}</span>
      <span class="dl ${cls}">${dl}</span>
    </div>`;
  }).join('');
  const note = anySig ? '' : `<div class="trk-empty" style="padding:8px">${L.noChanges}</div>`;
  return note + rows + `<div class="trk-untrack"><a data-id="${id}">${L.untrack}</a></div>`;
}

async function toggleTrkApp(id, items) {
  trkExpanded = trkExpanded === id ? null : id;
  renderTrackedList(items);
  if (trkExpanded === id && !trkDetails[id]) {
    trkDetails[id] = { loading: true };
    try {
      const data = await api('/ext/tracked/' + id);
      trkDetails[id] = { data };
    } catch (e) {
      if (e.status === 401) { await logout(); return; }
      trkDetails[id] = { error: true };
    }
    if (trkExpanded === id) renderTrackedList(items);
  }
}

// --- Кнопка Track в отчёте ---
const trackBtnEl = document.getElementById('track-btn');
const trackLabelEl = document.getElementById('track-label');

function renderTrackBtn() {
  if (!trackLabelEl) return;
  const L = t().trk;
  trackLabelEl.textContent = trackedState ? L.tracking : L.track;
}

async function refreshTrackState() {
  trackedState = null;
  renderTrackBtn();
  try {
    const q = 'platform=' + currentApp.platform
      + '&appId=' + encodeURIComponent(currentApp.appId)
      + '&country=' + encodeURIComponent(currentApp.country);
    const d = await api('/ext/track/status?' + q);
    trackedState = d.tracked || null;
  } catch {}
  renderTrackBtn();
}

if (trackBtnEl) trackBtnEl.addEventListener('click', async () => {
  trackBtnEl.disabled = true;
  try {
    if (trackedState) {
      const id = trackedState.id;
      await api('/ext/track/' + id, { method: 'DELETE' });
      delete trkDetails[id];
      trackedState = null;
    } else {
      const d = await api('/ext/track', {
        method: 'POST',
        body: JSON.stringify({
          platform: currentApp.platform,
          appId: currentApp.appId,
          country: currentApp.country,
        }),
      });
      trackedState = d.tracked || null;
      logEvent('app_tracked', { appId: currentApp.appId, platform: currentApp.platform });
    }
  } catch (e) {
    if (e.status === 401) { await logout(); return; }
  } finally {
    trackBtnEl.disabled = false;
    renderTrackBtn();
  }
});

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
  // Право на платные фичи — фоном, не блокируя анализ.
  api('/auth/me').then((d) => { hasPaid = !!d.hasPaid; }).catch(() => {});
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
