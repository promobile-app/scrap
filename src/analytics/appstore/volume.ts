import { suggest } from '../../scrapers/appstore.js';
import { nativeSearchIds } from '../../scrapers/native.js';
import { isAsaDashConfigured, keywordPopularity } from '../../scrapers/asaDashboard.js';
import { config } from '../../config.js';
import { getWeights, weightedScore } from '../weights.js';

export interface VolumeResult {
  score: number; // 5-100, шкала как popularity у FoxData
  source: 'estimated' | 'apple_search_ads';
  totalResults: number;
  /** Разложение по сигналам (0-1) — для прозрачности и калибровки. */
  signals?: {
    hint: number; // позиция/наличие в autocomplete
    coverage: number; // на скольких префиксах термин всплывает
    results: number; // насыщенность выдачи
    lengthPenalty: number; // штраф за длинный хвост (множитель, не вес)
  };
}

/**
 * Эвристическая оценка поискового объёма без Apple Search Ads.
 *
 * Идея: чем «популярнее» запрос, тем раньше (на более коротком префиксе) и выше
 * Apple ставит его в autocomplete, и тем больше приложений конкурируют за него.
 *
 * Сигналы:
 *  1. hint     — лучшая позиция термина в autocomplete по нескольким префиксам.
 *  2. coverage — на скольких из проверенных префиксов термин вообще всплывает
 *                (популярные всплывают уже с 2-3 букв, длинный хвост — почти нет).
 *  3. results  — насыщенность выдачи (log по числу результатов).
 *  4. lengthPenalty — штраф за длинный хвост (много слов = реже ищут).
 *
 * Это приближение. Точное значение даёт popularity из Apple Ads — см.
 * scrapers/asaDashboard.ts (требует привязанного приложения в орге).
 */

/** Префиксы для проверки autocomplete: 2 буквы, 3 буквы, половина, без последней. */
function buildPrefixes(term: string): string[] {
  const len = term.length;
  const cand = new Set<string>();
  if (len >= 2) cand.add(term.slice(0, 2));
  if (len >= 3) cand.add(term.slice(0, 3));
  cand.add(term.slice(0, Math.max(2, Math.ceil(len / 2))));
  if (len >= 4) cand.add(term.slice(0, len - 1));
  // не проверяем префикс == самому термину (тривиально всплывёт)
  cand.delete(term);
  return [...cand];
}

export async function estimateVolume(
  term: string,
  country = config.defaultCountry,
): Promise<VolumeResult> {
  const normalized = term.toLowerCase().trim();
  const prefixes = buildPrefixes(normalized);

  const [hintLists, ids] = await Promise.all([
    Promise.all(prefixes.map((p) => suggest(p, country).catch(() => [] as string[]))),
    nativeSearchIds(normalized, country).catch(() => [] as string[]),
  ]);

  // Сигнал 1+2: по каждому префиксу ищем позицию термина в подсказках.
  // hint — лучшая (наивысшая) позиция; coverage — доля префиксов с попаданием.
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

  // Сигнал 3: насыщенность выдачи (потолок ~200).
  const totalResults = ids.length;
  const resultSignal = Math.min(1, Math.log10(totalResults + 1) / Math.log10(201));

  // Штраф за длинный хвост.
  const words = normalized.split(/\s+/).length;
  const lengthPenalty = words >= 4 ? 0.55 : words === 3 ? 0.75 : words === 2 ? 0.92 : 1;

  // Веса централизованы в analytics/weights.ts (подбираются калибровкой
  // по FoxData — src/calibrateWeights.ts).
  const score = weightedScore(
    { hint: bestHint, coverage, results: resultSignal },
    getWeights().iosVolume,
    lengthPenalty,
  );

  return {
    score,
    source: 'estimated',
    totalResults,
    signals: { hint: bestHint, coverage, results: resultSignal, lengthPenalty },
  };
}

/**
 * Единая точка получения volume для сервиса.
 *
 * Если настроена сессия дашборда Apple Ads И к оргу привязано приложение —
 * берём НАСТОЯЩУЮ popularity (5-100, как у FoxData). Иначе (или при любой
 * ошибке ASA — протухла сессия / нет приложения) прозрачно падаем на
 * эвристику estimateVolume, чтобы сервис не падал.
 *
 * Когда появится приложение — достаточно заполнить ASA_DASH_ADAM_ID, и эта
 * функция автоматически начнёт отдавать source: 'apple_search_ads'.
 */
// Алерт о деградации ASA — не чаще раза в 10 минут, чтобы не заспамить лог,
// но и не потерять момент, когда сервис тихо съехал на эвристику.
let lastAsaWarnAt = 0;
function warnAsaDegraded(err: unknown): void {
  const now = Date.now();
  if (now - lastAsaWarnAt < 10 * 60 * 1000) return;
  lastAsaWarnAt = now;
  console.error(
    `[asa] popularity недоступна (${err instanceof Error ? err.message : err}) — ` +
      'volume считается эвристикой. Обнови сессию .asa-session.json!',
  );
}

export async function getVolume(
  term: string,
  country = config.defaultCountry,
): Promise<VolumeResult> {
  if (isAsaDashConfigured()) {
    try {
      const [pop] = await keywordPopularity([term], country.toUpperCase());
      if (pop && pop.popularity !== null) {
        return {
          score: pop.popularity,
          source: 'apple_search_ads',
          totalResults: 0,
        };
      }
    } catch (e) {
      // сессия протухла / нет приложения / rate limit — фолбэк, но с алертом:
      // тихая деградация в проде = незаметно неточные данные.
      warnAsaDegraded(e);
    }
  }
  return estimateVolume(term, country);
}

/** CLI-диагностика: tsx src/analytics/volume.ts "photo editor" [country] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const term = process.argv[2] ?? 'photo editor';
  const country = process.argv[3] ?? config.defaultCountry;
  estimateVolume(term, country)
    .then((r) => {
      console.log(`\nVolume "${term}" (${country}): ${r.score}/100  [${r.source}]`);
      console.log(`  hint:     ${r.signals!.hint.toFixed(2)}`);
      console.log(`  coverage: ${r.signals!.coverage.toFixed(2)}`);
      console.log(`  results:  ${r.signals!.results.toFixed(2)} (${r.totalResults} apps)\n`);
    })
    .catch((e) => {
      console.error('❌', e.message);
      process.exit(1);
    });
}
