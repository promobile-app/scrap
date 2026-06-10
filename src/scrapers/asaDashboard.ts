import { readFileSync } from 'node:fs';
import { request } from 'undici';
import { config } from '../config.js';

/**
 * Keyword Search Popularity через внутренний API дашборда Apple Ads.
 *
 * Официальный Campaign Management API НЕ отдаёт popularity для произвольных
 * ключей. Дашборд (app-ads.apple.com) использует внутренний эндпоинт:
 *
 *   POST https://app-ads.apple.com/cm/api/v2/keywords/popularities?adamId={adamId}
 *   headers: X-XSRF-TOKEN-CM, Cookie (сессия дашборда)
 *   body:    { storefronts: ["US"], terms: ["photo editor", ...] }   (до 100 термов)
 *   resp:    { status:"success", data:[ { name, popularity }, ... ] }
 *
 * Сигнатура реверс-инжинирилась из реальных запросов дашборда (формат подтверждён
 * живым ответом KWS_NO_ORG_CONTENT_PROVIDERS — т.е. тело валидно).
 *
 * ТРЕБОВАНИЯ:
 *   1. Залогиненная сессия дашборда → .asa-session.json (cookie + xsrf). СЕКРЕТ,
 *      в .gitignore. Куки протухают — периодически обновлять (см. README ниже).
 *   2. В орге должен быть ≥1 «content provider» (привязанное приложение в ASC),
 *      иначе эндпоинт отвечает KWS_NO_ORG_CONTENT_PROVIDERS.
 *   3. adamId любого приложения орга (ASA_DASH_ADAM_ID) — query-контекст, на
 *      значение популярности не влияет.
 */

const POPULARITIES_URL = 'https://app-ads.apple.com/cm/api/v2/keywords/popularities';
const MAX_TERMS_PER_REQUEST = 100; // лимит дашборда (si=100)

interface DashSession {
  cookie: string;
  xsrf: string;
  adamId?: number;
  orgId?: number;
}

let sessionCache: DashSession | null = null;
function loadSession(): DashSession {
  if (sessionCache) return sessionCache;
  const raw = readFileSync(config.asaDash.sessionPath, 'utf8');
  const s = JSON.parse(raw) as DashSession;
  if (!s.cookie || !s.xsrf) {
    throw new Error(`${config.asaDash.sessionPath}: нужны поля cookie и xsrf`);
  }
  sessionCache = s;
  return s;
}

export function isAsaDashConfigured(): boolean {
  try {
    const s = loadSession();
    return Boolean(s.cookie && s.xsrf && (config.asaDash.adamId || s.adamId));
  } catch {
    return false;
  }
}

export interface KeywordPopularity {
  /** ключ в нижнем регистре (как возвращает Apple) */
  keyword: string;
  /** популярность 5-100; null если Apple не вернул значение для ключа */
  popularity: number | null;
}

interface PopularitiesResponse {
  status: string;
  data?: Array<{ name: string; popularity: number }>;
  error?: { errors?: Array<{ messageCode: string; message: string }> };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Запрашивает популярность для набора термов в одной стране (storefront).
 * Бьёт на батчи по 100, объединяет результат. Термы, которых Apple не знает,
 * возвращаются с popularity=null.
 *
 * @param terms   список ключевых фраз
 * @param storefront код страны, напр. 'US'
 */
export async function keywordPopularity(
  terms: string[],
  storefront = 'US',
): Promise<KeywordPopularity[]> {
  const session = loadSession();
  const adamId = config.asaDash.adamId || session.adamId;
  if (!adamId) {
    throw new Error('ASA_DASH_ADAM_ID не задан (нужен adamId любого приложения орга)');
  }

  const normalized = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const found = new Map<string, number>();

  for (const batch of chunk(normalized, MAX_TERMS_PER_REQUEST)) {
    const res = await request(`${POPULARITIES_URL}?adamId=${adamId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        'X-XSRF-TOKEN-CM': session.xsrf,
        Cookie: session.cookie,
      },
      body: JSON.stringify({ storefronts: [storefront], terms: batch }),
    });
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error(
        `ASA dashboard ${res.statusCode}: сессия протухла или нет привязанного приложения — ${text.slice(0, 200)}`,
      );
    }
    if (res.statusCode >= 400) {
      throw new Error(`ASA dashboard ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as PopularitiesResponse;
    if (json.status !== 'success') {
      const code = json.error?.errors?.[0]?.messageCode ?? 'unknown';
      throw new Error(`ASA dashboard popularity error: ${code}`);
    }
    for (const row of json.data ?? []) {
      found.set(row.name.trim().toLowerCase(), row.popularity);
    }
  }

  // Сохраняем порядок и дедуп исходного списка.
  const seen = new Set<string>();
  const out: KeywordPopularity[] = [];
  for (const t of normalized) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ keyword: t, popularity: found.has(t) ? found.get(t)! : null });
  }
  return out;
}

/** Диагностика: tsx src/scrapers/asaDashboard.ts [term...] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const terms = process.argv.slice(2);
  const sample = terms.length ? terms : ['photo editor', 'vpn', 'instagram'];
  keywordPopularity(sample, 'US')
    .then((r) => console.table(r))
    .catch((e) => {
      console.error('❌', e.message);
      process.exit(1);
    });
}
