import { recheckAll } from './recheck.js';
import { sendDigests } from './digest.js';
import { seedGeoCorpus } from '../analytics/corpusSeeder.js';
import { pool } from '../db/pool.js';

const RECHECK_MS = 3 * 60 * 60 * 1000; // каждые 3 часа

// Затравка словаря по витринам. Пустой список = выключено: задача надолго
// занимает пул каналов, и включать её надо осознанно, под конкретные гео.
const SEED_COUNTRIES = (process.env.CORPUS_SEED_COUNTRIES ?? '')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
const SEED_INTERVAL_MS = Number(process.env.CORPUS_SEED_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
let seedCursor = 0;

/**
 * Планировщик автозамеров: переснимает все проверявшиеся связки
 * «приложение + ключ» сразу при старте и далее каждые 3 часа,
 * накапливая историю для графиков. После каждого прохода — email-дайджест
 * значимых изменений по отслеживаемым приложениям (не чаще раза в
 * digestMinHours на пользователя — троттлинг внутри sendDigests).
 */
async function cycle(): Promise<void> {
  await recheckAll().catch((e) => console.error('recheck failed:', e));
  await sendDigests().catch((e) => console.error('digest failed:', e));
}

/**
 * Затравка словаря — по одной витрине за тик, по кругу. Не пачкой: две
 * витрины одновременно поделят между собой ту же пропускную способность и
 * только добавят риск 429, а растянутый по времени обход даёт тот же охват.
 */
async function seedCycle(): Promise<void> {
  if (SEED_COUNTRIES.length === 0) return;
  const country = SEED_COUNTRIES[seedCursor % SEED_COUNTRIES.length]!;
  seedCursor++;
  await seedGeoCorpus(country).catch((e) => console.error('seed failed:', e));
}

async function main(): Promise<void> {
  await cycle();
  setInterval(() => { void cycle(); }, RECHECK_MS);

  if (SEED_COUNTRIES.length) {
    console.log(
      `[seed] расписание: ${SEED_COUNTRIES.join(', ')} — по одной витрине каждые ` +
      `${Math.round(SEED_INTERVAL_MS / 60000)} мин`,
    );
    // Первый прогон — не на старте: при деплое сначала должен подняться и
    // прогреться основной трафик, а не тысячи фоновых запросов к магазину.
    setInterval(() => { void seedCycle(); }, SEED_INTERVAL_MS);
  }
}

main().catch(async (err) => {
  console.error('scheduler failed:', err);
  await pool.end();
  process.exit(1);
});
