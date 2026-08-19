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

/** Ответ легаси-фида iTunes — единственного, который умеет чарты по жанру. */
interface LegacyFeed {
  feed: {
    entry?: {
      id: { attributes: { 'im:id': string } };
      'im:name': { label: string };
      'im:artist': { label: string };
    }[];
  };
}

const LEGACY_FEED_NAME: Record<ChartType, string> = {
  'top-free': 'topfreeapplications',
  'top-paid': 'toppaidapplications',
};

/**
 * Топ-чарты App Store по стране и (опционально) категории.
 *
 * Два разных фида, и это не про вкус:
 * - общий чарт — Marketing Tools RSS, актуальный фид Apple;
 * - чарт категории — легаси-фид iTunes: Marketing Tools жанры не отдаёт вообще,
 *   любой genre-сегмент в его URL отвечает 404, из-за чего категорийные срезы
 *   молча не собирались.
 *
 * Оба фида отдают максимум 100 позиций: Marketing Tools на limit=200 отвечает
 * 500, легаси молча обрезает до сотни. Приложение вне первой сотни в чарте
 * считаем отсутствующим.
 */
export async function topChart(
  type: ChartType = 'top-free',
  country = config.defaultCountry,
  genre?: number,
  limit = 100,
): Promise<ChartEntry[]> {
  const capped = Math.min(limit, 100);

  if (genre) {
    const url =
      `https://itunes.apple.com/${country.toLowerCase()}/rss/${LEGACY_FEED_NAME[type]}` +
      `/limit=${capped}/genre=${genre}/json`;
    const data = await fetchJson<LegacyFeed>(url);
    return (data.feed.entry ?? []).map((e, i) => ({
      position: i + 1,
      appId: Number(e.id.attributes['im:id']),
      title: e['im:name'].label,
      developer: e['im:artist'].label,
    }));
  }

  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/apps/${type}/${capped}/apps.json`;
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
