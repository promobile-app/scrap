import { gpSearch, gpSuggest, gpAppLookup, type GpAppInfo } from '../../scrapers/googleplay.js';
import { config } from '../../config.js';

export interface GpVolumeResult {
  score: number; // 5-100
  source: 'estimated';
  totalResults: number;
  signals?: {
    hint: number; // позиция в autocomplete
    coverage: number; // на скольких префиксах термин всплывает
    installs: number; // медиана установок топа (реальный спрос)
    results: number; // насыщенность выдачи
  };
}

/**
 * Оценка поискового объёма для Google Play.
 *
 * В отличие от App Store, у Google Play есть число установок — это самый
 * сильный прокси реального спроса. Поэтому помимо autocomplete используем
 * медиану установок приложений из топа выдачи.
 *
 * Сигналы:
 *  1. hint     — лучшая позиция термина в autocomplete по нескольким префиксам.
 *  2. coverage — на скольких префиксах термин всплывает (популярные — рано).
 *  3. installs — медиана установок топа (главное преимущество Google Play).
 *  4. results  — насыщенность выдачи.
 */

const TOP_FOR_INSTALLS = 5; // сколько топ-приложений догружать ради installs
// Потолок установок для log-нормализации: 100M = «максимум спроса».
const INSTALLS_CEIL_LOG = Math.log10(100_000_000 + 1);

const norm = (s: string): string => s.toLowerCase().trim();

function buildPrefixes(term: string): string[] {
  const len = term.length;
  const cand = new Set<string>();
  if (len >= 2) cand.add(term.slice(0, 2));
  if (len >= 3) cand.add(term.slice(0, 3));
  cand.add(term.slice(0, Math.max(2, Math.ceil(len / 2))));
  if (len >= 4) cand.add(term.slice(0, len - 1));
  cand.delete(term);
  return [...cand];
}

function medianInstalls(apps: GpAppInfo[]): number {
  const vals = apps.map((a) => a.minInstalls).filter((n) => n > 0).sort((x, y) => x - y);
  if (vals.length === 0) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
}

export async function gpEstimateVolume(
  term: string,
  country = config.defaultCountry,
): Promise<GpVolumeResult> {
  const normalized = norm(term);
  const prefixes = buildPrefixes(normalized);

  const [hintLists, results] = await Promise.all([
    Promise.all(prefixes.map((p) => gpSuggest(p, country).catch(() => [] as string[]))),
    gpSearch(normalized, country, 250).catch(() => [] as GpAppInfo[]),
  ]);

  // Сигнал 1+2: позиция и покрытие в autocomplete.
  let bestHint = 0;
  let hitCount = 0;
  for (const hints of hintLists) {
    const idx = hints.findIndex((h) => h === normalized);
    if (idx === -1) continue;
    hitCount++;
    const pos = 1 - idx / Math.max(hints.length, 1);
    if (pos > bestHint) bestHint = pos;
  }
  const coverage = prefixes.length ? hitCount / prefixes.length : 0;

  // Пустой gpSearch обычно = заблокированный прокси/IP (Google отдаёт пустую
  // выдачу). Сигналим в лог, чтобы в проде сразу видеть деградацию.
  if (results.length === 0) {
    console.warn(`[gp/volume] gpSearch вернул 0 для "${normalized}" (${country}) — проверь прокси`);
  }

  // Сигнал 3: медиана установок топа (поиск installs не отдаёт — догружаем детали).
  const topDetails = (
    await Promise.all(
      results.slice(0, TOP_FOR_INSTALLS).map((a) => gpAppLookup(a.appId, country).catch(() => null)),
    )
  ).filter((a): a is GpAppInfo => Boolean(a));
  const installsSignal = Math.min(
    1,
    Math.log10(medianInstalls(topDetails) + 1) / INSTALLS_CEIL_LOG,
  );

  // Сигнал 4: насыщенность выдачи.
  const resultSignal = Math.min(1, Math.log10(results.length + 1) / Math.log10(251));

  const words = normalized.split(/\s+/).length;
  const lengthPenalty = words >= 4 ? 0.55 : words === 3 ? 0.75 : words === 2 ? 0.92 : 1;

  const raw =
    (bestHint * 0.35 + coverage * 0.15 + installsSignal * 0.35 + resultSignal * 0.15) *
    lengthPenalty;

  return {
    score: Math.round(5 + Math.min(1, raw) * 95),
    source: 'estimated',
    totalResults: results.length,
    signals: { hint: bestHint, coverage, installs: installsSignal, results: resultSignal },
  };
}

/** CLI: tsx src/analytics/googleplay/volume.ts "habit tracker" [country] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const term = process.argv[2] ?? 'habit tracker';
  const country = process.argv[3] ?? config.defaultCountry;
  gpEstimateVolume(term, country)
    .then((r) => {
      console.log(`\nGP Volume "${term}" (${country}): ${r.score}/100`);
      console.log(`  hint:     ${r.signals!.hint.toFixed(2)}`);
      console.log(`  coverage: ${r.signals!.coverage.toFixed(2)}`);
      console.log(`  installs: ${r.signals!.installs.toFixed(2)}`);
      console.log(`  results:  ${r.signals!.results.toFixed(2)} (${r.totalResults})\n`);
    })
    .catch((e) => {
      console.error('❌', e.message);
      process.exit(1);
    });
}
