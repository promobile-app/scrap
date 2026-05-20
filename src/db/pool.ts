import pg from 'pg';
import { config } from '../config.js';

// BIGINT (OID 20) по умолчанию возвращается строкой — App ID помещаются
// в безопасный диапазон чисел JS, поэтому парсим их как number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 25,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}
