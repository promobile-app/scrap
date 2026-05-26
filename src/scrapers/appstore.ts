import { fetchJson, fetchText } from './http.js';
import { nativeSearchIds } from './native.js';
import { config } from '../config.js';

const ITUNES = 'https://itunes.apple.com';
// Внутренний storefront-эндпоинт App Store, отдающий поисковую выдачу.
const STOREFRONT = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
const STORE_SEARCH = 'https://itunes.apple.com/search';

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
  return lookupApps(ids.slice(0, limit), country);
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
export async function suggest(term: string, country = config.defaultCountry): Promise<string[]> {
  const xml = await fetchText(STOREFRONT, {
    query: { clientApplication: 'Software', term },
    headers: { 'X-Apple-Store-Front': storeFront(country) },
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

// Карта storefront-кодов Apple (id магазина по стране).
const STOREFRONTS: Record<string, string> = {
  us: '143441-1,29',
  gb: '143444-2,29',
  de: '143443-4,29',
  ua: '143492-16,29',
  ru: '143469-16,29',
};

function storeFront(country: string): string {
  return STOREFRONTS[country.toLowerCase()] ?? STOREFRONTS.us!;
}
