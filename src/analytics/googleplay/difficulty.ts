import { gpSearch, gpAppLookup, type GpAppInfo } from '../../scrapers/googleplay.js';
import { config } from '../../config.js';
import { getWeights, weightedScore } from '../weights.js';

export interface GpDifficultyResult {
  score: number; // 5-100
  competitors: number;
  avgRatings: number;
  avgInstalls: number;
  signals: {
    installsStrength: number;
    ratingsStrength: number;
    titleMatch: number;
    brand: number;
  };
}

/**
 * Оценка сложности продвижения по ключу в Google Play, шкала 5-100.
 *
 * Главное отличие от App Store: Google Play отдаёт число установок — это
 * сильнейший сигнал силы конкурентов. Используем его как основной.
 *
 * Сигналы (по топ выдачи, с догрузкой деталей):
 *  1. installsStrength — медиана log10(installs) топа. Главный сигнал.
 *  2. ratingsStrength  — медиана log10(ratings) топа.
 *  3. titleMatch       — доля топа с ключом в названии.
 *  4. brand            — ключ == имя/разработчик топ-приложения.
 */

const TOP_N = 8;
// Потолок 1B (не 100M) — иначе все крупные приложения упираются в ~1.0 и
// difficulty неразличим. Синхронизировано с gpDifficulty в discoverByUrl.ts.
const INSTALLS_CEIL_LOG = Math.log10(1_000_000_000 + 1);
const RATING_CEIL_LOG = Math.log10(5_000_000 + 1); // 5M отзывов = максимум

const norm = (s: string): string => s.toLowerCase().trim();

function medianLog(vals: number[], ceilLog: number): number {
  const logs = vals
    .filter((n) => n > 0)
    .map((n) => Math.log10(n + 1) / ceilLog)
    .sort((x, y) => x - y);
  if (logs.length === 0) return 0;
  const mid = Math.floor(logs.length / 2);
  const m = logs.length % 2 ? logs[mid]! : (logs[mid - 1]! + logs[mid]!) / 2;
  return Math.min(1, m);
}

// Точная фраза в названии — полный балл, все слова вразброс — половина
// (FoxData различает эти случаи).
function titleMatch(top: GpAppInfo[], term: string): number {
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

function brandSignal(top: GpAppInfo[], term: string): number {
  // См. комментарий в appstore/difficulty.ts: бренд = ключом называется ОДНО
  // доминирующее приложение, а не вся выдача (generic-ключи вроде "habit
  // tracker" брендом не считаются).
  const t = norm(term);
  const titleShare =
    top.filter((a) => norm(a.title).includes(t)).length / Math.max(top.length, 1);
  const generic = titleShare > 0.3;
  return top.slice(0, 3).some((a) => {
    const name = norm(a.title);
    const dev = norm(a.developer);
    if (dev === t) return true;
    if (generic) return false;
    return name === t || name.startsWith(t) || dev.includes(t);
  })
    ? 1
    : 0;
}

export async function gpEstimateDifficulty(
  term: string,
  country = config.defaultCountry,
): Promise<GpDifficultyResult> {
  const results = await gpSearch(norm(term), country, 50);
  const topList = results.slice(0, TOP_N);
  if (results.length === 0) {
    // Пустая выдача обычно = заблокированный прокси/IP — сигналим в лог.
    console.warn(`[gp/difficulty] gpSearch вернул 0 для "${norm(term)}" (${country}) — проверь прокси`);
  }
  if (topList.length === 0) {
    return {
      score: 5,
      competitors: 0,
      avgRatings: 0,
      avgInstalls: 0,
      signals: { installsStrength: 0, ratingsStrength: 0, titleMatch: 0, brand: 0 },
    };
  }

  // Поиск не отдаёт installs/ratings — догружаем детали топа.
  const details = (
    await Promise.all(topList.map((a) => gpAppLookup(a.appId, country).catch(() => null)))
  ).filter((a): a is GpAppInfo => Boolean(a));

  const installsArr = details.map((d) => d.minInstalls);
  const ratingsArr = details.map((d) => d.ratings);

  const signals = {
    installsStrength: medianLog(installsArr, INSTALLS_CEIL_LOG),
    ratingsStrength: medianLog(ratingsArr, RATING_CEIL_LOG),
    titleMatch: titleMatch(details, term),
    brand: brandSignal(details, term),
  };

  const nonZero = (arr: number[]): number[] => arr.filter((n) => n > 0);
  const avg = (arr: number[]): number =>
    arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : 0;

  return {
    // Веса централизованы в analytics/weights.ts (калибруются по FoxData).
    score: weightedScore(signals, getWeights().gpDifficulty),
    competitors: results.length,
    avgRatings: avg(nonZero(ratingsArr)),
    avgInstalls: avg(nonZero(installsArr)),
    signals,
  };
}

/** CLI: tsx src/analytics/googleplay/difficulty.ts "habit tracker" [country] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const term = process.argv[2] ?? 'habit tracker';
  const country = process.argv[3] ?? config.defaultCountry;
  gpEstimateDifficulty(term, country)
    .then((r) => {
      console.log(`\nGP Difficulty "${term}" (${country}): ${r.score}/100`);
      console.log(`  installsStrength: ${r.signals.installsStrength.toFixed(2)} (avg ${r.avgInstalls})`);
      console.log(`  ratingsStrength:  ${r.signals.ratingsStrength.toFixed(2)} (avg ${r.avgRatings})`);
      console.log(`  titleMatch:       ${r.signals.titleMatch.toFixed(2)}`);
      console.log(`  brand:            ${r.signals.brand.toFixed(2)}`);
      console.log(`  competitors:      ${r.competitors}\n`);
    })
    .catch((e) => {
      console.error('❌', e.message);
      process.exit(1);
    });
}
