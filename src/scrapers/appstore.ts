import { fetchJson, fetchText } from './http.js';
import { nativeSearchIds, storeFront } from './native.js';
import { config } from '../config.js';

const ITUNES = 'https://itunes.apple.com';
// Внутренний storefront-эндпоинт App Store, отдающий поисковую выдачу.
const STOREFRONT = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
const STORE_SEARCH = 'https://itunes.apple.com/search';

// История версий есть только в HTML страницы приложения: ни iTunes lookup, ни
// itml-ответ нативного клиента её не содержат. Адрес берём из lookup
// (trackViewUrl) — короткий /app/id<N> отвечает 301 на канонический URL со
// слагом, а undici за редиректами сам не ходит.
const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export interface AppInfo {
  appId: number;
  bundleId: string;
  title: string;
  developer: string;
  developerId: number;
  price: number;
  currency: string;
  rating: number;
  ratingCount: number;
  primaryGenre: string;
  primaryGenreId: number;
  icon: string;
  url: string;
  description: string;
  genres: string[];
}

interface ItunesResult {
  trackId: number;
  bundleId: string;
  trackName: string;
  artistName: string;
  artistId: number;
  price: number;
  currency: string;
  averageUserRating?: number;
  userRatingCount?: number;
  primaryGenreName: string;
  primaryGenreId: number;
  artworkUrl512?: string;
  artworkUrl100?: string;
  trackViewUrl: string;
  description?: string;
  genres?: string[];
}

function mapApp(r: ItunesResult): AppInfo {
  return {
    appId: r.trackId,
    bundleId: r.bundleId,
    title: r.trackName,
    developer: r.artistName,
    developerId: r.artistId,
    price: r.price ?? 0,
    currency: r.currency ?? 'USD',
    rating: r.averageUserRating ?? 0,
    ratingCount: r.userRatingCount ?? 0,
    primaryGenre: r.primaryGenreName,
    primaryGenreId: r.primaryGenreId,
    icon: r.artworkUrl512 ?? r.artworkUrl100 ?? '',
    url: r.trackViewUrl,
    description: r.description ?? '',
    genres: r.genres ?? [],
  };
}

/** Метаданные приложения по числовому App ID. */
export async function appLookup(appId: number, country = config.defaultCountry): Promise<AppInfo | null> {
  const data = await fetchJson<{ results: ItunesResult[] }>(`${ITUNES}/lookup`, {
    query: { id: appId, country, entity: 'software' },
  });
  const r = data.results[0];
  return r ? mapApp(r) : null;
}

/** Метаданные пачки приложений по списку ID (iTunes Lookup, до 200 за раз). */
export async function lookupApps(
  ids: (number | string)[],
  country = config.defaultCountry,
): Promise<AppInfo[]> {
  if (ids.length === 0) return [];
  const data = await fetchJson<{ results: ItunesResult[] }>(`${ITUNES}/lookup`, {
    query: { id: ids.slice(0, 200).join(','), country, entity: 'software' },
  });
  const byId = new Map(data.results.map((r) => [String(r.trackId), mapApp(r)]));
  // Сохраняем порядок выдачи поиска.
  return ids.map((id) => byId.get(String(id))).filter((a): a is AppInfo => Boolean(a));
}

// --- LRU+TTL кэш метаданных приложений (id→AppInfo, по странам) -------------
// Топовые приложения сильно пересекаются между ключевыми словами, поэтому
// при подборе ключей одни и те же id запрашивались заново на каждый ключ.
// Кэш дедуплицирует их, а lookupAppsCached батчит только промахи.
const APP_INFO_TTL_MS = 6 * 60 * 60 * 1000;
const APP_INFO_MAX = 20000;
const appInfoCache = new Map<string, { value: AppInfo; expires: number }>();

function appCacheGet(country: string, id: string): AppInfo | undefined {
  const e = appInfoCache.get(`${country}|${id}`);
  if (!e) return undefined;
  if (Date.now() > e.expires) { appInfoCache.delete(`${country}|${id}`); return undefined; }
  return e.value;
}
function appCacheSet(country: string, info: AppInfo): void {
  if (appInfoCache.size >= APP_INFO_MAX) {
    const oldest = appInfoCache.keys().next().value;
    if (oldest !== undefined) appInfoCache.delete(oldest);
  }
  appInfoCache.set(`${country}|${info.appId}`, { value: info, expires: Date.now() + APP_INFO_TTL_MS });
}

export interface AppVersion {
  version: string;
  /** ISO-строка даты релиза. */
  releasedAt: string | null;
  notes: string;
}

// История версий меняется только с новым релизом — TTL тот же, что у метаданных.
const versionsCache = new Map<string, { value: AppVersion[]; expires: number }>();

// Элементы shelf'а версий: "primarySubtitle" — номер, "secondarySubtitle" — дата.
const VERSION_ITEM_RE =
  /"text":"((?:[^"\\]|\\.)*)","style":"detail","wantsCollapsedNewlines":\w+,"primarySubtitle":"([^"]+)","secondarySubtitle":"([^"]+)"/g;

const unescapeJson = (value: string): string => {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
};

/**
 * История версий приложения: номер, дата релиза и changelog каждого обновления.
 *
 * Единственный источник — HTML страницы приложения: публичный lookup отдаёт
 * только текущую версию, а в itml-ответе нативного клиента истории нет вовсе.
 * Парсим не всю страницу, а конкретный shelf, поэтому смена вёрстки Apple
 * ломает максимум эту одну функцию — она вернёт пустой список, а не мусор.
 */
export async function appVersionHistory(
  appId: number | string,
  country = config.defaultCountry,
): Promise<AppVersion[]> {
  const key = `${country.toLowerCase()}|${appId}`;
  const cached = versionsCache.get(key);
  if (cached && Date.now() <= cached.expires) return cached.value;

  const info = await appLookup(Number(appId), country);
  if (!info?.url) return [];

  const html = await fetchText(info.url, {
    headers: { 'User-Agent': WEB_UA, Accept: 'text/html' },
  });

  const seen = new Set<string>();
  const versions: AppVersion[] = [];

  for (const match of html.matchAll(VERSION_ITEM_RE)) {
    const version = unescapeJson(match[2]).replace(/^Version\s+/i, '').trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);

    const date = new Date(unescapeJson(match[3]));
    versions.push({
      version,
      releasedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      notes: unescapeJson(match[1]),
    });
  }

  versionsCache.set(key, { value: versions, expires: Date.now() + APP_INFO_TTL_MS });
  return versions;
}

/**
 * Как lookupApps, но с кэшем: повторно тянет из iTunes только те id,
 * которых нет в кэше (батчами до 200). Порядок выдачи сохраняется.
 */
export async function lookupAppsCached(
  ids: (number | string)[],
  country = config.defaultCountry,
): Promise<AppInfo[]> {
  if (ids.length === 0) return [];
  const missing = [...new Set(ids.map(String))].filter((id) => !appCacheGet(country, id));
  for (let i = 0; i < missing.length; i += 200) {
    const fetched = await lookupApps(missing.slice(i, i + 200), country);
    for (const a of fetched) appCacheSet(country, a);
  }
  return ids
    .map((id) => appCacheGet(country, String(id)))
    .filter((a): a is AppInfo => Boolean(a));
}

/**
 * Поисковая выдача App Store по ключевому слову.
 * Использует нативный поиск (полная ранжированная выдача), затем
 * подтягивает метаданные для первых `limit` позиций.
 */
export async function searchApps(
  term: string,
  country = config.defaultCountry,
  limit = 50,
): Promise<AppInfo[]> {
  const ids = await nativeSearchIds(term, country);
  // Через кэш, а не напрямую: метаданные полусотни приложений — это 121 КБ
  // даже со сжатием, восемь девятых всего трафика пересчёта, и качались они
  // заново на каждый ключ. А топ выдачи между ключами повторяется: по
  // «casino», «poker» и «slots» половина позиций одна и та же.
  return lookupAppsCached(ids.slice(0, limit), country);
}

/**
 * Позиция конкретного приложения по ключевому слову — реальный rank
 * из нативной выдачи App Store. null = вне выдачи.
 */
export async function getRank(
  appId: number,
  term: string,
  country = config.defaultCountry,
  language?: string,
): Promise<{ rank: number | null; total: number }> {
  const ids = await nativeSearchIds(term, country, language);
  const idx = ids.indexOf(String(appId));
  return { rank: idx === -1 ? null : idx + 1, total: ids.length };
}

/**
 * Autocomplete-подсказки App Store по префиксу.
 * Эндпоинт отдаёт XML-plist: список dict со значением <string>термин</string>.
 */
export async function suggest(
  term: string,
  country = config.defaultCountry,
  language?: string,
): Promise<string[]> {
  const xml = await fetchText(STOREFRONT, {
    query: { clientApplication: 'Software', term },
    // Язык витрины важен ровно так же, как для выдачи: на двуязычных витринах
    // (ua ru/en, ca en/fr, de de/en) подсказки на разных языках разные, и без
    // него подбор шёл по языку витрины по умолчанию независимо от того, какой
    // язык отслеживает пользователь.
    headers: { 'X-Apple-Store-Front': storeFront(country, language) },
  });
  const matches = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]!.replace(/&amp;/g, '&'),
  );
  // В plist на каждую подсказку приходятся term, priority и url — оставляем только термины.
  const terms = matches.filter(
    (s) => s && !/^\d+$/.test(s) && !s.includes('://') && !/^[A-Z][a-z]+$/.test(s),
  );
  return [...new Set(terms)];
}
