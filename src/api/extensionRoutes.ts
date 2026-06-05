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

const TOKEN_TTL = '30d';

// Кэш инсайтов: данные готовой джобы неизменны, поэтому план по (job, goal, locale)
// можно не пересчитывать — почти нулевая маржинальная стоимость на повторных
// открытиях в расширении.
const insightsCache = new Map<string, InsightsResult>();
const VALID_GOALS: Goal[] = ['rank_up', 'expand', 'defend'];

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

  app.post<{ Body: { email?: string; password?: string } }>(
    '/auth/register',
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
    return { user: rows[0] };
  });

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
      const paid = await jobPaid(state.jobId, uid);
      return { ...state, summary, paid };
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
      const paid = await jobPaid(jobId, uid);
      // Прячем полный список ключей до оплаты — отдаём только summary.
      const keywords = paid ? state.keywords : [];
      return { ...state, keywords, summary, paid };
    },
  );

  // --- PAYMENTS (stub-провайдер; заменим на Stripe позже) ---

  app.post<{ Body: { jobId?: number } }>(
    '/payment/checkout',
    async (req, reply) => {
      const uid = bearer(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const jobId = Number(req.body.jobId);
      if (!jobId) return reply.code(400).send({ error: 'jobId required' });
      const owners = await query<{ user_id: number | null }>(
        'SELECT user_id FROM discovery_jobs WHERE id = $1', [jobId],
      );
      if (!owners[0]) return reply.code(404).send({ error: 'job not found' });
      if (owners[0].user_id !== uid) {
        return reply.code(403).send({ error: 'not your job' });
      }
      const rows = await query<{ id: number }>(
        `INSERT INTO payments (user_id, job_id, amount_cents, currency, status, provider)
         VALUES ($1, $2, $3, $4, 'pending', 'stub') RETURNING id`,
        [uid, jobId, config.reportPriceCents, config.reportCurrency],
      );
      const paymentId = rows[0]!.id;
      // Stub-checkout: на этом же бэке отрисуем простую страницу с кнопкой
      // «Pay», которая дёрнет /payment/confirm. Возвращаем URL для extension.
      const checkoutUrl = `/payment/checkout/${paymentId}`;
      return {
        paymentId,
        checkoutUrl,
        amountCents: config.reportPriceCents,
        currency: config.reportCurrency,
      };
    },
  );

  // Simple HTML-страничка stub-checkout — открывается в новой вкладке.
  app.get<{ Params: { id: string } }>(
    '/payment/checkout/:id',
    async (req, reply) => {
      const paymentId = Number(req.params.id);
      const rows = await query<{ amount_cents: number; currency: string; status: string }>(
        'SELECT amount_cents, currency, status FROM payments WHERE id = $1',
        [paymentId],
      );
      const p = rows[0];
      if (!p) return reply.code(404).send('payment not found');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      const amount = (p.amount_cents / 100).toFixed(2);
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
        <h1>RankRadar — full report</h1>
        <p class="muted">Unlock full keyword list and Excel download</p>
        <p style="font-size:28px;font-weight:800;margin:18px 0">${amount} ${p.currency}</p>
        <p class="muted">Status: ${p.status}</p>
        <button onclick="pay('success')">Pay (stub success)</button>
        <button class="fail" onclick="pay('failed')">Simulate failure</button>
        <script>
          async function pay(outcome){
            const r = await fetch('/payment/confirm', {method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({paymentId:${paymentId}, outcome})});
            const d = await r.json();
            document.querySelector('.card').innerHTML =
              '<h1>'+(d.status==='success'?'Payment successful':'Payment failed')+'</h1>'+
              '<p class="muted">You can close this tab and return to the extension.</p>';
          }
        </script></div></body></html>`;
    },
  );

  app.post<{ Body: { paymentId?: number; outcome?: 'success' | 'failed' } }>(
    '/payment/confirm',
    async (req, reply) => {
      const paymentId = Number(req.body.paymentId);
      const outcome = req.body.outcome === 'failed' ? 'failed' : 'success';
      const rows = await query<{ user_id: number; job_id: number; status: string }>(
        'SELECT user_id, job_id, status FROM payments WHERE id = $1', [paymentId],
      );
      const p = rows[0];
      if (!p) return reply.code(404).send({ error: 'payment not found' });
      if (p.status !== 'pending') return { status: p.status };
      await query(
        `UPDATE payments SET status = $1, updated_at = now() WHERE id = $2`,
        [outcome, paymentId],
      );
      if (outcome === 'success') {
        await query(
          'UPDATE discovery_jobs SET paid = TRUE WHERE id = $1', [p.job_id],
        );
      }
      return { status: outcome };
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
      if (!(await jobPaid(jobId, uid))) {
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
      if (!(await jobPaid(jobId, uid))) {
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
      const cacheKey = `${jobId}|${goal}|${locale}`;
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
