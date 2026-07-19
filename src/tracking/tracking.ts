// Трекинг позиций — retention-ядро подписки.
//
// Пользователь «отслеживает» приложение → в tracked_apps фиксируется набор
// топ-ключей (по volume из последнего готового discovery). Scheduler и так
// переснимает все связки из metric_checks каждые 3 часа; отслеживаемые пары
// добавляются в его цели явно (recheck.ts), поэтому история копится даже если
// приложение больше никто не анализирует вручную. Поверх истории считаются
// «значимые изменения» (движение ≥ порога, вход/выход из топ-10, появление/
// пропажа из выдачи) — их показывает вкладка Tracking и шлёт email-дайджест.
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { latestDiscoveryJob } from '../db/repo.js';

export interface TrackedApp {
  id: number;
  userId: number;
  platform: string;
  appId: string;
  appTitle: string | null;
  country: string;
  terms: string[];
  alertsEnabled: boolean;
  lastDigestAt: string | null;
  createdAt: string;
}

const COLS = `id, user_id AS "userId", platform, app_id AS "appId",
  app_title AS "appTitle", country, terms, alerts_enabled AS "alertsEnabled",
  last_digest_at AS "lastDigestAt", created_at AS "createdAt"`;

interface JobKeyword {
  term: string;
  rank: number | null;
  volume?: number | null;
}

/**
 * Начать отслеживание приложения. Ключи берём из последнего готового
 * discovery-прогона: ранжированные, отсортированные по volume, до termsLimit.
 * Если анализа ещё не было — кидаем ошибку (сначала «Analyze»).
 */
export async function trackApp(
  userId: number,
  platform: string,
  appId: string,
  country: string,
): Promise<TrackedApp> {
  const job = await latestDiscoveryJob(`${platform}|${appId}|${country}`);
  if (!job || job.status !== 'done') {
    throw new Error('run analysis first');
  }
  const kws = (job.keywords as JobKeyword[])
    .filter((k) => k.rank != null)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, config.tracking.termsLimit)
    .map((k) => k.term);
  if (kws.length === 0) throw new Error('no ranked keywords to track');

  const rows = await query<TrackedApp>(
    `INSERT INTO tracked_apps (user_id, platform, app_id, app_title, country, terms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, platform, app_id, country) DO UPDATE SET
       app_title = EXCLUDED.app_title,
       terms = EXCLUDED.terms,
       alerts_enabled = TRUE
     RETURNING ${COLS}`,
    [userId, platform, appId, job.appTitle, country, JSON.stringify(kws)],
  );
  return rows[0]!;
}

export async function untrackApp(userId: number, id: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    'DELETE FROM tracked_apps WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return rows.length > 0;
}

export async function listTrackedApps(userId: number): Promise<TrackedApp[]> {
  return query<TrackedApp>(
    `SELECT ${COLS} FROM tracked_apps WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getTrackedApp(userId: number, id: number): Promise<TrackedApp | null> {
  const rows = await query<TrackedApp>(
    `SELECT ${COLS} FROM tracked_apps WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Отслеживает ли пользователь это приложение (для кнопки в отчёте). */
export async function findTracked(
  userId: number,
  platform: string,
  appId: string,
  country: string,
): Promise<TrackedApp | null> {
  const rows = await query<TrackedApp>(
    `SELECT ${COLS} FROM tracked_apps
     WHERE user_id = $1 AND platform = $2 AND app_id = $3 AND country = $4`,
    [userId, platform, appId, country],
  );
  return rows[0] ?? null;
}

/** Все уникальные пары (платформа, приложение, ключ) из отслеживания — для recheck. */
export async function trackedRecheckTargets(): Promise<
  { platform: string; appId: string; appTitle: string; term: string; country: string; language: string | null }[]
> {
  return query(
    `SELECT DISTINCT t.platform, t.app_id AS "appId",
            COALESCE(t.app_title, t.app_id) AS "appTitle",
            kw.term, t.country, NULL::text AS language
     FROM tracked_apps t, jsonb_array_elements_text(t.terms) AS kw(term)`,
  );
}

// --- Изменения позиций -------------------------------------------------------

export interface TermChange {
  term: string;
  currRank: number | null;
  prevRank: number | null;
  /** prevRank - currRank: >0 — рост (позиция уменьшилась), <0 — падение. */
  delta: number | null;
  enteredTop10: boolean;
  leftTop10: boolean;
  /** Значимое ли движение (порог + пересечения топ-10 + появление/пропажа). */
  significant: boolean;
}

/**
 * Изменения по ключам приложения за окно sinceHours: последний замер против
 * последнего замера старше окна. Если истории до окна нет — сравнивать не с
 * чем, и такие строки значимыми не считаются.
 */
export async function computeChanges(
  platform: string,
  appId: string,
  country: string,
  terms: string[],
  sinceHours = 24,
): Promise<TermChange[]> {
  if (terms.length === 0) return [];
  const rows = await query<{ term: string; curr_rank: number | null; prev_rank: number | null; has_prev: boolean }>(
    `WITH latest AS (
       SELECT DISTINCT ON (term) term, rank
       FROM metric_checks
       WHERE platform = $1 AND app_id = $2 AND country = $3 AND term = ANY($4::text[])
       ORDER BY term, captured_at DESC
     ),
     prev AS (
       SELECT DISTINCT ON (term) term, rank
       FROM metric_checks
       WHERE platform = $1 AND app_id = $2 AND country = $3 AND term = ANY($4::text[])
         AND captured_at < now() - ($5 || ' hours')::interval
       ORDER BY term, captured_at DESC
     )
     SELECT l.term, l.rank AS curr_rank, p.rank AS prev_rank,
            (p.term IS NOT NULL) AS has_prev
     FROM latest l LEFT JOIN prev p ON p.term = l.term`,
    [platform, appId, country, terms, String(sinceHours)],
  );

  const threshold = config.tracking.rankDelta;
  return rows.map((r) => {
    const curr = r.curr_rank;
    const prev = r.has_prev ? r.prev_rank : null;
    const delta = curr != null && prev != null ? prev - curr : null;
    const enteredTop10 = curr != null && curr <= 10 && (prev == null || prev > 10) && r.has_prev;
    const leftTop10 = prev != null && prev <= 10 && (curr == null || curr > 10);
    const appeared = r.has_prev && prev == null && curr != null;
    const disappeared = r.has_prev && prev != null && curr == null;
    const significant =
      enteredTop10 || leftTop10 || appeared || disappeared ||
      (delta != null && Math.abs(delta) >= threshold);
    return { term: r.term, currRank: curr, prevRank: prev, delta, enteredTop10, leftTop10, significant };
  });
}

/** Серии для спарклайнов: по каждому ключу последние points замеров rank. */
export async function rankSeries(
  platform: string,
  appId: string,
  country: string,
  terms: string[],
  points = 20,
): Promise<Record<string, Array<{ rank: number | null; at: string }>>> {
  if (terms.length === 0) return {};
  const rows = await query<{ term: string; rank: number | null; captured_at: string }>(
    `SELECT term, rank, captured_at
     FROM (
       SELECT term, rank, captured_at,
              row_number() OVER (PARTITION BY term ORDER BY captured_at DESC) AS rn
       FROM metric_checks
       WHERE platform = $1 AND app_id = $2 AND country = $3 AND term = ANY($4::text[])
     ) x
     WHERE rn <= $5
     ORDER BY term, captured_at`,
    [platform, appId, country, terms, points],
  );
  const out: Record<string, Array<{ rank: number | null; at: string }>> = {};
  for (const r of rows) {
    (out[r.term] ??= []).push({ rank: r.rank, at: r.captured_at });
  }
  return out;
}

/** Выключить алерты пользователю (unsubscribe-ссылка из письма). */
export async function disableAlerts(userId: number): Promise<void> {
  await query('UPDATE tracked_apps SET alerts_enabled = FALSE WHERE user_id = $1', [userId]);
}
