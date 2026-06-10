import { searchApps, type AppInfo } from '../scrapers/appstore.js';
import { config } from '../config.js';

export interface DifficultyResult {
  score: number; // 5-100: чем выше, тем труднее выйти в топ
  competitors: number;
  avgRatingCount: number;
  /** Разложение по сигналам (0-1 каждый) — для прозрачности и калибровки. */
  signals: {
    ratingsStrength: number;
    titleMatch: number;
    brand: number;
    competitors: number;
  };
}

/**
 * Оценка сложности продвижения по ключу (keyword difficulty), шкала 5-100.
 *
 * Apple не отдаёт сложность — считаем её сами из открытой выдачи App Store.
 * Логика как у FoxData/AppTweak: чем сильнее приложения в топе и чем плотнее
 * они заточены под ключ, тем труднее туда пробиться.
 *
 * Сигналы (по топ-10 выдачи):
 *  1. ratingsStrength — «вес» отзывов у топа (медиана log10). Главный сигнал.
 *  2. titleMatch      — доля топа с ключом прямо в названии (заточенность).
 *  3. brand           — ключ == имя/разработчик топ-приложения (брендовый трафик).
 *  4. competitors     — насыщенность выдачи (log по числу результатов).
 *
 * Веса эвристические; при наличии эталона (ASA popularity / FoxData) калибруются.
 */

const TOP_N = 10;
const RATING_CEIL_LOG = Math.log10(1_000_000 + 1); // ~1M отзывов = максимум силы
const RESULTS_CEIL_LOG = Math.log10(200 + 1); // нативная выдача ~200 max

const norm = (s: string): string => s.toLowerCase().trim();

function ratingsStrength(top: AppInfo[]): number {
  if (top.length === 0) return 0;
  // Медиана log10(ratingCount) — устойчивее к одиночным выбросам, чем среднее.
  const logs = top
    .map((a) => Math.log10((a.ratingCount || 0) + 1) / RATING_CEIL_LOG)
    .sort((x, y) => x - y);
  const mid = Math.floor(logs.length / 2);
  const median = logs.length % 2 ? logs[mid]! : (logs[mid - 1]! + logs[mid]!) / 2;
  return Math.min(1, median);
}

function titleMatch(top: AppInfo[], term: string): number {
  if (top.length === 0) return 0;
  const t = norm(term);
  return top.filter((a) => norm(a.title).includes(t)).length / top.length;
}

function brandSignal(top: AppInfo[], term: string): number {
  // Брендовость: ключ совпадает с названием/разработчиком одного из топ-3.
  const t = norm(term);
  return top.slice(0, 3).some((a) => {
    const name = norm(a.title);
    const dev = norm(a.developer);
    return name === t || dev === t || name.startsWith(t) || dev.includes(t);
  })
    ? 1
    : 0;
}

export async function estimateDifficulty(
  term: string,
  country = config.defaultCountry,
): Promise<DifficultyResult> {
  const results = await searchApps(norm(term), country);
  const top = results.slice(0, TOP_N);

  if (top.length === 0) {
    return {
      score: 5,
      competitors: 0,
      avgRatingCount: 0,
      signals: { ratingsStrength: 0, titleMatch: 0, brand: 0, competitors: 0 },
    };
  }

  const signals = {
    ratingsStrength: ratingsStrength(top),
    titleMatch: titleMatch(top, term),
    brand: brandSignal(top, term),
    competitors: Math.min(1, Math.log10(results.length + 1) / RESULTS_CEIL_LOG),
  };

  const raw =
    signals.ratingsStrength * 0.45 +
    signals.titleMatch * 0.25 +
    signals.brand * 0.2 +
    signals.competitors * 0.1;

  const avgRatingCount = top.reduce((s, a) => s + a.ratingCount, 0) / top.length;

  return {
    score: Math.round(5 + Math.min(1, raw) * 95), // 5..100
    competitors: results.length,
    avgRatingCount: Math.round(avgRatingCount),
    signals,
  };
}

/** CLI-диагностика: tsx src/analytics/difficulty.ts "photo editor" [country] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const term = process.argv[2] ?? 'photo editor';
  const country = process.argv[3] ?? config.defaultCountry;
  estimateDifficulty(term, country)
    .then((r) => {
      console.log(`\nDifficulty "${term}" (${country}): ${r.score}/100`);
      console.log(`  ratingsStrength: ${r.signals.ratingsStrength.toFixed(2)}`);
      console.log(`  titleMatch:      ${r.signals.titleMatch.toFixed(2)}`);
      console.log(`  brand:           ${r.signals.brand.toFixed(2)}`);
      console.log(`  competitors:     ${r.signals.competitors.toFixed(2)} (${r.competitors} apps)`);
      console.log(`  avgRatingCount:  ${r.avgRatingCount}\n`);
    })
    .catch((e) => {
      console.error('❌', e.message);
      process.exit(1);
    });
}
