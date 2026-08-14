import { query } from './pool.js';
import type { AppInfo } from '../scrapers/appstore.js';

export interface KeywordRow {
  id: number;
  term: string;
  country: string;
  tracked: boolean;
}

/** Upsert приложения по метаданным из скрейпера. */
export async function upsertApp(app: AppInfo, tracked = false): Promise<void> {
  await query(
    `INSERT INTO apps (app_id, bundle_id, title, developer, developer_id,
       primary_genre, primary_genre_id, icon, rating, rating_count, country, tracked, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (app_id) DO UPDATE SET
       bundle_id=EXCLUDED.bundle_id, title=EXCLUDED.title, developer=EXCLUDED.developer,
       developer_id=EXCLUDED.developer_id, primary_genre=EXCLUDED.primary_genre,
       primary_genre_id=EXCLUDED.primary_genre_id, icon=EXCLUDED.icon,
       rating=EXCLUDED.rating, rating_count=EXCLUDED.rating_count,
       tracked=apps.tracked OR EXCLUDED.tracked, updated_at=now()`,
    [
      app.appId, app.bundleId, app.title, app.developer, app.developerId,
      app.primaryGenre, app.primaryGenreId, app.icon, app.rating, app.ratingCount,
      'us', tracked,
    ],
  );
}

/** Получить (или создать) ключевое слово. */
export async function upsertKeyword(
  term: string,
  country: string,
  tracked = false,
): Promise<KeywordRow> {
  const rows = await query<KeywordRow>(
    `INSERT INTO keywords (term, country, tracked) VALUES ($1,$2,$3)
     ON CONFLICT (term, country) DO UPDATE SET tracked=keywords.tracked OR EXCLUDED.tracked
     RETURNING id, term, country, tracked`,
    [term.toLowerCase().trim(), country, tracked],
  );
  return rows[0]!;
}

export async function linkAppKeyword(appId: number, keywordId: number): Promise<void> {
  await query(
    `INSERT INTO app_keywords (app_id, keyword_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [appId, keywordId],
  );
}

export async function saveRankSnapshot(
  appId: number,
  keywordId: number,
  rank: number | null,
  total: number,
): Promise<void> {
  await query(
    `INSERT INTO rank_snapshots (app_id, keyword_id, rank, total_results)
     VALUES ($1,$2,$3,$4)`,
    [appId, keywordId, rank, total],
  );
}

export async function saveChartSnapshot(
  appId: number,
  chartType: string,
  country: string,
  genreId: number | null,
  position: number | null,
): Promise<void> {
  await query(
    `INSERT INTO chart_snapshots (app_id, chart_type, country, genre_id, position)
     VALUES ($1,$2,$3,$4,$5)`,
    [appId, chartType, country, genreId, position],
  );
}

export interface MetricCheck {
  platform: string;
  appId: string;
  appTitle: string;
  term: string;
  country: string;
  language: string | null;
  rank: number | null;
  totalResults: number;
  volume: number;
  difficulty: number;
}

/** Сохранить проверку «приложение + ключ» в историю (для графиков). */
export async function saveMetricCheck(m: MetricCheck): Promise<void> {
  await query(
    `INSERT INTO metric_checks
       (platform, app_id, app_title, term, country, language,
        rank, total_results, volume, difficulty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      m.platform, m.appId, m.appTitle, m.term, m.country, m.language,
      m.rank, m.totalResults, m.volume, m.difficulty,
    ],
  );
}

/**
 * Батч-вставка снимков по списку ключей одного приложения.
 * Один INSERT-запрос вместо N — нужно для discovery (200–300 ключей за раз).
 */
export async function saveMetricCheckBatch(
  meta: { platform: string; appId: string; appTitle: string; country: string; language: string | null },
  keywords: { term: string; rank: number | null; totalResults: number; volume: number; difficulty: number }[],
): Promise<void> {
  if (keywords.length === 0) return;
  // UNNEST на массивах: быстрее и читабельнее, чем 300 плейсхолдеров вручную.
  await query(
    `INSERT INTO metric_checks
       (platform, app_id, app_title, term, country, language,
        rank, total_results, volume, difficulty)
     SELECT $1, $2, $3, t.term, $4, $5, t.rank, t.total_results, t.volume, t.difficulty
     FROM UNNEST(
       $6::text[], $7::int[], $8::int[], $9::int[], $10::int[]
     ) AS t(term, rank, total_results, volume, difficulty)`,
    [
      meta.platform, meta.appId, meta.appTitle, meta.country, meta.language,
      keywords.map((k) => k.term),
      keywords.map((k) => k.rank),
      keywords.map((k) => k.totalResults),
      keywords.map((k) => k.volume),
      keywords.map((k) => k.difficulty),
    ],
  );
}

/** Уникальные связки «приложение + ключ», которые уже проверялись — для автозамера. */
export async function distinctMetricTargets(): Promise<
  {
    platform: string;
    appId: string;
    appTitle: string;
    term: string;
    country: string;
    language: string | null;
  }[]
> {
  return query(
    `SELECT DISTINCT platform, app_id AS "appId", app_title AS "appTitle",
            term, country, language
     FROM metric_checks`,
  );
}

/** История проверок по связке «приложение + ключ» во времени. */
export async function getMetricHistory(
  platform: string,
  appId: string,
  term: string,
  country: string,
): Promise<
  { rank: number | null; totalResults: number; volume: number; capturedAt: string }[]
> {
  return query(
    `SELECT rank, total_results AS "totalResults", volume,
            captured_at AS "capturedAt"
     FROM metric_checks
     WHERE platform = $1 AND app_id = $2 AND term = $3 AND country = $4
     ORDER BY captured_at`,
    [platform, appId, term.toLowerCase().trim(), country],
  );
}

export async function saveVolumeEstimate(
  keywordId: number,
  score: number,
  source: string,
  totalResults: number | null,
): Promise<void> {
  await query(
    `INSERT INTO volume_estimates (keyword_id, score, source, total_results)
     VALUES ($1,$2,$3,$4)`,
    [keywordId, score, source, totalResults],
  );
}

/** Пары (приложение, ключ) для ежедневного сбора rank. */
export async function trackedAppKeywords(): Promise<
  { appId: number; keywordId: number; term: string; country: string }[]
> {
  return query(
    `SELECT ak.app_id AS "appId", ak.keyword_id AS "keywordId", k.term, k.country
     FROM app_keywords ak JOIN keywords k ON k.id = ak.keyword_id`,
  );
}

export async function trackedApps(): Promise<{ appId: number; genreId: number }[]> {
  return query(
    `SELECT app_id AS "appId", primary_genre_id AS "genreId" FROM apps WHERE tracked = TRUE`,
  );
}

export async function trackedKeywords(): Promise<KeywordRow[]> {
  return query<KeywordRow>(
    `SELECT id, term, country, tracked FROM keywords WHERE tracked = TRUE`,
  );
}

// --- Фоновые задачи подбора ключей --------------------------------------

export interface DiscoveryJobRow {
  id: number;
  jobKey: string;
  platform: string;
  appId: string;
  appTitle: string | null;
  country: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  processed: number;
  keywords: unknown[];
  error: string | null;
  updatedAt: string;
}

const JOB_COLS = `id, job_key AS "jobKey", platform, app_id AS "appId",
  app_title AS "appTitle", country, status, total, processed, keywords,
  error, updated_at AS "updatedAt"`;

export async function createDiscoveryJob(
  jobKey: string, platform: string, appId: string, country: string,
): Promise<DiscoveryJobRow> {
  const rows = await query<DiscoveryJobRow>(
    `INSERT INTO discovery_jobs (job_key, platform, app_id, country)
     VALUES ($1, $2, $3, $4) RETURNING ${JOB_COLS}`,
    [jobKey, platform, appId, country],
  );
  return rows[0];
}

export async function getDiscoveryJob(id: number): Promise<DiscoveryJobRow | null> {
  const rows = await query<DiscoveryJobRow>(
    `SELECT ${JOB_COLS} FROM discovery_jobs WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

/**
 * Лёгкая версия для polling: без колонки `keywords` (JSONB может быть
 * тяжёлым — до 1000 элементов). Не нагружает БД на каждом 3-секундном
 * опросе popup'а.
 */
export interface DiscoveryJobStateLite {
  id: number;
  jobKey: string;
  platform: string;
  appId: string;
  appTitle: string | null;
  country: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  processed: number;
  error: string | null;
  updatedAt: string;
}

const JOB_COLS_LITE = `id, job_key AS "jobKey", platform, app_id AS "appId",
  app_title AS "appTitle", country, status, total, processed, error,
  updated_at AS "updatedAt"`;

export async function getDiscoveryJobLite(
  id: number,
): Promise<DiscoveryJobStateLite | null> {
  const rows = await query<DiscoveryJobStateLite>(
    `SELECT ${JOB_COLS_LITE} FROM discovery_jobs WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

export async function latestDiscoveryJob(jobKey: string): Promise<DiscoveryJobRow | null> {
  const rows = await query<DiscoveryJobRow>(
    `SELECT ${JOB_COLS} FROM discovery_jobs WHERE job_key = $1
     ORDER BY created_at DESC LIMIT 1`, [jobKey],
  );
  return rows[0] ?? null;
}

export async function updateDiscoveryJob(
  id: number,
  fields: Partial<{
    appTitle: string; status: string; total: number;
    processed: number; keywords: unknown[]; error: string;
  }>,
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const map: Record<string, string> = {
    appTitle: 'app_title', status: 'status', total: 'total',
    processed: 'processed', keywords: 'keywords', error: 'error',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) {
      params.push(k === 'keywords' ? JSON.stringify((fields as Record<string, unknown>)[k]) : (fields as Record<string, unknown>)[k]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  params.push(id);
  await query(`UPDATE discovery_jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

/**
 * Помечает зависшие задачи как error. Джоб, прерванный рестартом/крэшем
 * процесса, умирает до кода смены статуса и навсегда остаётся 'running' —
 * мешает кэш-логике и засоряет состояние. Вызывается при старте сервера.
 */
export async function failStaleDiscoveryJobs(olderThanMinutes = 5): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE discovery_jobs
       SET status = 'error', error = 'interrupted (process restart)', updated_at = now()
     WHERE status IN ('running', 'pending')
       AND updated_at < now() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(olderThanMinutes)],
  );
  return rows.length;
}

/** Последняя завершённая задача подбора по каждому приложению. */
export async function allDoneDiscoveryJobs(): Promise<DiscoveryJobRow[]> {
  return query<DiscoveryJobRow>(
    `SELECT DISTINCT ON (job_key) ${JOB_COLS}
     FROM discovery_jobs WHERE status = 'done'
     ORDER BY job_key, created_at DESC`,
  );
}

// --- Кэш выдачи по ключу (общий для всех задач, переживает рестарт) ----

export interface KeywordCacheRow {
  ids: string[];
  totalResults: number;
  volume: number;
  difficulty: number;
}

/** Свежая (моложе ttl часов) запись кэша или null. */
export async function getCachedKeyword(
  platform: string, country: string, term: string, ttlHours = 6,
): Promise<KeywordCacheRow | null> {
  const rows = await query<KeywordCacheRow>(
    `SELECT ids, total_results AS "totalResults", volume, difficulty
     FROM keyword_cache
     WHERE platform = $1 AND country = $2 AND term = $3
       AND captured_at > now() - ($4 || ' hours')::interval`,
    [platform, country, term, String(ttlHours)],
  );
  return rows[0] ?? null;
}

export async function upsertCachedKeyword(
  platform: string, country: string, term: string, data: KeywordCacheRow,
): Promise<void> {
  await query(
    `INSERT INTO keyword_cache
       (platform, country, term, ids, total_results, volume, difficulty, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (platform, country, term) DO UPDATE SET
       ids = EXCLUDED.ids,
       total_results = EXCLUDED.total_results,
       volume = EXCLUDED.volume,
       difficulty = EXCLUDED.difficulty,
       captured_at = now()`,
    [platform, country, term, JSON.stringify(data.ids),
     data.totalResults, data.volume, data.difficulty],
  );
}

/**
 * Батч-запись SERP-снимков (только выдача, без volume/difficulty).
 *
 * Discovery по приложению считает спрос от СВОЕГО автокомплит-сигнала, а
 * сложность не считает вовсе — записывать эти значения в общий кэш нельзя,
 * их прочитает discoverByUrl и выдаст чужие цифры за свои. Поэтому апдейт
 * трогает только ids/total_results/captured_at, а на вставке кладёт нули:
 * читатели, которым нужны метрики, считают такую строку промахом
 * (см. cachedKeyword в discoverByUrl.ts), а тем, кому нужна только выдача
 * (serpTermsContainingApp, замер ранка), строка полезна как есть.
 */
export async function upsertCachedSerpBatch(
  platform: string,
  country: string,
  rows: { term: string; ids: string[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  await query(
    `INSERT INTO keyword_cache
       (platform, country, term, ids, total_results, volume, difficulty, captured_at)
     SELECT $1, $2, t.term, t.ids::jsonb, jsonb_array_length(t.ids::jsonb), 0, 0, now()
     FROM UNNEST($3::text[], $4::text[]) AS t(term, ids)
     ON CONFLICT (platform, country, term) DO UPDATE SET
       ids = EXCLUDED.ids,
       total_results = EXCLUDED.total_results,
       captured_at = now()`,
    [
      platform, country,
      rows.map((r) => r.term),
      rows.map((r) => JSON.stringify(r.ids)),
    ],
  );
}

// --- Снимок подбора по приложению ----------------------------------------

export interface DiscoverySnapshotRow<T = unknown> {
  appTitle: string;
  keywords: T[];
  capturedAt: Date;
}

export async function getDiscoverySnapshot<T = unknown>(
  platform: string, appId: string, country: string,
): Promise<DiscoverySnapshotRow<T> | null> {
  const rows = await query<DiscoverySnapshotRow<T>>(
    `SELECT app_title AS "appTitle", keywords, captured_at AS "capturedAt"
     FROM app_discovery_snapshots
     WHERE platform = $1 AND app_id = $2 AND country = $3`,
    [platform, appId, country],
  );
  return rows[0] ?? null;
}

export async function saveDiscoverySnapshot(
  platform: string, appId: string, country: string,
  appTitle: string, keywords: unknown[],
): Promise<void> {
  await query(
    `INSERT INTO app_discovery_snapshots
       (platform, app_id, country, app_title, keywords, captured_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (platform, app_id, country) DO UPDATE SET
       app_title = EXCLUDED.app_title,
       keywords = EXCLUDED.keywords,
       captured_at = now()`,
    [platform, appId, country, appTitle, JSON.stringify(keywords)],
  );
}

// --- Кэш автокомплита (префикс -> подсказки) ------------------------------

/** Свежие (моложе ttl часов) подсказки по префиксам. Ключ карты — префикс. */
export async function getCachedSuggests(
  platform: string, country: string, terms: string[], ttlHours = 24,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (terms.length === 0) return out;
  const rows = await query<{ term: string; hints: string[] }>(
    `SELECT term, hints FROM suggest_cache
     WHERE platform = $1 AND country = $2 AND term = ANY($3::text[])
       AND captured_at > now() - ($4 || ' hours')::interval`,
    [platform, country, terms, String(ttlHours)],
  );
  for (const r of rows) out.set(r.term, r.hints);
  return out;
}

export async function upsertCachedSuggestBatch(
  platform: string,
  country: string,
  rows: { term: string; hints: string[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  await query(
    `INSERT INTO suggest_cache (platform, country, term, hints, captured_at)
     SELECT $1, $2, t.term, t.hints::jsonb, now()
     FROM UNNEST($3::text[], $4::text[]) AS t(term, hints)
     ON CONFLICT (platform, country, term) DO UPDATE SET
       hints = EXCLUDED.hints,
       captured_at = now()`,
    [
      platform, country,
      rows.map((r) => r.term),
      rows.map((r) => JSON.stringify(r.hints)),
    ],
  );
}

/** Постоянный словарь «кандидатных ключей» для приложения в стране. */
export async function getAppCandidateKeywords(
  platform: string, appId: string, country: string,
): Promise<string[]> {
  const rows = await query<{ term: string }>(
    `SELECT term FROM app_candidate_keywords
     WHERE platform = $1 AND app_id = $2 AND country = $3`,
    [platform, appId, country],
  );
  return rows.map((r) => r.term);
}

export async function saveAppCandidateKeywords(
  platform: string, appId: string, country: string, terms: string[],
): Promise<void> {
  if (terms.length === 0) return;
  // Один батч-INSERT с UNNEST: быстрее и удобнее, чем цикл.
  await query(
    `INSERT INTO app_candidate_keywords (platform, app_id, country, term)
     SELECT $1, $2, $3, t
     FROM UNNEST($4::text[]) AS t
     ON CONFLICT (platform, app_id, country, term)
     DO UPDATE SET last_seen_at = now()`,
    [platform, appId, country, terms],
  );
}

// --- Накопительный корпус ключей по гео (словарь в стиле FoxData) -------

/** Батч-запись термов в корпус гео. Термы нормализуются к lower/trim. */
export async function addCorpusTerms(
  platform: string, country: string, terms: string[], source = 'discovery',
): Promise<void> {
  const clean = [...new Set(
    terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3 && t.length <= 60),
  )];
  if (clean.length === 0) return;
  await query(
    `INSERT INTO keyword_corpus (platform, country, term, source)
     SELECT $1, $2, t, $4
     FROM UNNEST($3::text[]) AS t
     ON CONFLICT (platform, country, term)
     DO UPDATE SET last_seen_at = now()`,
    [platform, country, clean, source],
  );
}

/**
 * Термы корпуса гео, пересекающиеся хотя бы одним токеном с лексикой
 * приложения (название/жанр/описание/ниша). Это «проверябельная» часть
 * корпуса для чужого приложения: полный корпус мерить бессмысленно и дорого.
 */
export async function corpusTermsMatching(
  platform: string, country: string, tokens: string[], limit: number,
): Promise<string[]> {
  if (tokens.length === 0 || limit <= 0) return [];
  const rows = await query<{ term: string }>(
    `SELECT term FROM keyword_corpus
     WHERE platform = $1 AND country = $2
       AND string_to_array(term, ' ') && $3::text[]
     ORDER BY last_seen_at DESC
     LIMIT $4`,
    [platform, country, tokens, limit],
  );
  return rows.map((r) => r.term);
}

export interface SerpHitRow extends KeywordCacheRow {
  term: string;
  /** Свежесть снимка выдачи в часах — решает, можно ли верить ранку без перезамера. */
  ageHours: number;
}

/**
 * Ключи, в чьих закэшированных выдачах уже встречается приложение, — самый
 * дешёвый источник индексации: эти выдачи собраны при анализе ДРУГИХ
 * приложений, и попадание в них почти гарантирует ранжирование сейчас.
 * Требует GIN-индекса idx_keyword_cache_ids (jsonb @> по массиву).
 */
export async function serpTermsContainingApp(
  platform: string, country: string, appId: string, limit: number,
): Promise<SerpHitRow[]> {
  if (limit <= 0) return [];
  return query<SerpHitRow>(
    `SELECT term, ids, total_results AS "totalResults", volume, difficulty,
            EXTRACT(EPOCH FROM (now() - captured_at)) / 3600 AS "ageHours"
     FROM keyword_cache
     WHERE platform = $1 AND country = $2 AND ids @> $3::jsonb
     ORDER BY captured_at DESC
     LIMIT $4`,
    [platform, country, JSON.stringify(appId), limit],
  );
}
