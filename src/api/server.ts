import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { appLookup, searchApps, getRank, lookupApps } from '../scrapers/appstore.js';
import { nativeSearchIds, storeLanguages, getNativePoolStats } from '../scrapers/native.js';
import { getHttpPoolStats } from '../scrapers/http.js';
import { proxyCount, proxyEnabled } from '../scrapers/proxy.js';
import { gpSearch, gpAppLookup, gpTopChart, langOf } from '../scrapers/googleplay.js';
import { gpRpcSearch } from '../scrapers/gplayRpc.js';
import { finskyDetails } from '../scrapers/finsky/details.js';
import { finskyConfigured, finskySession } from '../scrapers/finsky/session.js';
import { gpEstimateVolume } from '../analytics/googleplay/volume.js';
import { gpEstimateDifficulty } from '../analytics/googleplay/difficulty.js';
import { topChart } from '../scrapers/charts.js';
import { estimateVolume, getAsaSourceStatus } from '../analytics/appstore/volume.js';
import { estimateDifficulty } from '../analytics/appstore/difficulty.js';
import { discoverKeywordsCached } from '../analytics/discoveryCache.js';
import {
  lastSeedReport, seedGeoCorpus, seedInProgress,
} from '../analytics/corpusSeeder.js';
import {
  startDiscoveryJob, getDiscoveryJobState, saturationFromResults, type UrlKeyword,
} from '../analytics/discoverByUrl.js';
import { feedCorpus } from '../analytics/corpus.js';
import {
  upsertApp, upsertKeyword, linkAppKeyword,
  saveMetricCheck, getMetricHistory, distinctMetricTargets,
  allDoneDiscoveryJobs, failStaleDiscoveryJobs,
} from '../db/repo.js';
import { registerExtensionRoutes } from './extensionRoutes.js';

/** Экранирование значения для CSV. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Разделитель «;» — корректно открывается двойным кликом в Excel
// (в т.ч. русская локаль) и автоопределяется при импорте в Google Sheets.
const CSV_SEP = ';';

/** Строка CSV из ячеек. */
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(CSV_SEP);
}

/** Сборка CSV с BOM (чтобы Excel корректно читал кириллицу). */
function buildCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [csvRow(header), ...rows.map(csvRow)].join('\r\n');
}

const app = Fastify({ logger: true });

// CORS: дашборд может открываться с другого origin (панель предпросмотра).
await app.register(fastifyCors, { origin: true });

// Rate limiting: API публичный на Railway — без лимитов один клиент может
// выесть скрейп-бюджет (и подставить IP под бан Apple). Ключ — по
// пользователю (Bearer), для анонимов — по IP. Отдельные, более жёсткие
// лимиты на auth-маршрутах — от брутфорса паролей (см. extensionRoutes).
await app.register(fastifyRateLimit, {
  global: true,
  max: 240,                    // 240 запросов/мин достаточно для UI + поллинга
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    return auth && auth.startsWith('Bearer ') ? auth.slice(7, 47) : req.ip;
  },
  allowList: (req) => req.url === '/health',
});

// Статика дашборда (public/ в корне проекта).
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// cacheControl выключен — дашборд всегда отдаётся свежим (без устаревшего кеша).
await app.register(fastifyStatic, {
  root: join(projectRoot, 'public'),
  cacheControl: false,
});

// --- Приложение -------------------------------------------------------------

// Поиск приложений по названию (для выбора приложения в дашборде).
app.get<{ Querystring: { q: string; country?: string; platform?: string } }>(
  '/apps/search',
  async (req, reply) => {
    if (!req.query.q) return reply.code(400).send({ error: 'q required' });
    const country = req.query.country ?? config.defaultCountry;
    if (req.query.platform === 'android') {
      const results = await gpSearch(req.query.q, country, 15);
      return results.map((a) => ({
        appId: a.appId,
        title: a.title,
        developer: a.developer,
        icon: a.icon,
      }));
    }
    const results = await searchApps(req.query.q, country, 15);
    return results.map((a) => ({
      appId: a.appId,
      title: a.title,
      developer: a.developer,
      icon: a.icon,
    }));
  },
);

// Метрики связки «приложение + гео + конкретный ключ».
app.get<{
  Params: { id: string };
  Querystring: { term: string; country?: string; language?: string; platform?: string };
}>('/apps/:id/metrics', async (req, reply) => {
    const term = req.query.term;
    if (!term) return reply.code(400).send({ error: 'term required' });
    const country = req.query.country ?? config.defaultCountry;
    const language = req.query.language;

    // --- Google Play ---
    // Ранг считается по выдаче из batchexecute-RPC витрины (230-250 позиций,
    // scrapers/gplayRpc.ts), а не по HTML-странице: та отдаёт ~20-30 и делала
    // rank=null почти для всех неочевидных ключей. gpSearch остаётся ради
    // названий приложений для topApps (RPC отдаёт только имена пакетов) и как
    // запасной источник ранга, если RPC недоступен.
    if (req.query.platform === 'android') {
      const gpId = req.params.id;
      const [gApp, gpResults, gRpc, gVolume, gDifficulty] = await Promise.all([
        gpAppLookup(gpId, country),
        gpSearch(term, country, 30),
        gpRpcSearch(term, country, { language: langOf(country), maxPages: 15 }).catch((e: unknown) => {
          console.warn(`[gp/rank] RPC недоступен, откат на HTML-выдачу: ${e instanceof Error ? e.message : e}`);
          return null;
        }),
        gpEstimateVolume(term, country),
        gpEstimateDifficulty(term, country),
      ]);
      if (!gApp) return reply.code(404).send({ error: 'app not found' });

      const rpcNames = gRpc?.packageNames ?? [];
      const rankSource = rpcNames.length > 0 ? 'rpc' : 'html';
      const ranked = rpcNames.length > 0 ? rpcNames : gpResults.map((a) => a.appId);
      const gIdx = ranked.indexOf(gpId);
      const gRank = gIdx === -1 ? null : gIdx + 1;
      const titleOf = new Map(gpResults.map((a) => [a.appId, a.title]));

      await saveMetricCheck({
        platform: 'android', appId: gpId, appTitle: gApp.title,
        term: term.toLowerCase().trim(), country, language: null,
        rank: gRank, totalResults: ranked.length,
        volume: gVolume.score, difficulty: gDifficulty.score,
      }).catch(() => {});
      return {
        app: { appId: gApp.appId, title: gApp.title, developer: gApp.developer, icon: gApp.icon },
        term,
        country,
        platform: 'android',
        rank: gRank,
        inTop10: gIdx !== -1 && gIdx < 10,
        totalResults: ranked.length,
        // Источник ранга: 'rpc' — глубина ~250, 'html' — деградация до ~20-30.
        // Клиент по нему отличает «нет в выдаче» от «не смотрели так глубоко».
        rankSource,
        volume: gVolume,
        difficulty: { score: gDifficulty.score, competitors: gDifficulty.competitors },
        topApps: ranked.slice(0, 10).map((appId, i) => ({
          position: i + 1,
          appId,
          title: titleOf.get(appId) ?? '',
          isTarget: appId === gpId,
        })),
      };
    }

    // --- App Store ---
    const appId = Number(req.params.id);
    const [app, ids, volume, difficulty] = await Promise.all([
      appLookup(appId, country),
      nativeSearchIds(term, country, language),
      estimateVolume(term, country),
      estimateDifficulty(term, country),
    ]);
    if (!app) return reply.code(404).send({ error: 'app not found' });

    const idx = ids.indexOf(String(appId));
    const iRank = idx === -1 ? null : idx + 1;
    const topApps = await lookupApps(ids.slice(0, 10), country);
    await saveMetricCheck({
      platform: 'ios', appId: String(appId), appTitle: app.title,
      term: term.toLowerCase().trim(), country,
      language: language ?? storeLanguages(country)[0] ?? null,
      rank: iRank, totalResults: ids.length,
      volume: volume.score, difficulty: difficulty.score,
    }).catch(() => {});
    return {
      app: { appId, title: app.title, developer: app.developer, icon: app.icon },
      platform: 'ios',
      term,
      country,
      language: language ?? storeLanguages(country)[0],
      rank: iRank,
      inTop10: idx !== -1 && idx < 10,
      totalResults: ids.length,
      volume,
      difficulty,
      topApps: topApps.map((a, i) => ({
        position: i + 1,
        appId: a.appId,
        title: a.title,
        isTarget: a.appId === appId,
      })),
    };
  },
);

// История проверок «приложение + ключ» во времени (для графика).
app.get<{
  Querystring: { platform?: string; appId: string; term: string; country?: string };
}>('/history', async (req, reply) => {
  if (!req.query.appId || !req.query.term) {
    return reply.code(400).send({ error: 'appId and term required' });
  }
  const platform = req.query.platform === 'android' ? 'android' : 'ios';
  const history = await getMetricHistory(
    platform,
    req.query.appId,
    req.query.term,
    req.query.country ?? config.defaultCountry,
  );
  return { history };
});

// Все сохранённые связки «приложение + ключ» с их историей (для дашборда).
// Один запрос с json_agg вместо N+1 к БД.
app.get('/history/all', async () => {
  const rows = await query<{
    platform: string;
    appId: string;
    appTitle: string;
    term: string;
    country: string;
    language: string | null;
    history: Array<{ rank: number | null; totalResults: number; volume: number; capturedAt: string }>;
  }>(
    `SELECT platform, app_id AS "appId", term, country, language,
            COALESCE(app_title, '') AS "appTitle",
            COALESCE(
              json_agg(
                json_build_object(
                  'rank', rank, 'totalResults', total_results,
                  'volume', volume, 'capturedAt', captured_at
                ) ORDER BY captured_at
              ) FILTER (WHERE rank IS NOT NULL OR total_results IS NOT NULL),
              '[]'::json
            ) AS history
     FROM metric_checks
     GROUP BY platform, app_id, app_title, term, country, language`,
  );
  return { items: rows };
});

// FoxData-флоу: приложение + гео -> ключевые слова с позициями.
// platform=android -> Google Play discovery (appId = имя пакета).
//
// По умолчанию отвечает снимком и обновляет его в фоне (см. discoveryCache):
// полный подбор идёт десятки секунд, и держать на нём HTTP-запрос клиента
// нельзя. `wait=1` возвращает прежнее синхронное поведение — для крона и
// разовых замеров, которым нужен именно свежий результат.
app.get<{
  Params: { id: string };
  Querystring: {
    country?: string; platform?: string; wait?: string; language?: string;
  };
}>(
  '/apps/:id/discover',
  async (req) => {
    const country = req.query.country ?? config.defaultCountry;
    const platform = req.query.platform === 'android' ? 'android' : 'ios';
    return discoverKeywordsCached(platform, req.params.id, country, {
      wait: req.query.wait === '1',
      language: req.query.language,
    });
  },
);

// Подбор ключей по ссылке: запускает (или возвращает) фоновую задачу.
app.get<{ Querystring: { url?: string; fresh?: string } }>(
  '/discover/by-url',
  async (req, reply) => {
    if (!req.query.url) return reply.code(400).send({ error: 'url required' });
    try {
      return await startDiscoveryJob(req.query.url, req.query.fresh === '1');
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  },
);

// Поллинг состояния фоновой задачи подбора ключей.
app.get<{ Params: { id: string } }>(
  '/discover/job/:id',
  async (req, reply) => {
    const state = await getDiscoveryJobState(Number(req.params.id));
    if (!state) return reply.code(404).send({ error: 'job not found' });
    return state;
  },
);

// Выгрузка ключей одной задачи (одного приложения) в CSV.
app.get<{ Params: { id: string } }>(
  '/discover/job/:id/export.csv',
  async (req, reply) => {
    const state = await getDiscoveryJobState(Number(req.params.id));
    if (!state) return reply.code(404).send({ error: 'job not found' });
    const ranked = state.keywords.filter((k) => k.rank != null);
    const csv = buildCsv(
      ['Ключ', 'Позиция', 'Спрос', 'Насыщенность', 'Сложность', 'Результаты'],
      ranked.map((k) => [
        k.term, k.rank, k.volume,
        k.saturation ?? saturationFromResults(k.totalResults),
        k.difficulty, k.totalResults,
      ]),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="keywords-${state.appId}-${state.country}.csv"`,
    );
    return csv;
  },
);

// Выгрузка ключей по всем приложениям — сгруппировано по приложению.
app.get('/discover/export.csv', async (_req, reply) => {
  const jobs = await allDoneDiscoveryJobs();
  const header = ['Ключ', 'Позиция', 'Спрос', 'Насыщенность', 'Сложность', 'Результаты'];
  const blocks: string[] = [];
  for (const j of jobs) {
    const ranked = ((j.keywords as UrlKeyword[]) ?? []).filter((k) => k.rank != null);
    if (!ranked.length) continue;
    const store = j.platform === 'android' ? 'Google Play' : 'App Store';
    const lines = [
      csvRow([`${j.appTitle ?? j.appId} — ${store}, ${j.country.toUpperCase()}`]),
      csvRow(header),
      ...ranked.map((k) => csvRow([
        k.term, k.rank, k.volume,
        k.saturation ?? saturationFromResults(k.totalResults),
        k.difficulty, k.totalResults,
      ])),
      '',
    ];
    blocks.push(lines.join('\r\n'));
  }
  const csv = '﻿' + (blocks.join('\r\n') || csvRow(['Нет данных']));
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="all-keywords.csv"');
  return csv;
});

app.get<{ Params: { id: string } }>('/apps/:id', async (req, reply) => {
  const info = await appLookup(Number(req.params.id));
  if (!info) return reply.code(404).send({ error: 'not found' });
  return info;
});

/**
 * Карточка приложения: размер, версия, дата обновления.
 *
 * Android идёт через Finsky, потому что размера в вебе Play нет вообще — его
 * убрали из листинга, в разметке страницы нет ни числа, ни подписи. Мобильный
 * клиент получает его в AppDetails.infoDownloadSize. Оттуда же приходит
 * настоящая версия там, где веб рисует «Varies with device».
 *
 * Размер приходит для профиля устройства FINSKY_DEVICE (по умолчанию px_9a):
 * при app bundle Play собирает APK под устройство, единого числа не бывает,
 * о чём и говорит variesWithDevice.
 */
app.get<{
  Params: { id: string };
  Querystring: { platform?: string; language?: string };
}>('/apps/:id/details', async (req, reply) => {
  if (req.query.platform !== 'android') {
    // У App Store размер отдаёт обычный lookup (fileSizeBytes), Finsky не нужен.
    return reply.code(400).send({ error: 'platform=android required' });
  }
  if (!finskyConfigured()) {
    return reply.code(503).send({ error: 'finsky not configured' });
  }

  try {
    const auth = await finskySession(req.query.language);
    const details = await finskyDetails(auth, req.params.id);
    if (!details) return reply.code(404).send({ error: 'app not found' });

    return {
      appId: details.packageName,
      platform: 'android',
      title: details.title,
      developer: details.developer,
      // Байты, как отдаёт App Store — на стороне клиента одна и та же арифметика.
      size: details.size,
      variesWithDevice: details.variesWithDevice,
      version: details.version,
      updatedOn: details.updatedOn,
      installs: details.installs,
      rating: details.rating,
      ratings: details.ratings,
    };
  } catch (e) {
    req.log.error({ err: e }, 'finsky details failed');
    return reply.code(502).send({ error: 'finsky unavailable' });
  }
});

// Отслеживаемые ключи приложения + последний rank.
app.get<{ Params: { id: string } }>('/apps/:id/keywords', async (req) => {
  return query(
    `SELECT k.id, k.term, k.country,
       (SELECT rank FROM rank_snapshots rs
        WHERE rs.app_id = $1 AND rs.keyword_id = k.id
        ORDER BY captured_at DESC LIMIT 1) AS current_rank
     FROM app_keywords ak JOIN keywords k ON k.id = ak.keyword_id
     WHERE ak.app_id = $1`,
    [Number(req.params.id)],
  );
});

// История позиций (тренд) приложения по ключу.
app.get<{ Params: { id: string; kw: string } }>(
  '/apps/:id/keywords/:kw/history',
  async (req) => {
    return query(
      `SELECT rank, total_results, captured_at FROM rank_snapshots
       WHERE app_id = $1 AND keyword_id = $2 ORDER BY captured_at`,
      [Number(req.params.id), Number(req.params.kw)],
    );
  },
);

// Массовая таблица: список приложений × список ключей -> матрица позиций.
app.post<{
  Body: {
    platform?: string;
    country?: string;
    language?: string;
    appIds: string[];
    keywords: string[];
  };
}>('/bulk', async (req, reply) => {
  const { appIds = [], keywords = [] } = req.body;
  if (appIds.length === 0 || keywords.length === 0) {
    return reply.code(400).send({ error: 'appIds and keywords required' });
  }
  const country = req.body.country ?? config.defaultCountry;
  const language = req.body.language;
  const android = req.body.platform === 'android';

  // Трекаемые пользователями ключи — прямой сигнал реальных запросов ниши:
  // пополняют накопительный корпус гео для будущих discovery других приложений.
  feedCorpus(android ? 'android' : 'ios', country, keywords, 'tracked');

  // Логарифмическая оценка объёма по насыщенности выдачи (5-100).
  const volumeFromResults = (total: number) =>
    Math.round(5 + Math.min(1, Math.log10(total + 1) / Math.log10(251)) * 95);

  // Названия приложений (по одному lookup на приложение).
  const apps = await Promise.all(
    appIds.map(async (id) => {
      if (android) {
        const a = await gpAppLookup(id, country);
        return { appId: id, title: a?.title ?? id };
      }
      const a = await appLookup(Number(id), country);
      return { appId: id, title: a?.title ?? id };
    }),
  );

  // Параллельно по ключам (concurrency=8). Apple channel pool внутри
  // nativeSearchIds сам разрулит slot-throttling.
  const rows = await mapLimit(keywords, 8, async (term): Promise<{
    term: string; totalResults: number; volume: number; ranks: (number | null)[];
  }> => {
    try {
      const ids = android
        ? (await gpSearch(term, country, 250)).map((a) => a.appId)
        : await nativeSearchIds(term, country, language);
      const vol = volumeFromResults(ids.length);
      const ranks = appIds.map((id) => {
        const idx = ids.indexOf(String(id));
        return idx === -1 ? null : idx + 1;
      });
      return { term, totalResults: ids.length, volume: vol, ranks };
    } catch {
      return { term, totalResults: 0, volume: 0, ranks: appIds.map(() => null) };
    }
  });

  // Параллельная запись снимков. Дальнейшее ускорение — батч через UNNEST
  // (saveMetricCheckBatch) — следующий шаг. Сейчас экономим на сетевом
  // round-trip за счёт конкурентных INSERT'ов в одном пуле соединений.
  await Promise.all(
    rows.flatMap((row) =>
      appIds.map((id, i) =>
        saveMetricCheck({
          platform: android ? 'android' : 'ios',
          appId: String(id),
          appTitle: apps[i]!.title,
          term: row.term.toLowerCase().trim(),
          country,
          language: android ? null : (language ?? null),
          rank: row.ranks[i]!,
          totalResults: row.totalResults,
          volume: row.volume,
          difficulty: 0,
        }).catch(() => {}),
      ),
    ),
  );

  return { platform: android ? 'android' : 'ios', country, apps, rows };
});

// Локальный мини-p-limit — параллельный map с лимитом concurrency.
async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

// --- Ключевое слово ---------------------------------------------------------

// Сводка по ключу: volume, difficulty, топ-приложения с позициями (онлайн-расчёт).
// platform=android → Google Play, иначе App Store.
app.get<{ Querystring: { term: string; country?: string; platform?: string } }>(
  '/keywords',
  async (req, reply) => {
    const term = req.query.term;
    if (!term) return reply.code(400).send({ error: 'term required' });
    const country = req.query.country ?? config.defaultCountry;

    // Каждый запрошенный пользователем ключ — вклад в накопительный корпус гео.
    feedCorpus(req.query.platform === 'android' ? 'android' : 'ios', country, [term], 'metrics');

    // --- Google Play ---
    if (req.query.platform === 'android') {
      const [volume, difficulty, results] = await Promise.all([
        gpEstimateVolume(term, country),
        gpEstimateDifficulty(term, country),
        gpSearch(term, country, 10),
      ]);
      return {
        term,
        country,
        platform: 'android',
        volume,
        difficulty: { score: difficulty.score, competitors: difficulty.competitors },
        topApps: results.slice(0, 10).map((a, i) => ({
          position: i + 1, appId: a.appId, title: a.title, developer: a.developer, icon: a.icon,
        })),
      };
    }

    // --- App Store ---
    const [volume, difficulty, results] = await Promise.all([
      estimateVolume(term, country),
      estimateDifficulty(term, country),
      searchApps(term, country, 10),
    ]);
    return {
      term,
      country,
      platform: 'ios',
      volume,
      difficulty,
      topApps: results.map((a, i) => ({
        position: i + 1, appId: a.appId, title: a.title, developer: a.developer, icon: a.icon,
      })),
    };
  },
);

// --- Чарты ------------------------------------------------------------------

app.get<{ Querystring: { type?: 'top-free' | 'top-paid'; country?: string; platform?: string } }>(
  '/charts',
  async (req) => {
    const country = req.query.country ?? config.defaultCountry;
    if (req.query.platform === 'android') {
      const list = await gpTopChart(country, 50);
      return list.map((a, i) => ({
        position: i + 1,
        appId: a.appId,
        title: a.title,
        developer: a.developer,
      }));
    }
    return topChart(req.query.type ?? 'top-free', country);
  },
);

// --- Отслеживание -----------------------------------------------------------

app.post<{ Body: { appId: number; term?: string } }>('/track', async (req, reply) => {
  const { appId, term } = req.body;
  const info = await appLookup(appId);
  if (!info) return reply.code(404).send({ error: 'app not found' });
  await upsertApp(info, true);
  if (term) {
    const kw = await upsertKeyword(term, config.defaultCountry, true);
    await linkAppKeyword(appId, kw.id);
    return { tracked: { app: info.title, keyword: kw.term } };
  }
  return { tracked: { app: info.title } };
});

// Онлайн-проверка позиции (без сохранения).
app.get<{ Querystring: { appId: string; term: string; country?: string } }>(
  '/rank',
  async (req, reply) => {
    if (!req.query.appId || !req.query.term) {
      return reply.code(400).send({ error: 'appId and term required' });
    }
    return getRank(
      Number(req.query.appId),
      req.query.term,
      req.query.country ?? config.defaultCountry,
    );
  },
);

// Топ выдачи по ключу (кто на 1,2,…N месте) — для разворота строки в дашборде.
app.get<{ Querystring: { term?: string; country?: string; platform?: string; appId?: string } }>(
  '/serp',
  async (req, reply) => {
    const term = (req.query.term || '').trim();
    if (!term) return reply.code(400).send({ error: 'term required' });
    const country = (req.query.country ?? config.defaultCountry).toLowerCase();
    const platform = req.query.platform === 'android' ? 'android' : 'ios';
    const targetId = req.query.appId || '';
    const LIMIT = 100;
    try {
      if (platform === 'android') {
        const results = await gpSearch(term, country, LIMIT);
        return {
          term, total: results.length,
          apps: results.slice(0, LIMIT).map((a, i) => ({
            position: i + 1, appId: a.appId, title: a.title, isTarget: a.appId === targetId,
          })),
        };
      }
      const ids = await nativeSearchIds(term, country);
      const top = await lookupApps(ids.slice(0, LIMIT), country);
      const byId = new Map(top.map((a) => [String(a.appId), a.title]));
      return {
        term, total: ids.length,
        apps: ids.slice(0, LIMIT).map((id, i) => ({
          position: i + 1, appId: String(id), title: byId.get(String(id)) ?? String(id),
          isTarget: String(id) === targetId,
        })),
      };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'lookup failed' });
    }
  },
);

// Доступные языки витрины для страны.
app.get<{ Querystring: { country?: string } }>('/languages', async (req) => {
  return { languages: storeLanguages(req.query.country ?? config.defaultCountry) };
});

// --- Затравка словаря гео ---------------------------------------------------
// Один прогон — тысячи запросов к магазину, поэтому маршрут закрыт токеном:
// без CORPUS_SEED_TOKEN он не работает вовсе, а не открыт всем подряд.
const seedTokenOk = (req: { headers: { authorization?: string } }): boolean => {
  const expected = process.env.CORPUS_SEED_TOKEN;
  if (!expected) return false;
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7) === expected;
};

app.post<{ Querystring: { country?: string; budget?: string } }>(
  '/corpus/seed',
  async (req, reply) => {
    if (!process.env.CORPUS_SEED_TOKEN) {
      return reply.code(503).send({ error: 'CORPUS_SEED_TOKEN не задан' });
    }
    if (!seedTokenOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (seedInProgress()) {
      return reply.code(409).send({ error: 'затравка уже идёт', last: lastSeedReport() });
    }

    const country = (req.query.country ?? config.defaultCountry).toLowerCase();
    const budget = req.query.budget ? Number(req.query.budget) : undefined;
    // Отвечаем сразу: прогон длится минуты, держать на нём HTTP-запрос незачем.
    // Ошибку гасим здесь же — иначе она всплывёт как unhandled rejection.
    void seedGeoCorpus(country, { budget }).catch((e: unknown) => {
      console.error('[seed] прогон упал:', e instanceof Error ? e.message : e);
    });
    return { started: true, country, budget: budget ?? null };
  },
);

app.get('/corpus/seed/status', async (req, reply) => {
  if (!seedTokenOk(req)) return reply.code(401).send({ error: 'unauthorized' });
  return { running: seedInProgress(), last: lastSeedReport() };
});

app.get('/health', async () => ({ ok: true }));

// Мониторинг источника volume: если healthy=false при dashboardConfigured=true —
// сессия ASA протухла, volume отдаётся эвристикой (обнови .asa-session.json).
app.get('/health/asa', async () => getAsaSourceStatus());

// Живая проба Apple-скрейпинга: если ok:false при работающем Google Play —
// egress-IP забанен Apple (лечится PROXY_URLS или сменой IP/redeploy).
app.get('/health/apple', async () => {
  // pools/proxy отдаём всегда: по ним подбирается APPLE_CHANNELS/HTTP_CHANNELS.
  // throttled > 0 при растущем requests = упёрлись в лимит Apple, каналы пора
  // опускать (иначе ошибки осядут в базе как «нет в выдаче»).
  const pools = () => ({
    native: getNativePoolStats(),
    http: getHttpPoolStats(),
    proxies: { enabled: proxyEnabled(), count: proxyCount() },
  });
  try {
    const ids = await nativeSearchIds('test', 'us');
    return { ok: ids.length > 0, results: ids.length, pools: pools() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), pools: pools() };
  }
});

await registerExtensionRoutes(app);

// Восстановление осиротевших задач подбора: джобы, прерванные предыдущим
// рестартом/крэшем, остаются 'running' навсегда — помечаем их error при старте.
await failStaleDiscoveryJobs(5)
  .then((n) => { if (n) app.log.info(`failStaleDiscoveryJobs: помечено error ${n}`); })
  .catch((e) => app.log.warn(e));

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`API на :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
