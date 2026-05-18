import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { appLookup, searchApps, getRank, lookupApps } from '../scrapers/appstore.js';
import { nativeSearchIds, storeLanguages } from '../scrapers/native.js';
import { topChart } from '../scrapers/charts.js';
import { estimateVolume } from '../analytics/volume.js';
import { estimateDifficulty } from '../analytics/difficulty.js';
import { discoverKeywords } from '../analytics/discovery.js';
import { upsertApp, upsertKeyword, linkAppKeyword } from '../db/repo.js';

const app = Fastify({ logger: true });

// CORS: дашборд может открываться с другого origin (панель предпросмотра).
await app.register(fastifyCors, { origin: true });

// Статика дашборда (public/ в корне проекта).
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
await app.register(fastifyStatic, { root: join(projectRoot, 'public') });

// --- Приложение -------------------------------------------------------------

// Поиск приложений по названию (для выбора приложения в дашборде).
app.get<{ Querystring: { q: string; country?: string } }>(
  '/apps/search',
  async (req, reply) => {
    if (!req.query.q) return reply.code(400).send({ error: 'q required' });
    const results = await searchApps(
      req.query.q,
      req.query.country ?? config.defaultCountry,
      15,
    );
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
  Querystring: { term: string; country?: string; language?: string };
}>('/apps/:id/metrics', async (req, reply) => {
    const term = req.query.term;
    if (!term) return reply.code(400).send({ error: 'term required' });
    const appId = Number(req.params.id);
    const country = req.query.country ?? config.defaultCountry;
    const language = req.query.language;

    const [app, ids, volume, difficulty] = await Promise.all([
      appLookup(appId, country),
      nativeSearchIds(term, country, language),
      estimateVolume(term, country),
      estimateDifficulty(term, country),
    ]);
    if (!app) return reply.code(404).send({ error: 'app not found' });

    const idx = ids.indexOf(String(appId));
    const topApps = await lookupApps(ids.slice(0, 10), country);
    return {
      app: { appId, title: app.title, developer: app.developer, icon: app.icon },
      term,
      country,
      language: language ?? storeLanguages(country)[0],
      rank: idx === -1 ? null : idx + 1,
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

// FoxData-флоу: приложение + гео -> ключевые слова с позициями.
app.get<{ Params: { id: string }; Querystring: { country?: string } }>(
  '/apps/:id/discover',
  async (req) => {
    return discoverKeywords(
      Number(req.params.id),
      req.query.country ?? config.defaultCountry,
    );
  },
);

app.get<{ Params: { id: string } }>('/apps/:id', async (req, reply) => {
  const info = await appLookup(Number(req.params.id));
  if (!info) return reply.code(404).send({ error: 'not found' });
  return info;
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

// --- Ключевое слово ---------------------------------------------------------

// Сводка по ключу: volume, difficulty, топ-приложения (онлайн-расчёт).
app.get<{ Querystring: { term: string; country?: string } }>(
  '/keywords',
  async (req, reply) => {
    const term = req.query.term;
    if (!term) return reply.code(400).send({ error: 'term required' });
    const country = req.query.country ?? config.defaultCountry;
    const [volume, difficulty, results] = await Promise.all([
      estimateVolume(term, country),
      estimateDifficulty(term, country),
      searchApps(term, country, 10),
    ]);
    return {
      term,
      country,
      volume,
      difficulty,
      topApps: results.map((a, i) => ({ position: i + 1, appId: a.appId, title: a.title })),
    };
  },
);

// --- Чарты ------------------------------------------------------------------

app.get<{ Querystring: { type?: 'top-free' | 'top-paid'; country?: string } }>(
  '/charts',
  async (req) => {
    return topChart(req.query.type ?? 'top-free', req.query.country ?? config.defaultCountry);
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

// Доступные языки витрины для страны.
app.get<{ Querystring: { country?: string } }>('/languages', async (req) => {
  return { languages: storeLanguages(req.query.country ?? config.defaultCountry) };
});

app.get('/health', async () => ({ ok: true }));

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`API на :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
