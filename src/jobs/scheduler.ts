import { collectAll } from './collect.js';
import { pool } from '../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Простой планировщик: запускает полный сбор сразу и далее раз в сутки.
 * Для продакшена можно заменить на cron или очередь задач.
 */
async function main(): Promise<void> {
  await collectAll().catch((e) => console.error('collect failed:', e));
  setInterval(() => {
    collectAll().catch((e) => console.error('collect failed:', e));
  }, DAY_MS);
}

main().catch(async (err) => {
  console.error('scheduler failed:', err);
  await pool.end();
  process.exit(1);
});
