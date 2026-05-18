import { suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';

export interface VolumeResult {
  score: number; // 5-100, шкала как popularity у FoxData
  source: 'estimated' | 'apple_search_ads';
  totalResults: number;
}

/**
 * Эвристическая оценка поискового объёма без Apple Search Ads.
 *
 * Идея: чем «популярнее» запрос, тем выше Apple ставит его в autocomplete
 * при вводе префикса, и тем больше приложений конкурируют за него.
 * Сигналы:
 *  1. Появляется ли термин в подсказках по своему префиксу и на какой позиции.
 *  2. Сколько приложений в выдаче (насыщенность ниши).
 *  3. Длина запроса (длинный хвост = ниже объём).
 *
 * Это приближение. Точное значение даёт только метрика popularity из ASA —
 * см. estimateVolumeASA (этап после подключения аккаунта Apple Search Ads).
 */
export async function estimateVolume(term: string, country = 'us'): Promise<VolumeResult> {
  const normalized = term.toLowerCase().trim();
  const prefix = normalized.slice(0, Math.max(2, Math.ceil(normalized.length / 2)));

  const [hints, ids] = await Promise.all([
    suggest(prefix, country).catch(() => [] as string[]),
    nativeSearchIds(normalized, country).catch(() => [] as string[]),
  ]);

  // Сигнал 1: позиция термина в autocomplete (0..1, выше = популярнее).
  const hintIdx = hints.findIndex((h) => h === normalized);
  const hintSignal = hintIdx === -1 ? 0 : 1 - hintIdx / Math.max(hints.length, 1);

  // Сигнал 2: насыщенность выдачи (логарифмическая шкала, потолок ~200).
  const totalResults = ids.length;
  const resultSignal = Math.min(1, Math.log10(totalResults + 1) / Math.log10(201));

  // Сигнал 3: штраф за длинный хвост (много слов = реже ищут).
  const words = normalized.split(/\s+/).length;
  const lengthPenalty = words >= 4 ? 0.6 : words === 3 ? 0.8 : 1;

  const raw = (hintSignal * 0.6 + resultSignal * 0.4) * lengthPenalty;
  const score = Math.round(5 + raw * 95); // отображаем в 5..100

  return { score, source: 'estimated', totalResults };
}
