import { recheckAll } from './recheck.js';
import { sendDigests } from './digest.js';
import { pool } from '../db/pool.js';

const RECHECK_MS = 3 * 60 * 60 * 1000; // каждые 3 часа

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

async function main(): Promise<void> {
  await cycle();
  setInterval(() => { void cycle(); }, RECHECK_MS);
}

main().catch(async (err) => {
  console.error('scheduler failed:', err);
  await pool.end();
  process.exit(1);
});
