/**
 * Подбор весов формул volume/difficulty по эталону FoxData.
 *
 * Вход — один или несколько дампов сигналов от compareFox.ts --signals-out
 * (желательно с РАЗНЫХ приложений/ниш одной платформы, чтобы веса не
 * переобучились под одно приложение):
 *
 *   npx tsx src/compareFox.ts ./fox1.json --signals-out=./sig1.json
 *   npx tsx src/compareFox.ts ./fox2.json --signals-out=./sig2.json
 *   npx tsx src/calibrateWeights.ts ./sig1.json ./sig2.json [--write]
 *
 * Перебирает веса по сетке (шаг 0.05, сумма = 1), минимизируя MAE против
 * FoxData. --write сохраняет лучшие веса в weights.json (config.weightsPath) —
 * формулы подхватят их без правок кода (analytics/weights.ts).
 *
 * Модель та же, что в проде:
 *   volume     = 5 + min(1, Σ(wᵢ·sᵢ)/Σwᵢ · lengthPenalty) · 95
 *   difficulty = 5 + min(1, Σ(wᵢ·sᵢ)/Σwᵢ) · 95
 * (null-сигналы исключаются с перенормировкой — как в weightedScore).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { DEFAULT_WEIGHTS } from './analytics/weights.js';

interface SignalRow {
  term: string;
  fox: { rank: number | null; volume: number | null; difficulty: number | null };
  volumeSignals: Record<string, number | null> | null;
  lengthPenalty: number;
  difficultySignals: Record<string, number> | null;
}
interface SignalsFile { platform: 'ios' | 'android'; rows: SignalRow[] }

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WRITE = process.argv.includes('--write');
if (files.length === 0) {
  console.error('Использование: npx tsx src/calibrateWeights.ts sig1.json [sig2.json ...] [--write]');
  process.exit(1);
}

const inputs: SignalsFile[] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));

// --- модель -----------------------------------------------------------------

function score(
  signals: Record<string, number | null | undefined>,
  weights: Record<string, number>,
  multiplier = 1,
): number {
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    const s = signals[k];
    if (s == null) continue;
    sum += s * w; wsum += w;
  }
  const raw = (wsum > 0 ? sum / wsum : 0) * multiplier;
  return Math.round(5 + Math.min(1, Math.max(0, raw)) * 95);
}

function mae(
  rows: Array<{ target: number; signals: Record<string, number | null>; multiplier: number }>,
  weights: Record<string, number>,
): number {
  let s = 0;
  for (const r of rows) s += Math.abs(r.target - score(r.signals, weights, r.multiplier));
  return s / rows.length;
}

// --- сетка весов: все композиции step=0.05 с суммой 1 ------------------------

function* compositions(keys: string[], parts = 20): Generator<Record<string, number>> {
  const k = keys.length;
  const acc: number[] = new Array(k).fill(0);
  function* rec(idx: number, left: number): Generator<Record<string, number>> {
    if (idx === k - 1) {
      acc[idx] = left;
      yield Object.fromEntries(keys.map((key, i) => [key, acc[i]! / parts]));
      return;
    }
    for (let v = 0; v <= left; v++) {
      acc[idx] = v;
      yield* rec(idx + 1, left - v);
    }
  }
  yield* rec(0, parts);
}

function fit(
  label: string,
  rows: Array<{ target: number; signals: Record<string, number | null>; multiplier: number }>,
  current: Record<string, number>,
): Record<string, number> | null {
  if (rows.length < 15) {
    console.log(`${label}: мало данных (${rows.length} строк, нужно ≥15) — пропуск`);
    return null;
  }
  const keys = Object.keys(current);
  const before = mae(rows, current);
  let best = current;
  let bestErr = before;
  for (const w of compositions(keys)) {
    const e = mae(rows, w);
    if (e < bestErr) { bestErr = e; best = w; }
  }
  const fmt = (w: Record<string, number>) =>
    Object.entries(w).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
  console.log(`${label} (n=${rows.length}):`);
  console.log(`  было:  MAE ${before.toFixed(1)}  [${fmt(current)}]`);
  console.log(`  стало: MAE ${bestErr.toFixed(1)}  [${fmt(best)}]`);
  if (bestErr >= before - 0.05) {
    console.log('  выигрыш незначим — оставляем текущие веса');
    return null;
  }
  return best;
}

// --- сборка датасетов по платформам ------------------------------------------

type Dataset = Array<{ target: number; signals: Record<string, number | null>; multiplier: number }>;
const ds: Record<string, Dataset> = { iosVolume: [], iosDifficulty: [], gpVolume: [], gpDifficulty: [] };

for (const input of inputs) {
  const prefix = input.platform === 'android' ? 'gp' : 'ios';
  for (const r of input.rows) {
    if (r.fox.volume != null && r.volumeSignals) {
      ds[`${prefix}Volume`]!.push({ target: r.fox.volume, signals: r.volumeSignals, multiplier: r.lengthPenalty });
    }
    if (r.fox.difficulty != null && r.difficultySignals) {
      ds[`${prefix}Difficulty`]!.push({ target: r.fox.difficulty, signals: r.difficultySignals, multiplier: 1 });
    }
  }
}

// --- калибровка и запись ------------------------------------------------------

const sections: Array<[keyof typeof DEFAULT_WEIGHTS, string]> = [
  ['iosVolume', 'iOS volume'],
  ['iosDifficulty', 'iOS difficulty'],
  ['gpVolume', 'GP volume'],
  ['gpDifficulty', 'GP difficulty'],
];

const updates: Record<string, Record<string, number>> = {};
for (const [key, label] of sections) {
  const fitted = fit(label, ds[key]!, DEFAULT_WEIGHTS[key] as unknown as Record<string, number>);
  if (fitted) updates[key] = fitted;
}

if (WRITE && Object.keys(updates).length > 0) {
  const path = config.weightsPath;
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(path, JSON.stringify({ ...existing, ...updates }, null, 2));
  console.log(`\nЗаписано → ${path} (${Object.keys(updates).join(', ')}). Перезапусти сервис.`);
} else if (Object.keys(updates).length > 0) {
  console.log('\nЗапуск без --write: веса НЕ сохранены (добавь --write чтобы применить).');
} else {
  console.log('\nНечего сохранять.');
}
