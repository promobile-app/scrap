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
