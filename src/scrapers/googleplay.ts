import gplay from 'google-play-scraper';
import { config } from '../config.js';
import { gpRequestOptions } from './proxy.js';

/**
 * Скрейпер Google Play. У Play Store нет официального API — библиотека
 * google-play-scraper парсит публичные веб-страницы Play Store.
 * appId в Google Play — это имя пакета (строка), напр. "com.moneyveo.app".
 */

export interface GpAppInfo {
  appId: string;
  title: string;
  developer: string;
  score: number;
  ratings: number;
  installs: string;
  genre: string;
  icon: string;
  url: string;
  free: boolean;
  description: string;
  summary: string;
}

// Язык витрины по стране (Play Store учитывает lang при ранжировании).
const COUNTRY_LANG: Record<string, string> = {
  us: 'en', gb: 'en', de: 'de', ua: 'uk', ru: 'ru',
  pl: 'pl', fr: 'fr', es: 'es', it: 'it', ca: 'en',
};

function langOf(country: string): string {
  return COUNTRY_LANG[country.toLowerCase()] ?? 'en';
}

interface GpRaw {
  appId: string;
  title: string;
  developer: string | { devId?: string };
  score?: number;
  ratings?: number;
  installs?: string;
  genre?: string;
  icon?: string;
  url?: string;
  free?: boolean;
  description?: string;
  summary?: string;
}

function mapApp(r: GpRaw): GpAppInfo {
  return {
    appId: r.appId,
    title: r.title,
    developer: typeof r.developer === 'string' ? r.developer : (r.developer?.devId ?? ''),
    score: r.score ?? 0,
    ratings: r.ratings ?? 0,
    installs: r.installs ?? '',
    genre: r.genre ?? '',
    icon: r.icon ?? '',
    url: r.url ?? '',
    free: r.free ?? true,
    description: r.description ?? '',
    summary: r.summary ?? '',
  };
}

/** Метаданные приложения Google Play по имени пакета. */
export async function gpAppLookup(
  appId: string,
  country = config.defaultCountry,
): Promise<GpAppInfo | null> {
  try {
    const r = await gplay.app({
      appId, country, lang: langOf(country), requestOptions: gpRequestOptions(),
    } as Parameters<typeof gplay.app>[0]);
    return mapApp(r as GpRaw);
  } catch {
    return null;
  }
}

/** Поисковая выдача Google Play — упорядоченный список приложений. */
export async function gpSearch(
  term: string,
  country = config.defaultCountry,
  num = 100,
): Promise<GpAppInfo[]> {
  const results = await gplay.search({ term, country, lang: langOf(country), num, requestOptions: gpRequestOptions() });
  return (results as GpRaw[]).map(mapApp);
}

/** Позиция приложения по ключевому слову в выдаче Google Play. */
export async function gpGetRank(
  appId: string,
  term: string,
  country = config.defaultCountry,
): Promise<{ rank: number | null; total: number }> {
  const results = await gpSearch(term, country, 250);
  const idx = results.findIndex((a) => a.appId === appId);
  return { rank: idx === -1 ? null : idx + 1, total: results.length };
}

/** Autocomplete-подсказки Google Play. */
export async function gpSuggest(
  term: string,
  country = config.defaultCountry,
): Promise<string[]> {
  try {
    return await gplay.suggest({
      term, country, lang: langOf(country), requestOptions: gpRequestOptions(),
    } as Parameters<typeof gplay.suggest>[0]);
  } catch {
    return [];
  }
}

/** Топ-чарт Google Play (бесплатные приложения по стране). */
export async function gpTopChart(
  country = config.defaultCountry,
  num = 100,
): Promise<GpAppInfo[]> {
  // Типы google-play-scraper не экспонируют ключи enum — обращаемся через cast.
  const enums = gplay as unknown as {
    collection: Record<string, string>;
    category: Record<string, string>;
  };
  const results = await gplay.list({
    collection: enums.collection.TOP_FREE,
    category: enums.category.APPLICATION,
    country,
    lang: langOf(country),
    num,
    requestOptions: gpRequestOptions(),
  } as Parameters<typeof gplay.list>[0]);
  return (results as GpRaw[]).map(mapApp);
}
