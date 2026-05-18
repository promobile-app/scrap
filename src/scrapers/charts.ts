import { fetchJson } from './http.js';
import { config } from '../config.js';

export interface ChartEntry {
  position: number;
  appId: number;
  title: string;
  developer: string;
}

export type ChartType = 'top-free' | 'top-paid';

interface RssFeed {
  feed: {
    results: { id: string; name: string; artistName: string }[];
  };
}

/**
 * Топ-чарты App Store по стране/категории через Apple Marketing RSS.
 * genre — числовой id жанра Apple (например 6014 = Games), либо undefined для всех.
 */
export async function topChart(
  type: ChartType = 'top-free',
  country = config.defaultCountry,
  genre?: number,
  limit = 100,
): Promise<ChartEntry[]> {
  const genrePart = genre ? `/${genre}` : '';
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/apps/${type}/${limit}${genrePart}/apps.json`;
  const data = await fetchJson<RssFeed>(url);
  return data.feed.results.map((r, i) => ({
    position: i + 1,
    appId: Number(r.id),
    title: r.name,
    developer: r.artistName,
  }));
}

/** Позиция приложения в конкретном чарте. null = вне топа. */
export async function getChartPosition(
  appId: number,
  type: ChartType = 'top-free',
  country = config.defaultCountry,
  genre?: number,
): Promise<number | null> {
  const chart = await topChart(type, country, genre);
  const entry = chart.find((e) => e.appId === appId);
  return entry?.position ?? null;
}
