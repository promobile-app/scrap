import { recheckAll } from './recheck.js';
import { pool } from '../db/pool.js';

const RECHECK_MS = 3 * 60 * 60 * 1000; // каждые 3 часа

/**
 * Планировщик автозамеров: переснимает все проверявшиеся связки
 * «приложение + ключ» сразу при старте и далее каждые 3 часа,
 * накапливая историю для графиков.
 */
async function main(): Promise<void> {
  await recheckAll().catch((e) => console.error('recheck failed:', e));
  setInterval(() => {
    recheckAll().catch((e) => console.error('recheck failed:', e));
  }, RECHECK_MS);
}

main().catch(async (err) => {
  console.error('scheduler failed:', err);
  await pool.end();
  process.exit(1);
});
