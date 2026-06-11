import { searchApps, type AppInfo } from '../../scrapers/appstore.js';
import { config } from '../../config.js';
import { getWeights, weightedScore } from '../weights.js';
import { logNorm } from '../signals.js';

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
// Диапазон log-нормализации отзывов: ≤100 (нишевый топ) → 0, ~1M = максимум
// силы. Пол убирает завышение difficulty у низкочастотных ключей.
const RATING_FLOOR = 100;
const RATING_CEIL = 1_000_000;
const RESULTS_CEIL_LOG = Math.log10(200 + 1); // нативная выдача ~200 max

const norm = (s: string): string => s.toLowerCase().trim();

function ratingsStrength(top: AppInfo[]): number {
  if (top.length === 0) return 0;
  // Медиана log10(ratingCount) — устойчивее к одиночным выбросам, чем среднее.
  const logs = top
    .map((a) => logNorm(a.ratingCount || 0, RATING_FLOOR, RATING_CEIL))
    .sort((x, y) => x - y);
  const mid = Math.floor(logs.length / 2);
  return logs.length % 2 ? logs[mid]! : (logs[mid - 1]! + logs[mid]!) / 2;
}

// Заточенность топа под ключ: точная фраза в названии — полный балл,
// все слова вразброс ("Photo Crop Editor" для "photo editor") — половина.
// FoxData различает эти случаи; раньше вразброс не учитывалось вовсе.
function titleMatch(top: Array<{ title: string }>, term: string): number {
  if (top.length === 0) return 0;
  const t = norm(term);
  const tokens = t.split(/\s+/).filter(Boolean);
  let credit = 0;
  for (const a of top) {
    const title = norm(a.title);
    if (title.includes(t)) credit += 1;
    else if (tokens.length > 1 && tokens.every((w) => title.includes(w))) credit += 0.5;
  }
  return credit / top.length;
}

function brandSignal(top: AppInfo[], term: string): number {
  // Брендовость: ключом называется ОДНО доминирующее приложение (имя или
  // разработчик в топ-3), а не вся выдача. Если ключ встречается в заголовках
  // заметной доли топа — это generic-запрос, по которому приложения просто
  // названы ("habit tracker"), и брендом он не считается (иначе difficulty
  // завышается у всех средне-частотников и дублирует titleMatch).
  const t = norm(term);
  const titleShare =
    top.filter((a) => norm(a.title).includes(t)).length / Math.max(top.length, 1);
  const generic = titleShare > 0.3;
  return top.slice(0, 3).some((a) => {
    const name = norm(a.title);
    const dev = norm(a.developer);
    // Точное совпадение с разработчиком — бренд всегда ("spotify" → Spotify).
    if (dev === t) return true;
    // Совпадения по названию (даже точные) не считаются брендом, если ключ
    // встречается в заголовках многих приложений топа: приложение, названное
    // буквально "Habit Tracker", не делает запрос брендовым.
    if (generic) return false;
    return name === t || name.startsWith(t) || dev.includes(t);
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

  const avgRatingCount = top.reduce((s, a) => s + a.ratingCount, 0) / top.length;

  return {
    // Веса централизованы в analytics/weights.ts (калибруются по FoxData).
    score: weightedScore(signals, getWeights().iosDifficulty),
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
