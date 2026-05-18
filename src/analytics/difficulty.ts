import { searchApps } from '../scrapers/appstore.js';

export interface DifficultyResult {
  score: number; // 5-100: чем выше, тем труднее выйти в топ
  competitors: number;
  avgRatingCount: number;
}

/**
 * Оценка сложности продвижения по ключу (keyword difficulty).
 * Опирается на силу приложений в топ-10 выдачи: чем больше у них отзывов,
 * тем труднее их обойти.
 */
export async function estimateDifficulty(term: string, country = 'us'): Promise<DifficultyResult> {
  const results = await searchApps(term.toLowerCase().trim(), country);
  const top = results.slice(0, 10);
  if (top.length === 0) return { score: 5, competitors: 0, avgRatingCount: 0 };

  const avgRatingCount = top.reduce((s, a) => s + a.ratingCount, 0) / top.length;
  // Логарифмическая шкала: 0 отзывов -> 0, ~1M отзывов -> 1.
  const strength = Math.min(1, Math.log10(avgRatingCount + 1) / 6);
  const score = Math.round(5 + strength * 95);

  return { score, competitors: results.length, avgRatingCount: Math.round(avgRatingCount) };
}
