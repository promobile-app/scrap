import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Миграция применена.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Ошибка миграции:', err);
  process.exit(1);
});
