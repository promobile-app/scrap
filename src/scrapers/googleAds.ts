import { config } from '../config.js';

/**
 * Web-объёмы поиска из Google Ads Keyword Planner
 * (generateKeywordHistoricalMetrics). У Google Play нет аналога ASA
 * popularity, а объёмы веб-поиска сильно коррелируют с поиском в Play —
 * используем avgMonthlySearches как дополнительный сигнал спроса.
 *
 * Требуется (всё бесплатно при наличии аккаунта Google Ads):
 *   GOOGLE_ADS_DEVELOPER_TOKEN — токен API (уровня Basic достаточно)
 *   GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET — OAuth-клиент
 *   GOOGLE_ADS_REFRESH_TOKEN — refresh token пользователя с доступом к аккаунту
 *   GOOGLE_ADS_CUSTOMER_ID — id аккаунта (без дефисов)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID — id MCC, если доступ через менеджер-аккаунт
 *
 * Без конфигурации isGoogleAdsConfigured() = false и volume-формулы работают
 * без web-сигнала (перенормировка весов в analytics/weights.ts).
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://googleads.googleapis.com';
const BATCH = 500; // ключей на один запрос
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // объёмы месячные — суток кэша достаточно

// geoTargetConstants Google Ads по стране (страны витрин, которые поддерживаем).
const GEO: Record<string, number> = {
  us: 2840, gb: 2826, de: 2276, ua: 2804, ru: 2643, pl: 2616, fr: 2250,
  es: 2724, it: 2380, ca: 2124, au: 2036, br: 2076, in: 2356, mx: 2484,
  nl: 2528, tr: 2792, jp: 2392, kr: 2410,
};

// languageConstants Google Ads. Если языка нет в карте — параметр опускаем
// (метрики тогда считаются без языкового фильтра, это допустимо).
const LANG: Record<string, number> = {
  en: 1000, de: 1001, fr: 1002, es: 1003, it: 1004, ja: 1005,
  nl: 1010, ko: 1012, pt: 1014, pl: 1030, tr: 1037,
};

// Язык запроса по стране (та же логика, что у витрин Google Play).
const COUNTRY_LANG: Record<string, string> = {
  us: 'en', gb: 'en', de: 'de', ua: 'uk', ru: 'ru',
  pl: 'pl', fr: 'fr', es: 'es', it: 'it', ca: 'en',
};

export function isGoogleAdsConfigured(): boolean {
  const g = config.googleAds;
  return Boolean(g.developerToken && g.clientId && g.clientSecret && g.refreshToken && g.customerId);
}

let accessToken: { token: string; expires: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessToken.expires) return accessToken.token;
  const g = config.googleAds;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google Ads OAuth ${res.status}: ${json.error ?? 'no access_token'}`);
  }
  accessToken = {
    token: json.access_token,
    expires: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  };
  return accessToken.token;
}

interface HistoricalMetricsResponse {
  results?: Array<{
    text?: string;
    keywordMetrics?: { avgMonthlySearches?: string | number };
  }>;
  error?: { message?: string };
}

// Кэш объёмов: country|term → avgMonthlySearches (null = Google ключа не знает).
const volumeCache = new Map<string, { value: number | null; expires: number }>();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Средние месячные web-объёмы поиска по списку ключей в стране.
 * Возвращает Map term(lowercase) → avgMonthlySearches; null — Google не отдал
 * метрику для ключа. Ошибки сети/квоты пробрасываются — вызывающий решает,
 * деградировать ли тихо.
 */
export async function keywordSearchVolumes(
  terms: string[],
  country = config.defaultCountry,
): Promise<Map<string, number | null>> {
  const g = config.googleAds;
  const c = country.toLowerCase();
  const out = new Map<string, number | null>();
  const now = Date.now();

  const normalized = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const misses: string[] = [];
  for (const t of normalized) {
    const hit = volumeCache.get(`${c}|${t}`);
    if (hit && now < hit.expires) out.set(t, hit.value);
    else misses.push(t);
  }
  if (misses.length === 0) return out;

  const token = await getAccessToken();
  const geo = GEO[c];
  const langCode = COUNTRY_LANG[c] ?? 'en';
  const lang = LANG[langCode];

  for (const batch of chunk(misses, BATCH)) {
    const body: Record<string, unknown> = {
      keywords: batch,
      keywordPlanNetwork: 'GOOGLE_SEARCH',
    };
    if (geo) body.geoTargetConstants = [`geoTargetConstants/${geo}`];
    if (lang) body.language = `languageConstants/${lang}`;

    const res = await fetch(
      `${API_BASE}/${g.apiVersion}/customers/${g.customerId}:generateKeywordHistoricalMetrics`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': g.developerToken,
          'Content-Type': 'application/json',
          ...(g.loginCustomerId ? { 'login-customer-id': g.loginCustomerId } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text) as HistoricalMetricsResponse;
    const found = new Map<string, number>();
    for (const row of json.results ?? []) {
      const t = (row.text ?? '').trim().toLowerCase();
      const v = row.keywordMetrics?.avgMonthlySearches;
      if (t && v != null) found.set(t, Number(v));
    }
    for (const t of batch) {
      const value = found.get(t) ?? null;
      out.set(t, value);
      volumeCache.set(`${c}|${t}`, { value, expires: now + CACHE_TTL_MS });
    }
  }
  return out;
}

/** Диагностика: tsx src/scrapers/googleAds.ts "habit tracker" [country] */
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!isGoogleAdsConfigured()) {
    console.error('Google Ads не сконфигурирован (см. env в шапке файла)');
    process.exit(1);
  }
  const terms = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  keywordSearchVolumes(terms.length ? terms : ['habit tracker', 'vpn'], 'us')
    .then((m) => console.table([...m.entries()].map(([term, searches]) => ({ term, searches }))))
    .catch((e) => { console.error('❌', e.message); process.exit(1); });
}
