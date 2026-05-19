// Адрес бэкенда RankRadar на Railway. Поменяйте, если домен другой.
const API = 'https://scrap-production-c0db.up.railway.app';

const goBtn = document.getElementById('go');
const resultEl = document.getElementById('result');
const targetEl = document.getElementById('target');

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

// Проверяем, что вкладка — страница приложения в App Store / Google Play.
function isStoreUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith('apple.com') || h.endsWith('play.google.com');
  } catch {
    return false;
  }
}

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

function renderResult(d) {
  targetEl.style.display = 'flex';
  targetEl.innerHTML = `${platformIcon(d.platform)}
    <span>${FLAGS[d.country] || (d.country || '').toUpperCase()}</span>
    <b>${d.title}</b>`;
  // Показываем только ключи, по которым приложение реально ранжируется.
  const ranked = (d.keywords || []).filter((k) => k.rank != null);
  if (!ranked.length) {
    resultEl.innerHTML = '<p class="muted">Приложение не ранжируется ни по одному из найденных ключей.</p>';
    return;
  }
  resultEl.innerHTML = `
    <p class="muted" style="margin:8px 0">${ranked.length} ключей с позицией</p>
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

async function run() {
  const url = await activeTabUrl();
  if (!isStoreUrl(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store (apps.apple.com)
      или Google Play (play.google.com) и нажмите кнопку снова.</p>`;
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

goBtn.addEventListener('click', run);

// Подсказываем, на каком приложении сейчас находимся.
activeTabUrl().then((url) => {
  if (!isStoreUrl(url)) {
    resultEl.innerHTML = `<p class="muted" style="margin-top:12px">
      Откройте страницу приложения в App Store или Google Play.</p>`;
  }
});
