import { lookupAppsCached, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { topChart } from '../scrapers/charts.js';
import { expansionAlphabet, isMeasurable, words } from './discovery.js';
import { suggestMany } from './suggestCache.js';
import { feedCorpus } from './corpus.js';
import { corpusStats, freshCachedTerms, upsertCachedSerpBatch } from '../db/repo.js';

/**
 * Затравка словаря гео.
 *
 * Зачем: подбор для КАЖДОГО приложения собирает словарь заново из его
 * собственных метаданных и автокомплита, а это потолок в ~1-2 тысячи фраз,
 * сколько ни поднимай лимиты. Большие ASO-сервисы отвечают не так: у них есть
 * накопленный словарь по витрине и сохранённые выдачи по нему, и вопрос «по
 * каким ключам ранжируется приложение» решается поиском по своей базе.
 *
 * Ключевая экономика: одна выдача покрывает ВСЕ приложения сразу — запрос по
 * «blackjack gratuit» даёт позиции 249 приложений одновременно. Поэтому
 * затравка меряет термы без привязки к приложению и складывает снимки в
 * keyword_cache; после этого serpTermsContainingApp отвечает на вопрос
 * «где ранжируется вот это приложение» вообще без запросов в магазин.
 *
 * Источник лексики — топ-чарты витрины: их метаданные и есть язык, которым
 * пользователи этой страны ищут приложения.
 */

const SEED_TOKENS = Number(process.env.CORPUS_SEED_TOKENS ?? 150);
const SEED_BUDGET = Number(process.env.CORPUS_SEED_BUDGET ?? 3000);
const SEED_CONCURRENCY = Number(process.env.CORPUS_SEED_CONCURRENCY ?? 16);
const SEED_SUGGEST_CONCURRENCY = Number(process.env.CORPUS_SEED_SUGGEST_CONCURRENCY ?? 16);
const SEED_CHART_APPS = Number(process.env.CORPUS_SEED_CHART_APPS ?? 100);
// Горизонт, при котором терм считается «уже покрытым». Длиннее, чем TTL
// замера ранка: затравке нужна широта, а свежесть позиций обеспечит подбор.
const SEED_SKIP_TTL_HOURS = Number(process.env.CORPUS_SEED_SKIP_TTL_HOURS ?? 24 * 7);
// Размер пачки при записи снимков: один INSERT на тысячи строк упирается в
// лимит параметров и надолго держит блокировку.
const WRITE_CHUNK = 200;

// Жанры Apple, по которым берём отдельные чарты. Общий топ витрины сильно
// смещён в сторону соцсетей и банков, а лексика ниш (игры, фото, здоровье)
// в него почти не попадает — а именно она и нужна словарю.
const CHART_GENRES = (process.env.CORPUS_SEED_GENRES ?? '6014,6008,6012,6023,6002,6000')
  .split(',')
  .map((g) => Number(g.trim()))
  .filter((g) => Number.isFinite(g) && g > 0);

export interface SeedReport {
  platform: 'ios';
  country: string;
  chartApps: number;
  vocabulary: number;
  skippedFresh: number;
  measured: number;
  failed: number;
  before: { cachedTerms: number; corpusTerms: number };
  after: { cachedTerms: number; corpusTerms: number };
  durationMs: number;
}

async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/** Приложения топ-чартов витрины: общий топ + топы ключевых жанров. */
async function chartAppIds(country: string): Promise<number[]> {
  const charts = await Promise.all([
    topChart('top-free', country, undefined, SEED_CHART_APPS).catch(() => []),
    ...CHART_GENRES.map((g) =>
      topChart('top-free', country, g, SEED_CHART_APPS).catch(() => [])),
  ]);
  return [...new Set(charts.flat().map((e) => e.appId))];
}

/**
 * Лексика витрины: частотные слова метаданных топовых приложений.
 * Считаем частоту ГЛОБАЛЬНО по всем приложениям, а не по каждому отдельно —
 * слово, встречающееся у многих, и есть язык ниши, а не особенность одного
 * описания.
 */
function vocabularySeeds(texts: string[]): string[] {
  const freq = new Map<string, number>();
  for (const text of texts) {
    // Уникальные слова на приложение: иначе одно длинное описание, где слово
    // повторено двадцать раз, перевесит двадцать разных приложений.
    for (const w of new Set(words(text))) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_TOKENS)
    .map(([w]) => w);
}

let running: Promise<SeedReport> | null = null;
let lastReport: SeedReport | null = null;

export function seedInProgress(): boolean {
  return running !== null;
}

export function lastSeedReport(): SeedReport | null {
  return lastReport;
}

async function run(country: string, budget: number): Promise<SeedReport> {
  const startedAt = Date.now();
  const before = await corpusStats('ios', country).catch(
    () => ({ cachedTerms: 0, corpusTerms: 0 }),
  );

  const ids = await chartAppIds(country);
  const apps = await lookupAppsCached(ids, country).catch(() => []);
  console.log(`[seed] ${country}: ${apps.length} приложений из чартов`);

  const texts = apps.map((a) => `${a.title} ${a.primaryGenre} ${a.description}`);
  const seeds = vocabularySeeds(texts);
  const alphabet = expansionAlphabet(texts);

  // Префиксы: сами частотные слова + алфавитное расширение каждого. Подсказки
  // кэшируются на сутки, поэтому повторные прогоны по этой же витрине почти
  // не платят за генерацию.
  const prefixes = [...seeds];
  for (const seed of seeds) {
    for (const letter of alphabet) prefixes.push(`${seed} ${letter}`);
  }

  const hints = await suggestMany(
    'ios', country, prefixes,
    (term) => suggest(term, country),
    SEED_SUGGEST_CONCURRENCY,
  );

  const vocabulary = new Set<string>();
  for (const seed of seeds) if (isMeasurable(seed)) vocabulary.add(seed);
  for (const list of hints.values()) {
    for (const h of list) {
      const t = h.toLowerCase().trim();
      if (isMeasurable(t)) vocabulary.add(t);
    }
  }
  // Словарь пополняем сразу: даже термы, на замер которых не хватило бюджета,
  // пригодятся следующему подбору как корпусные кандидаты.
  feedCorpus('ios', country, [...vocabulary], 'seed');
  console.log(`[seed] ${country}: словарь ${vocabulary.size} фраз (${seeds.length} сидов × ${alphabet.length} букв)`);

  const already = await freshCachedTerms(
    'ios', country, [...vocabulary], SEED_SKIP_TTL_HOURS,
  ).catch(() => new Set<string>());
  const todo = [...vocabulary].filter((t) => !already.has(t)).slice(0, budget);
  console.log(`[seed] ${country}: уже в кэше ${already.size}, к замеру ${todo.length}`);

  let failed = 0;
  const pending: { term: string; ids: string[] }[] = [];
  const flush = async (force = false): Promise<void> => {
    if (pending.length < (force ? 1 : WRITE_CHUNK)) return;
    const batch = pending.splice(0, pending.length);
    await upsertCachedSerpBatch('ios', country, batch).catch(() => {});
  };

  await mapLimit(todo, SEED_CONCURRENCY, async (term) => {
    try {
      const serp = await nativeSearchIds(term, country);
      pending.push({ term, ids: serp });
    } catch {
      failed++;
      return;
    }
    await flush();
  });
  await flush(true);

  const after = await corpusStats('ios', country).catch(() => before);
  const report: SeedReport = {
    platform: 'ios',
    country,
    chartApps: apps.length,
    vocabulary: vocabulary.size,
    skippedFresh: already.size,
    measured: todo.length - failed,
    failed,
    before,
    after,
    durationMs: Date.now() - startedAt,
  };
  console.log(
    `[seed] ${country}: готово за ${Math.round(report.durationMs / 1000)}с — ` +
    `выдач в кэше ${before.cachedTerms} -> ${after.cachedTerms}, ` +
    `словарь ${before.corpusTerms} -> ${after.corpusTerms}`,
  );
  return report;
}

/**
 * Затравка словаря одной витрины. Одновременно крутится только одна: задача
 * надолго занимает пул каналов, и параллельные прогоны по разным гео просто
 * поделят между собой ту же пропускную способность, добавив риск 429.
 */
export async function seedGeoCorpus(
  country: string,
  opts: { budget?: number } = {},
): Promise<SeedReport> {
  if (running) return running;
  const job = run(country.toLowerCase(), opts.budget ?? SEED_BUDGET)
    .then((report) => { lastReport = report; return report; })
    .finally(() => { running = null; });
  running = job;
  return job;
}
