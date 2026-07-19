// Эндпоинты, которые использует Chrome-extension (ASO keyword analyzer):
// auth, payment-stub, summary, xlsx-экспорт за paywall, analytics events.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  startDiscoveryJob, getDiscoveryJobState, saturationFromResults,
} from '../analytics/discoverByUrl.js';
import { generateInsights, type Goal, type InsightsResult } from '../analytics/insights.js';
import { getDiscoveryJobLite } from '../db/repo.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { lookupAppsCached } from '../scrapers/appstore.js';
import { gpSearch } from '../scrapers/googleplay.js';
import { estimateVolume } from '../analytics/appstore/volume.js';
import { estimateDifficulty } from '../analytics/appstore/difficulty.js';
import { gpEstimateVolume } from '../analytics/googleplay/volume.js';
import { gpEstimateDifficulty } from '../analytics/googleplay/difficulty.js';
import {
  paymentProvider, confirmStubPayment, verifyConfirmToken, getSubscription,
} from '../payments/provider.js';
import {
  trackApp, untrackApp, listTrackedApps, getTrackedApp, findTracked,
  computeChanges, rankSeries, disableAlerts,
} from '../tracking/tracking.js';
import { verifyUnsubToken } from '../jobs/digest.js';

const TOKEN_TTL = '30d';

// Кэш инсайтов: данные готовой джобы неизменны, поэтому план по (job, goal, locale)
// можно не пересчитывать — почти нулевая маржинальная стоимость на повторных
// открытиях в расширении.
const insightsCache = new Map<string, InsightsResult>();
const VALID_GOALS: Goal[] = ['rank_up', 'expand', 'defend'];

// Отпечаток набора ключей (term+rank). План — чистая функция от (ключи, goal,
// язык), поэтому кэшируем по содержимому, а не по jobId: тогда фоновый рефреш и
// смена jobId не вызывают лишнюю пересборку, а реальное изменение данных — вызывает.
function keywordsFingerprint(keywords: Array<{ term: string; rank: number | null }>): string {
  let h = 5381;
  for (const k of keywords) {
    const s = `${k.term}:${k.rank}`;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${keywords.length}.${(h >>> 0).toString(36)}`;
}

// Кэш выдачи по ключу (term→топ приложений) — тап по ключу не должен каждый раз
// бить в Apple. isTarget пересчитывается под запрашивающее приложение.
interface SerpEntry {
  at: number;
  total: number;
  apps: Array<{ position: number; appId: string; title: string; isTarget: boolean }>;
}
const serpCache = new Map<string, SerpEntry>();
const SERP_TTL_MS = 10 * 60 * 1000;

function signToken(userId: number): string {
  return jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

function verifyToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { uid?: number };
    return typeof payload.uid === 'number' ? payload.uid : null;
  } catch {
    return null;
  }
}

function bearer(req: FastifyRequest): number | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return verifyToken(h.slice(7).trim());
}

async function jobPaid(jobId: number, userId: number): Promise<boolean> {
  const rows = await query<{ paid: boolean; user_id: number | null }>(
    'SELECT paid, user_id FROM discovery_jobs WHERE id = $1',
    [jobId],
  );
  const row = rows[0];
  if (!row) return false;
  return row.paid && row.user_id === userId;
}

// Аккаунт-левел доступ к платным фичам. Основная модель — подписка; для
// пользователей, купивших разовые отчёты до перехода на подписку, доступ
// сохраняется (legacy: есть хотя бы одна оплаченная job).
async function userHasAccess(userId: number): Promise<boolean> {
  const sub = await getSubscription(userId);
  if (sub?.active) return true;
  const rows = await query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM discovery_jobs WHERE user_id = $1 AND paid = TRUE) AS exists',
    [userId],
  );
  return rows[0]?.exists === true;
}

// Право видеть содержимое конкретной job: активная подписка открывает все
// свои job'ы; отдельно оплаченная job (legacy) — только её.
async function jobUnlocked(jobId: number, userId: number): Promise<boolean> {
  if (await jobPaid(jobId, userId)) return true;
  const sub = await getSubscription(userId);
  if (!sub?.active) return false;
  // Подписка открывает только job'ы самого пользователя.
  const rows = await query<{ user_id: number | null }>(
    'SELECT user_id FROM discovery_jobs WHERE id = $1', [jobId],
  );
  return rows[0]?.user_id === userId;
}

function summarize(keywords: { rank: number | null }[]): {
  rankedKeywords: number;
  top3: number;
  top10: number;
} {
  const ranked = keywords.filter((k) => k.rank != null);
  return {
    rankedKeywords: ranked.length,
    top3: ranked.filter((k) => (k.rank as number) <= 3).length,
    top10: ranked.filter((k) => (k.rank as number) <= 10).length,
  };
}

export async function registerExtensionRoutes(app: FastifyInstance): Promise<void> {
  // --- AUTH ---

  // Анти-брутфорс: auth-маршруты лимитируются жёстче общего лимита (по IP).
  const authRateLimit = {
    rateLimit: { max: 15, timeWindow: '5 minutes' as const },
  };

  app.post<{ Body: { email?: string; password?: string } }>(
    '/auth/register',
    { config: authRateLimit },
    async (req, reply) => {
      const email = (req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return reply.code(400).send({ error: 'invalid email' });
      }
      if (password.length < 6) {
        return reply.code(400).send({ error: 'password must be at least 6 chars' });
      }
      const existing = await query<{ id: number }>(
        'SELECT id FROM users WHERE email = $1', [email],
      );
      if (existing[0]) return reply.code(409).send({ error: 'email already registered' });
      const hash = await bcrypt.hash(password, 10);
      const inserted = await query<{ id: number }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email, hash],
      );
      const userId = inserted[0]!.id;
      return { token: signToken(userId), user: { id: userId, email } };
    },
  );

  app.post<{ Body: { email?: string; password?: string } }>(
    '/auth/login',
    { config: authRateLimit },
    async (req, reply) => {
      const email = (req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '';
      const rows = await query<{ id: number; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email = $1', [email],
      );
      const row = rows[0];
      if (!row) return reply.code(401).send({ error: 'invalid credentials' });
      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) return reply.code(401).send({ error: 'invalid credentials' });
      return { token: signToken(row.id), user: { id: row.id, email } };
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const uid = bearer(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const rows = await query<{ id: number; email: string }>(
      'SELECT id, email FROM users WHERE id = $1', [uid],
    );
    if (!rows[0]) return reply.code(401).send({ error: 'unauthorized' });
    const [hasAccess, subscription] = await Promise.all([
      userHasAccess(uid),
      getSubscription(uid),
    ]);
    // hasPaid — имя оставлено для совместимости со старыми версиями расширения.
    return { user: rows[0], hasPaid: hasAccess, hasAccess, subscription };
  });

  // --- KEYWORD CHECK (платная фича) -----------------------------------------
  // Ввёл ключ → метрики (volume/difficulty) + топ-10 приложений с позициями.
  // platform=android → Google Play, иначе App Store. Гейт: нужен хотя бы один
  // оплаченный анализ (userHasPaid) — иначе 403, чтобы фича была действительно
  // платной на уровне API, а не только скрытой в UI.
  app.get<{ Querystring: { term?: string; country?: string; platform?: string; appId?: string } }>(
    '/ext/keyword',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      if (!(await userHasAccess(uid))) {
        return reply.code(403).send({ error: 'payment required' });
      }
      const term = (req.query.term || '').trim();
      if (!term) return reply.code(400).send({ error: 'term required' });
      const country = (req.query.country || config.defaultCountry).toLowerCase();
      // appId — приложение из открытой вкладки стора: считаем его позицию по ключу.
      const target = (req.query.appId || '').trim();

      if (req.query.platform === 'android') {
        const [volume, difficulty, results] = await Promise.all([
          gpEstimateVolume(term, country),
          gpEstimateDifficulty(term, country),
          gpSearch(term, country, 30), // шире — чтобы поймать позицию целевого приложения
        ]);
        const idx = target ? results.findIndex((a) => a.appId === target) : -1;
        return {
          term, country, platform: 'android',
          volume,
          difficulty: { score: difficulty.score, competitors: difficulty.competitors },
          rank: idx === -1 ? null : idx + 1,
          totalResults: results.length,
          topApps: results.slice(0, 10).map((a, i) => ({
            position: i + 1, appId: a.appId, title: a.title,
            developer: a.developer, icon: a.icon, isTarget: !!target && a.appId === target,
          })),
        };
      }

      const [volume, difficulty, ids] = await Promise.all([
        estimateVolume(term, country),
        estimateDifficulty(term, country),
        nativeSearchIds(term, country),
      ]);
      const idx = target ? ids.indexOf(target) : -1;
      const top = await lookupAppsCached(ids.slice(0, 10), country);
      return {
        term, country, platform: 'ios',
        volume,
        difficulty,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        topApps: top.map((a, i) => ({
          position: i + 1, appId: String(a.appId), title: a.title,
          developer: a.developer, icon: a.icon, isTarget: !!target && String(a.appId) === target,
        })),
      };
    },
  );

  // --- ANALYZE: запуск + привязка к пользователю ---

  app.get<{ Querystring: { url?: string; fresh?: string } }>(
    '/ext/analyze',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      if (!req.query.url) return reply.code(400).send({ error: 'url required' });
      let state;
      try {
        // fresh=1 — план 12.7: повторный анализ всегда новый (отдельная оплата).
        state = await startDiscoveryJob(req.query.url, req.query.fresh === '1');
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'error' });
      }
      // Привязываем job к пользователю (если ещё не привязан).
      await query(
        `UPDATE discovery_jobs SET user_id = $1
         WHERE id = $2 AND user_id IS NULL`,
        [uid, state.jobId],
      );
      const summary = summarize(state.keywords);
      const paid = await jobUnlocked(state.jobId, uid);
      // Подписчику ключи отдаём сразу — без второго запроса /ext/job.
      return { ...state, keywords: paid ? state.keywords : [], summary, paid };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/ext/job/:id',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const jobId = Number(req.params.id);
      const state = await getDiscoveryJobState(jobId);
      if (!state) return reply.code(404).send({ error: 'job not found' });
      const summary = summarize(state.keywords);
      // «Оплачено» = подписка активна (или job куплена разово до перехода).
      const paid = await jobUnlocked(jobId, uid);
      // Прячем полный список ключей до оплаты — отдаём только summary.
      const keywords = paid ? state.keywords : [];
      return { ...state, keywords, summary, paid };
    },
  );

  // --- PAYMENTS ---
  // Модель: подписка (config.subscription). Слой провайдера — payments/provider.ts;
  // сейчас stub, замена на Paddle/Stripe не трогает эти маршруты и расширение.

  app.post<{ Body: { jobId?: number } }>(
    '/payment/checkout',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      // jobId опционален: это job, с пейволла которой пришли (для истории).
      const jobId = req.body.jobId ? Number(req.body.jobId) : null;
      if (jobId) {
        const owners = await query<{ user_id: number | null }>(
          'SELECT user_id FROM discovery_jobs WHERE id = $1', [jobId],
        );
        if (!owners[0]) return reply.code(404).send({ error: 'job not found' });
        if (owners[0].user_id !== uid) {
          return reply.code(403).send({ error: 'not your job' });
        }
      }
      const session = await paymentProvider.createSubscriptionCheckout(uid, jobId);
      return {
        paymentId: session.paymentId,
        checkoutUrl: session.checkoutUrl,
        amountCents: session.amountCents,
        currency: session.currency,
        kind: session.kind,
        periodDays: config.subscription.periodDays,
      };
    },
  );

  // HTML-страничка stub-checkout — открывается в новой вкладке.
  // Требует confirm-токен (?t=...): без него страница не работает, а чужой
  // платёж подтвердить нельзя.
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>(
    '/payment/checkout/:id',
    async (req, reply) => {
      const paymentId = Number(req.params.id);
      const token = req.query.t || '';
      if (verifyConfirmToken(token) !== paymentId) {
        return reply.code(403).send('invalid or expired checkout link');
      }
      const rows = await query<{ amount_cents: number; currency: string; status: string; kind: string }>(
        'SELECT amount_cents, currency, status, kind FROM payments WHERE id = $1',
        [paymentId],
      );
      const p = rows[0];
      if (!p) return reply.code(404).send('payment not found');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      const amount = (p.amount_cents / 100).toFixed(2);
      const period = config.subscription.periodDays;
      return `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>
        <style>body{font-family:-apple-system,sans-serif;background:#0c0c0f;color:#f1f1f3;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
        .card{background:#18181c;border:1px solid #2c2c31;border-radius:16px;
        padding:32px;max-width:380px;text-align:center}
        h1{font-size:20px;margin:0 0 8px}.muted{color:#87878f;font-size:13px}
        button{margin-top:20px;padding:12px 24px;border:0;border-radius:12px;
        background:#3b6ef6;color:#fff;font-weight:700;font-size:14px;cursor:pointer;width:100%}
        button:hover{background:#345fdb}button.fail{background:#3a3a40;margin-top:8px}
        </style></head><body><div class="card">
        <h1>RankRadar Pro</h1>
        <p class="muted">All reports, keyword checks and Excel export for every app</p>
        <p style="font-size:28px;font-weight:800;margin:18px 0">${amount} ${p.currency}<span style="font-size:14px;color:#87878f"> / ${period} days</span></p>
        <p class="muted">Status: ${p.status}</p>
        <button onclick="pay('success')">Pay (stub success)</button>
        <button class="fail" onclick="pay('failed')">Simulate failure</button>
        <script>
          async function pay(outcome){
            const r = await fetch('/payment/confirm', {method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({paymentId:${paymentId}, outcome, token:${JSON.stringify(token)}})});
            const d = await r.json();
            document.querySelector('.card').innerHTML =
              '<h1>'+(d.status==='success'?'Payment successful':'Payment failed')+'</h1>'+
              '<p class="muted">You can close this tab and return to the extension.</p>';
          }
        </script></div></body></html>`;
    },
  );

  app.post<{ Body: { paymentId?: number; outcome?: 'success' | 'failed'; token?: string } }>(
    '/payment/confirm',
    async (req, reply) => {
      const paymentId = Number(req.body.paymentId);
      // Подтвердить платёж может только держатель confirm-токена этого платежа.
      if (verifyConfirmToken(req.body.token || '') !== paymentId) {
        return reply.code(403).send({ error: 'invalid confirm token' });
      }
      const outcome = req.body.outcome === 'failed' ? 'failed' : 'success';
      const result = await confirmStubPayment(paymentId, outcome);
      if (!result) return reply.code(404).send({ error: 'payment not found' });
      return result;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/payment/status/:id',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const rows = await query<{ user_id: number; status: string; job_id: number }>(
        'SELECT user_id, status, job_id FROM payments WHERE id = $1',
        [Number(req.params.id)],
      );
      const p = rows[0];
      if (!p) return reply.code(404).send({ error: 'payment not found' });
      if (p.user_id !== uid) return reply.code(403).send({ error: 'forbidden' });
      return { status: p.status, jobId: p.job_id };
    },
  );

  // --- XLSX-экспорт за paywall ---

  app.get<{ Params: { id: string } }>(
    '/ext/job/:id/export.xlsx',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const jobId = Number(req.params.id);
      const state = await getDiscoveryJobState(jobId);
      if (!state) return reply.code(404).send({ error: 'job not found' });
      if (!(await jobUnlocked(jobId, uid))) {
        return reply.code(403).send({ error: 'payment required' });
      }
      const ranked = state.keywords.filter((k) => k.rank != null);
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Keywords');
      sheet.columns = [
        { header: 'Keyword', key: 'term', width: 40 },
        { header: 'Rank', key: 'rank', width: 10 },
        { header: 'Demand', key: 'demand', width: 12 },
        { header: 'Saturation', key: 'saturation', width: 12 },
        { header: 'Difficulty', key: 'difficulty', width: 12 },
        { header: 'Results', key: 'results', width: 12 },
      ];
      sheet.getRow(1).font = { bold: true };
      for (const k of ranked) {
        sheet.addRow({
          term: k.term,
          rank: k.rank,
          demand: k.volume,
          saturation: k.saturation ?? saturationFromResults(k.totalResults),
          difficulty: k.difficulty,
          results: k.totalResults,
        });
      }
      const buf = await wb.xlsx.writeBuffer();
      reply.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      reply.header(
        'Content-Disposition',
        `attachment; filename="keywords-report-${state.appId}.xlsx"`,
      );
      return Buffer.from(buf);
    },
  );

  // --- AI INSIGHTS (за paywall) ---
  // Превращает готовую таблицу ключей в приоритизированный план действий.
  // Работает поверх честных метрик спрос/сложность; отзывы не используются.
  app.post<{ Body: { jobId?: number; goal?: string; lang?: string } }>(
    '/ext/insights',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const jobId = Number(req.body.jobId);
      if (!jobId) return reply.code(400).send({ error: 'jobId required' });
      if (!(await jobUnlocked(jobId, uid))) {
        return reply.code(403).send({ error: 'payment required' });
      }
      const goal: Goal = VALID_GOALS.includes(req.body.goal as Goal)
        ? (req.body.goal as Goal)
        : 'rank_up';
      const state = await getDiscoveryJobState(jobId);
      if (!state) return reply.code(404).send({ error: 'job not found' });
      if (state.status !== 'done') {
        return reply.code(409).send({ error: 'analysis not finished' });
      }
      // Язык пояснений: явный выбор из расширения (en/ru), иначе по стране витрины.
      const locale = req.body.lang === 'ru' || req.body.lang === 'en'
        ? req.body.lang
        : state.country;
      // Ключ кэша по содержимому: приложение+гео+goal+язык+отпечаток ключей.
      // Не зависит от jobId — переживает фоновый рефреш; меняется только при
      // изменении набора ключей (пересчёт).
      const fp = keywordsFingerprint(state.keywords);
      const cacheKey = `${state.platform}|${state.appId}|${state.country}|${goal}|${locale}|${fp}`;
      const cached = insightsCache.get(cacheKey);
      if (cached) return cached;
      try {
        const insights = await generateInsights(state, { goal, locale });
        insightsCache.set(cacheKey, insights);
        return insights;
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'insights error' });
      }
    },
  );

  // --- SERP по ключу: топ выдачи (кто на 1,2,…N месте) ---
  // Тап по ключу в попапе разворачивает конкурентов по этому запросу.
  app.get<{ Querystring: { term?: string; country?: string; platform?: string; appId?: string } }>(
    '/ext/keyword-apps',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const term = (req.query.term || '').trim();
      if (!term) return reply.code(400).send({ error: 'term required' });
      const country = (req.query.country || config.defaultCountry).toLowerCase();
      const platform = req.query.platform === 'android' ? 'android' : 'ios';
      const targetId = req.query.appId || '';
      const LIMIT = 100;

      const cacheKey = `${platform}|${country}|${term.toLowerCase()}`;
      const cached = serpCache.get(cacheKey);
      const fresh = cached && Date.now() - cached.at < SERP_TTL_MS ? cached : null;

      try {
        let apps: Array<{ position: number; appId: string; title: string; isTarget: boolean }>;
        let total: number;
        if (fresh) {
          total = fresh.total;
          apps = fresh.apps.map((a) => ({ ...a, isTarget: a.appId === targetId }));
        } else if (platform === 'android') {
          const results = await gpSearch(term, country, LIMIT);
          total = results.length;
          apps = results.slice(0, LIMIT).map((a, i) => ({
            position: i + 1, appId: a.appId, title: a.title, isTarget: a.appId === targetId,
          }));
          serpCache.set(cacheKey, { at: Date.now(), total, apps: apps.map((a) => ({ ...a })) });
        } else {
          const ids = await nativeSearchIds(term, country);
          total = ids.length;
          const top = await lookupAppsCached(ids.slice(0, LIMIT), country);
          const byId = new Map(top.map((a) => [String(a.appId), a.title]));
          apps = ids.slice(0, LIMIT).map((id, i) => ({
            position: i + 1, appId: String(id), title: byId.get(String(id)) ?? String(id),
            isTarget: String(id) === targetId,
          }));
          serpCache.set(cacheKey, { at: Date.now(), total, apps: apps.map((a) => ({ ...a })) });
        }
        return { term, country, platform, total, apps };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : 'lookup failed' });
      }
    },
  );

  // --- TRACKING (retention-ядро подписки, Pro-gated) ---

  // Начать отслеживать приложение (ключи — из последнего готового анализа).
  app.post<{ Body: { platform?: string; appId?: string; country?: string } }>(
    '/ext/track',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      if (!(await userHasAccess(uid))) {
        return reply.code(403).send({ error: 'payment required' });
      }
      const platform = req.body.platform === 'android' ? 'android' : 'ios';
      const appId = (req.body.appId || '').trim();
      const country = (req.body.country || config.defaultCountry).toLowerCase();
      if (!appId) return reply.code(400).send({ error: 'appId required' });
      try {
        const tracked = await trackApp(uid, platform, appId, country);
        return { tracked: { id: tracked.id, terms: tracked.terms.length } };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'error' });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/ext/track/:id',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const ok = await untrackApp(uid, Number(req.params.id));
      if (!ok) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    },
  );

  // Список отслеживаемых приложений + сводка движений за 24ч (для вкладки).
  app.get('/ext/tracked', async (req, reply) => {
    const uid = bearer(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await userHasAccess(uid))) {
      return reply.code(403).send({ error: 'payment required' });
    }
    const apps = await listTrackedApps(uid);
    const items = await Promise.all(apps.map(async (a) => {
      const changes = await computeChanges(a.platform, a.appId, a.country, a.terms, 24);
      const sig = changes.filter((c) => c.significant);
      return {
        id: a.id,
        platform: a.platform,
        appId: a.appId,
        appTitle: a.appTitle,
        country: a.country,
        terms: a.terms.length,
        alertsEnabled: a.alertsEnabled,
        up: sig.filter((c) => (c.delta ?? 0) > 0 || c.enteredTop10).length,
        down: sig.filter((c) => (c.delta ?? 0) < 0 || c.leftTop10).length,
      };
    }));
    return { items };
  });

  // Детали одного отслеживаемого приложения: изменения + серии для спарклайнов.
  app.get<{ Params: { id: string } }>(
    '/ext/tracked/:id',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      if (!(await userHasAccess(uid))) {
        return reply.code(403).send({ error: 'payment required' });
      }
      const a = await getTrackedApp(uid, Number(req.params.id));
      if (!a) return reply.code(404).send({ error: 'not found' });
      const [changes, series] = await Promise.all([
        computeChanges(a.platform, a.appId, a.country, a.terms, 24),
        rankSeries(a.platform, a.appId, a.country, a.terms, 20),
      ]);
      // Сортировка: значимые сверху (по |delta|), затем по текущей позиции.
      const byTerm = new Map(changes.map((c) => [c.term, c]));
      const keywords = a.terms.map((term) => {
        const c = byTerm.get(term);
        return {
          term,
          currRank: c?.currRank ?? null,
          prevRank: c?.prevRank ?? null,
          delta: c?.delta ?? null,
          enteredTop10: c?.enteredTop10 ?? false,
          leftTop10: c?.leftTop10 ?? false,
          significant: c?.significant ?? false,
          series: (series[term] ?? []).map((p) => p.rank),
        };
      }).sort((x, y) => {
        if (x.significant !== y.significant) return x.significant ? -1 : 1;
        const dx = Math.abs(x.delta ?? 0), dy = Math.abs(y.delta ?? 0);
        if (dx !== dy) return dy - dx;
        return (x.currRank ?? 999) - (y.currRank ?? 999);
      });
      return {
        id: a.id,
        platform: a.platform,
        appId: a.appId,
        appTitle: a.appTitle,
        country: a.country,
        alertsEnabled: a.alertsEnabled,
        keywords,
      };
    },
  );

  // Отслеживается ли приложение (для кнопки Track в отчёте).
  app.get<{ Querystring: { platform?: string; appId?: string; country?: string } }>(
    '/ext/track/status',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const platform = req.query.platform === 'android' ? 'android' : 'ios';
      const appId = (req.query.appId || '').trim();
      const country = (req.query.country || config.defaultCountry).toLowerCase();
      if (!appId) return reply.code(400).send({ error: 'appId required' });
      const t = await findTracked(uid, platform, appId, country);
      return { tracked: t ? { id: t.id, terms: t.terms.length } : null };
    },
  );

  // Unsubscribe из письма (подписанный токен, без логина).
  app.get<{ Querystring: { t?: string } }>(
    '/ext/alerts/unsubscribe',
    async (req, reply) => {
      const uid = verifyUnsubToken(req.query.t || '');
      if (!uid) return reply.code(403).send('invalid or expired link');
      await disableAlerts(uid);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return `<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px">
        <h2>Email alerts turned off</h2>
        <p style="color:#888">You can re-enable them by tracking any app again in the RankRadar extension.</p></body>`;
    },
  );

  // --- ANALYTICS ---

  app.post<{ Body: { event?: string; payload?: Record<string, unknown> } }>(
    '/events',
    async (req, reply) => {
      const uid = bearer(req); // событий до логина тоже разрешаем (uid = null)
      const event = (req.body.event || '').trim();
      const allowed = new Set([
        'extension_opened',
        'analysis_started',
        'analysis_completed',
        'payment_started',
        'payment_success',
        'payment_failed',
        'report_downloaded',
        'insights_viewed',
        'keyword_checked',
        'app_tracked',
      ]);
      if (!allowed.has(event)) return reply.code(400).send({ error: 'unknown event' });
      await query(
        'INSERT INTO analytics_events (user_id, event, payload) VALUES ($1, $2, $3)',
        [uid, event, JSON.stringify(req.body.payload || {})],
      );
      return { ok: true };
    },
  );
}
