/**
 * Сверка метрик скрапера против эталона FoxData.
 *
 * Вход — JSON-файл вида:
 *   {
 *     "platform": "ios" | "android",
 *     "appId": "544007664",
 *     "country": "us",
 *     "language": "en",
 *     "rows": [ { "term": "...", "rank": 12, "volume": 49, "difficulty": 46 }, ... ]
 *   }
 * (поля rank/volume/difficulty из FoxData; пустые допустимы.)
 *
 * Скрипт live-гоняет скрапер по тем же term и печатает таблицу расхождений + сводку.
 * БД не требуется.
 *
 *   npx tsx src/compareFox.ts ./fox.json [--limit=30] [--signals-out=./signals.json]
 *
 * --signals-out пишет датасет с СЫРЫМИ сигналами формул (hint/coverage/installs/...)
 * для подбора весов: npx tsx src/calibrateWeights.ts ./signals.json --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getRank } from './scrapers/appstore.js';
import { estimateVolume } from './analytics/appstore/volume.js';
import { estimateDifficulty } from './analytics/appstore/difficulty.js';
import { gpGetRank } from './scrapers/googleplay.js';
import { gpEstimateVolume } from './analytics/googleplay/volume.js';
import { gpEstimateDifficulty } from './analytics/googleplay/difficulty.js';

interface FoxRow { term: string; rank?: number | null; volume?: number | null; difficulty?: number | null }
interface Input { platform: 'ios' | 'android'; appId: string; country: string; language?: string; rows: FoxRow[] }

const file = process.argv[2];
const limitFlag = process.argv.find((a) => a.startsWith('--limit='));
const signalsOut = process.argv.find((a) => a.startsWith('--signals-out='))?.split('=')[1];
const LIMIT = limitFlag ? Number(limitFlag.split('=')[1]) : 9999;
if (!file) { console.error('Использование: npx tsx src/compareFox.ts ./fox.json [--limit=N] [--signals-out=path]'); process.exit(1); }

const input: Input = JSON.parse(readFileSync(file, 'utf8'));
const rows = input.rows.slice(0, LIMIT);
const country = input.country.toLowerCase();
const lang = input.language || (country === 'us' ? 'en' : country);

interface Out {
  term: string;
  foxR?: number | null; sR: number | null; depth: number;
  foxV?: number | null; sV: number;
  foxD?: number | null; sD: number;
  volumeSignals?: Record<string, number | null>;
  lengthPenalty?: number;
  difficultySignals?: Record<string, number>;
}

async function one(r: FoxRow): Promise<Out> {
  if (input.platform === 'android') {
    const [rk, v, d] = await Promise.all([
      gpGetRank(input.appId, r.term, country).catch(() => ({ rank: null as number | null, total: 0 })),
      gpEstimateVolume(r.term, country).catch(() => ({ score: 0, signals: undefined, totalResults: 0 })),
      gpEstimateDifficulty(r.term, country).catch(() => ({ score: 0, signals: undefined })),
    ]);
    const { lengthPenalty, ...vSignals } = v.signals ?? ({} as Record<string, number | null> & { lengthPenalty?: number });
    return {
      term: r.term, foxR: r.rank, sR: rk.rank, depth: rk.total,
      foxV: r.volume, sV: v.score, foxD: r.difficulty, sD: d.score,
      volumeSignals: v.signals ? vSignals : undefined,
      lengthPenalty,
      difficultySignals: d.signals as Record<string, number> | undefined,
    };
  }
  const [rk, v, d] = await Promise.all([
    getRank(Number(input.appId), r.term, country, lang).catch(() => ({ rank: null as number | null, total: 0 })),
    estimateVolume(r.term, country).catch(() => ({ score: 0, signals: undefined, totalResults: 0 })),
    estimateDifficulty(r.term, country).catch(() => ({ score: 0, signals: undefined })),
  ]);
  const { lengthPenalty, ...vSignals } = v.signals ?? ({} as Record<string, number> & { lengthPenalty?: number });
  return {
    term: r.term, foxR: r.rank, sR: rk.rank, depth: rk.total,
    foxV: r.volume, sV: v.score, foxD: r.difficulty, sD: d.score,
    volumeSignals: v.signals ? vSignals : undefined,
    lengthPenalty,
    difficultySignals: d.signals as Record<string, number> | undefined,
  };
}

// небольшая конкуренция, чтобы не выгрести rate limit
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  async function w() { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); process.stderr.write('.'); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
  return out;
}

function pad(s: string | number | null | undefined, n: number) { return String(s ?? '–').padEnd(n); }

(async () => {
  console.error(`Сверяю ${rows.length} ключей (${input.platform} ${input.appId} ${country})…`);
  const res = await mapLimit(rows, 6, one);
  process.stderr.write('\n');

  console.log('\nterm'.padEnd(28) + 'RANK fox/scr   VOL fox/scr   DIFF fox/scr');
  console.log('-'.repeat(78));
  const vErr: number[] = [], dErr: number[] = [];
  let rankHit = 0, rankTotal = 0, rankTop10Agree = 0, rankOutOfDepth = 0;
  for (const o of res) {
    console.log(
      pad(o.term, 28) +
      pad(`${o.foxR ?? '–'}/${o.sR ?? '–'}`, 15) +
      pad(`${o.foxV ?? '–'}/${o.sV}`, 14) +
      pad(`${o.foxD ?? '–'}/${o.sD}`, 14),
    );
    if (o.foxV != null) vErr.push(Math.abs(o.foxV - o.sV));
    if (o.foxD != null) dErr.push(Math.abs(o.foxD - o.sD));
    if (o.foxR != null) {
      // Fox видит позицию глубже нашей выдачи (особенно GP: веб отдаёт ~30) —
      // это ограничение глубины, а не ошибка скрапера. Не считаем промахом.
      if (o.sR === null && o.foxR > o.depth && o.depth > 0) { rankOutOfDepth++; continue; }
      rankTotal++;
      if (o.sR != null && Math.abs(o.foxR - o.sR) <= 3) rankHit++;
      const foxTop = o.foxR <= 10, scrTop = o.sR != null && o.sR <= 10;
      if (foxTop === scrTop) rankTop10Agree++;
    }
  }
  const mae = (a: number[]) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : 'n/a';
  console.log('-'.repeat(78));
  console.log(
    `RANK: совпало ±3 поз.: ${rankHit}/${rankTotal}; согласие "в топ-10": ${rankTop10Agree}/${rankTotal}` +
    (rankOutOfDepth ? `; глубже нашей выдачи: ${rankOutOfDepth} (не считаются промахом)` : ''),
  );
  console.log(`VOL : средняя ошибка (MAE, шкала 5-100): ${mae(vErr)}  (n=${vErr.length})`);
  console.log(`DIFF: средняя ошибка (MAE, шкала 5-100): ${mae(dErr)}  (n=${dErr.length})`);

  if (signalsOut) {
    const payload = {
      platform: input.platform,
      appId: input.appId,
      country,
      rows: res.map((o) => ({
        term: o.term,
        fox: { rank: o.foxR ?? null, volume: o.foxV ?? null, difficulty: o.foxD ?? null },
        scraper: { rank: o.sR, volume: o.sV, difficulty: o.sD, depth: o.depth },
        volumeSignals: o.volumeSignals ?? null,
        lengthPenalty: o.lengthPenalty ?? 1,
        difficultySignals: o.difficultySignals ?? null,
      })),
    };
    writeFileSync(signalsOut, JSON.stringify(payload, null, 2));
    console.log(`\nСигналы сохранены → ${signalsOut} (для src/calibrateWeights.ts)`);
  }
})();
