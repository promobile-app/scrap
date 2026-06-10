import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * Центральные веса формул volume/difficulty для обоих сторов.
 *
 * Дефолты — эвристика «на глаз». Точные веса подбираются калибровкой по
 * эталону FoxData (src/calibrateWeights.ts --write) и кладутся в weights.json
 * (путь — config.weightsPath). Файл переопределяет дефолты по-секционно, так
 * что можно откалибровать только одну метрику.
 */

export type IosVolumeWeights = {
  hint: number;
  coverage: number;
  results: number;
}
export type IosDifficultyWeights = {
  ratingsStrength: number;
  titleMatch: number;
  brand: number;
  competitors: number;
}
export type GpVolumeWeights = {
  hint: number;
  coverage: number;
  installs: number;
  results: number;
  /** web-объёмы Keyword Planner; сигнал может отсутствовать — тогда
   *  остальные веса перенормируются (см. weightedScore). */
  web: number;
}
export type GpDifficultyWeights = {
  installsStrength: number;
  ratingsStrength: number;
  titleMatch: number;
  brand: number;
}

export interface Weights {
  iosVolume: IosVolumeWeights;
  iosDifficulty: IosDifficultyWeights;
  gpVolume: GpVolumeWeights;
  gpDifficulty: GpDifficultyWeights;
}

export const DEFAULT_WEIGHTS: Weights = {
  iosVolume: { hint: 0.45, coverage: 0.25, results: 0.3 },
  iosDifficulty: { ratingsStrength: 0.45, titleMatch: 0.25, brand: 0.2, competitors: 0.1 },
  // Без web-сигнала перенормировка даёт прежние пропорции ~0.35/0.14/0.35/0.15.
  gpVolume: { hint: 0.3, coverage: 0.12, installs: 0.3, results: 0.13, web: 0.15 },
  gpDifficulty: { installsStrength: 0.4, ratingsStrength: 0.25, titleMatch: 0.2, brand: 0.15 },
};

let cached: Weights | null = null;

/** Веса: дефолты, по-секционно переопределённые weights.json (если есть). */
export function getWeights(): Weights {
  if (cached) return cached;
  let file: Partial<Record<keyof Weights, Record<string, number>>> = {};
  try {
    file = JSON.parse(readFileSync(config.weightsPath, 'utf8'));
  } catch {
    // файла нет — работаем на дефолтах
  }
  cached = {
    iosVolume: { ...DEFAULT_WEIGHTS.iosVolume, ...(file.iosVolume ?? {}) },
    iosDifficulty: { ...DEFAULT_WEIGHTS.iosDifficulty, ...(file.iosDifficulty ?? {}) },
    gpVolume: { ...DEFAULT_WEIGHTS.gpVolume, ...(file.gpVolume ?? {}) },
    gpDifficulty: { ...DEFAULT_WEIGHTS.gpDifficulty, ...(file.gpDifficulty ?? {}) },
  };
  return cached;
}

/** Сброс кэша (для тестов/калибровки). */
export function resetWeightsCache(): void {
  cached = null;
}

/**
 * Свёртка сигналов в балл 5..100.
 *
 * Сигналы со значением null (недоступный источник, напр. web без Google Ads)
 * исключаются, а веса оставшихся перенормируются — сумма эффективных весов
 * всегда 1, поэтому шкала не «проседает» от отсутствия сигнала.
 *
 * multiplier — внешний множитель (lengthPenalty для volume), применяется
 * ПОСЛЕ взвешивания, как в исходных формулах.
 */
export function weightedScore(
  signals: Record<string, number | null | undefined>,
  weights: Record<string, number>,
  multiplier = 1,
): number {
  let sum = 0;
  let wsum = 0;
  for (const [key, w] of Object.entries(weights)) {
    const s = signals[key];
    if (s == null) continue;
    sum += s * w;
    wsum += w;
  }
  const raw = (wsum > 0 ? sum / wsum : 0) * multiplier;
  return Math.round(5 + Math.min(1, Math.max(0, raw)) * 95);
}
