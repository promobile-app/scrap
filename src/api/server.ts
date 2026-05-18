import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { appLookup, searchApps, getRank, lookupApps } from '../scrapers/appstore.js';
import { nativeSearchIds, storeLanguages } from '../scrapers/native.js';
import { gpSearch, gpAppLookup, gpTopChart } from '../scrapers/googleplay.js';
import { gpEstimateVolume, gpEstimateDifficulty } from '../analytics/gp.js';
import { topChart } from '../scrapers/charts.js';
import { estimateVolume } from '../analytics/volume.js';
import { estimateDifficulty } from '../analytics/difficulty.js';
import { discoverKeywords } from '../analytics/discovery.js';
import {
  upsertApp, upsertKeyword, linkAppKeyword,
  saveMetricCheck, getMetricHistory, distinctMetricTargets,
} from '../db/repo.js';

const app = Fastify({ logger: true });

// CORS: дашборд может открываться с другого origin (панель предпросмотра).
await app.register(fastifyCors, { origin: true });

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
    if (req.query.platform === 'android') {
      const gpId = req.params.id;
      const [gApp, gpResults, gVolume, gDifficulty] = await Promise.all([
        gpAppLookup(gpId, country),
        gpSearch(term, country, 250),
        gpEstimateVolume(term, country),
        gpEstimateDifficulty(term, country),
      ]);
      if (!gApp) return reply.code(404).send({ error: 'app not found' });
      const gIdx = gpResults.findIndex((a) => a.appId === gpId);
      const gRank = gIdx === -1 ? null : gIdx + 1;
      await saveMetricCheck({
        platform: 'android', appId: gpId, appTitle: gApp.title,
        term: term.toLowerCase().trim(), country, language: null,
        rank: gRank, totalResults: gpResults.length,
        volume: gVolume.score, difficulty: gDifficulty.score,
      }).catch(() => {});
      return {
        app: { appId: gApp.appId, title: gApp.title, developer: gApp.developer, icon: gApp.icon },
        term,
        country,
        platform: 'android',
        rank: gRank,
        inTop10: gIdx !== -1 && gIdx < 10,
        totalResults: gpResults.length,
        volume: gVolume,
        difficulty: { score: gDifficulty.score, competitors: gDifficulty.competitors },
        topApps: gpResults.slice(0, 10).map((a, i) => ({
          position: i + 1,
          appId: a.appId,
          title: a.title,
          isTarget: a.appId === gpId,
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
app.get('/history/all', async () => {
  const targets = await distinctMetricTargets();
  const items = [];
  for (const t of targets) {
    const history = await getMetricHistory(t.platform, t.appId, t.term, t.country);
    items.push({ ...t, history });
  }
  return { items };
});

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

  // Один поиск на ключ; внутри ищем позиции всех приложений.
  const rows = [];
  for (const term of keywords) {
    try {
      const ids = android
        ? (await gpSearch(term, country, 250)).map((a) => a.appId)
        : await nativeSearchIds(term, country, language);
      const vol = volumeFromResults(ids.length);
      const ranks = appIds.map((id) => {
        const idx = ids.indexOf(String(id));
        return idx === -1 ? null : idx + 1;
      });
      rows.push({ term, totalResults: ids.length, volume: vol, ranks });

      // Каждая ячейка таблицы — это замер «приложение + ключ»: пишем в историю.
      for (let i = 0; i < appIds.length; i++) {
        await saveMetricCheck({
          platform: android ? 'android' : 'ios',
          appId: String(appIds[i]),
          appTitle: apps[i]!.title,
          term: term.toLowerCase().trim(),
          country,
          language: android ? null : (language ?? null),
          rank: ranks[i]!,
          totalResults: ids.length,
          volume: vol,
          difficulty: 0,
        }).catch(() => {});
      }
    } catch {
      rows.push({ term, totalResults: 0, volume: 0, ranks: appIds.map(() => null) });
    }
  }

  return { platform: android ? 'android' : 'ios', country, apps, rows };
});

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
