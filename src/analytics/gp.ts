import { gpSearch, gpSuggest, gpAppLookup } from '../scrapers/googleplay.js';

export interface VolumeResult {
  score: number;
  source: 'estimated';
  totalResults: number;
}

export interface DifficultyResult {
  score: number;
  competitors: number;
  avgRatings: number;
}

/** Эвристическая оценка поискового объёма для Google Play. */
export async function gpEstimateVolume(term: string, country = 'us'): Promise<VolumeResult> {
  const normalized = term.toLowerCase().trim();
  const prefix = normalized.slice(0, Math.max(2, Math.ceil(normalized.length / 2)));

  const [hints, results] = await Promise.all([
    gpSuggest(prefix, country).catch(() => [] as string[]),
    gpSearch(normalized, country, 250).catch(() => []),
  ]);

  const hintIdx = hints.findIndex((h) => h === normalized);
  const hintSignal = hintIdx === -1 ? 0 : 1 - hintIdx / Math.max(hints.length, 1);
  const resultSignal = Math.min(1, Math.log10(results.length + 1) / Math.log10(251));
  const words = normalized.split(/\s+/).length;
  const lengthPenalty = words >= 4 ? 0.6 : words === 3 ? 0.8 : 1;

  const raw = (hintSignal * 0.6 + resultSignal * 0.4) * lengthPenalty;
  return {
    score: Math.round(5 + raw * 95),
    source: 'estimated',
    totalResults: results.length,
  };
}

/**
 * Оценка сложности продвижения по ключу в Google Play.
 * Поиск Play Store не отдаёт число отзывов — догружаем детали топ-приложений.
 */
export async function gpEstimateDifficulty(
  term: string,
  country = 'us',
): Promise<DifficultyResult> {
  const results = await gpSearch(term.toLowerCase().trim(), country, 50);
  const top = results.slice(0, 8);
  if (top.length === 0) return { score: 5, competitors: 0, avgRatings: 0 };

  const details = await Promise.all(top.map((a) => gpAppLookup(a.appId, country)));
  const ratingCounts = details
    .map((d) => d?.ratings ?? 0)
    .filter((n) => n > 0);
  const avgRatings =
    ratingCounts.length > 0
      ? ratingCounts.reduce((s, n) => s + n, 0) / ratingCounts.length
      : 0;
  const strength = Math.min(1, Math.log10(avgRatings + 1) / 7);
  return {
    score: Math.round(5 + strength * 95),
    competitors: results.length,
    avgRatings: Math.round(avgRatings),
  };
}
