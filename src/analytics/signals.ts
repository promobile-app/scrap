/**
 * Общие помощники для сигналов метрик (оба стора).
 */

/**
 * Информативность autocomplete-префикса по его длине.
 *
 * Попасть в подсказки по 2-3 буквам может только по-настоящему популярный
 * запрос (за «vp» конкурируют ВСЕ запросы на «vp*»), а «термин без последней
 * буквы» магазин тривиально дополняет до любого существующего запроса — это
 * сигнал существования запроса (его учитывает coverage), но почти не сигнал
 * популярности. Без этого веса hint ≈ 1.0 у любого реального запроса и volume
 * слипается у потолка (на проде медиана была 95, у 64% ключей ≥80).
 */
/**
 * Log-нормализация с полом и потолком: значения ≤ floor → 0, ≥ ceil → 1.
 *
 * Без пола у installs/ratings-сигналов есть «пол» ~0.5-0.7 даже на нишевых
 * ключах: в любом топе Google Play найдутся приложения с 1M+ установок, из-за
 * чего difficulty/volume низкочастотников систематически завышались
 * (нишевый B2B-ключ получал difficulty 46 там, где FoxData даёт ~20-30).
 */
export function logNorm(value: number, floor: number, ceil: number): number {
  if (value <= floor) return 0;
  const lo = Math.log10(floor + 1);
  const hi = Math.log10(ceil + 1);
  return Math.min(1, Math.max(0, (Math.log10(value + 1) - lo) / (hi - lo)));
}

export function prefixInformativeness(prefixLen: number): number {
  if (prefixLen <= 2) return 1;
  if (prefixLen === 3) return 0.85;
  if (prefixLen <= 5) return 0.65;
  if (prefixLen <= 8) return 0.45;
  if (prefixLen <= 12) return 0.3;
  return 0.15;
}
