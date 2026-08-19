import { request } from 'undici';
import { config } from '../config.js';
import { dispatcherForSlot } from './proxy.js';

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'iTunes-AppStore/1.0',
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Slot pool --------------------------------------------------------------
// Раньше тут был ОДИН глобальный lastRequestAt: throttle() держал паузу
// scrapeDelayMs между любыми двумя запросами на весь процесс. Из-за этого
// concurrency в вызывающем коде была бесполезна — suggest()/lookupApps()
// сериализовались в ~1 запрос / scrapeDelayMs.
//
// Теперь — пул из HTTP_CHANNELS слотов: каждый со своим расписанием, так что
// одновременно «в полёте» может быть до N запросов с интервалом scrapeDelayMs
// на слот → ×N throughput. Round-robin берёт наименее загруженный слот.
const HTTP_CHANNELS = Number(process.env.HTTP_CHANNELS ?? 6);
const slots = Array.from({ length: HTTP_CHANNELS }, () => ({ nextAt: 0, inFlight: 0 }));
let slotCursor = 0;

/** Берёт наименее загруженный слот, ждёт его паузу и возвращает индекс. */
async function acquireSlot(): Promise<number> {
  let idx = slotCursor;
  for (let i = 0; i < slots.length; i++) {
    const c = (slotCursor + i) % slots.length;
    if (slots[c]!.inFlight === 0) { idx = c; break; }
    if (slots[c]!.nextAt < slots[idx]!.nextAt) idx = c;
  }
  slotCursor = (idx + 1) % slots.length;
  const s = slots[idx]!;
  s.inFlight++;
  const now = Date.now();
  const at = Math.max(now, s.nextAt);
  s.nextAt = at + config.scrapeDelayMs;
  if (at > now) await sleep(at - now);
  return idx;
}

function releaseSlot(idx: number): void {
  slots[idx]!.inFlight = Math.max(0, slots[idx]!.inFlight - 1);
}

// --- Backpressure ----------------------------------------------------------
// Раньше при 429 тормозила только упавшая задача (sleep в её цикле ретраев),
// а пул продолжал выдавать слоты с прежней частотой — то есть пул, который
// сильнее всего разгоняется через HTTP_CHANNELS, не умел притормаживать сам.
// Теперь 429/5xx сдвигает расписание слота, как bumpPenalty в native.ts:
// притормаживает и остальные задачи, попавшие на тот же слот.
const THROTTLE_PENALTY_MS = Number(process.env.HTTP_PENALTY_MS ?? 8000);

function bumpSlotPenalty(idx: number, ms = THROTTLE_PENALTY_MS): void {
  const s = slots[idx]!;
  s.nextAt = Math.max(s.nextAt, Date.now() + ms);
}

// Счётчики для /health/apple: без них подъём HTTP_CHANNELS слепой — троттлинг
// не виден, а его следствие (position '250+' в базе) выглядит как нормальные данные.
const counters = { requests: 0, throttled429: 0, serverErrors: 0, failures: 0 };

export function getHttpPoolStats() {
  return {
    channels: HTTP_CHANNELS,
    delayMs: config.scrapeDelayMs,
    penaltyMs: THROTTLE_PENALTY_MS,
    inFlight: slots.reduce((n, s) => n + s.inFlight, 0),
    ...counters,
  };
}

/** Общая обработка ответа: считает статусы и штрафует слот при троттлинге. */
function noteStatus(idx: number, statusCode: number): void {
  if (statusCode === 429) {
    counters.throttled429++;
    bumpSlotPenalty(idx);
    throw new Error(`HTTP 429`);
  }
  if (statusCode >= 500) {
    counters.serverErrors++;
    // 5xx у Apple под нагрузкой — тот же сигнал «перебор», но мягче.
    bumpSlotPenalty(idx, Math.round(THROTTLE_PENALTY_MS / 4));
    throw new Error(`HTTP ${statusCode}`);
  }
  if (statusCode >= 400) throw new Error(`HTTP ${statusCode} (non-retryable)`);
}

export interface FetchOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number>;
}

/** GET с ретраями, экспоненциальным backoff и ротацией User-Agent. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    fullUrl.searchParams.set(k, String(v));
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < config.scrapeMaxRetries; attempt++) {
    const slot = await acquireSlot();
    try {
      const dispatcher = dispatcherForSlot(slot, 'apple');
      counters.requests++;
      const res = await request(fullUrl, {
        method: 'GET',
        headers: { 'User-Agent': pickUserAgent(), Accept: 'application/json', ...opts.headers },
        ...(dispatcher ? { dispatcher } : {}),
      });
      noteStatus(slot, res.statusCode);
      return (await res.body.json()) as T;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    } finally {
      releaseSlot(slot);
    }
  }
  counters.failures++;
  throw new Error(`fetchJson failed after ${config.scrapeMaxRetries} attempts: ${String(lastErr)}`);
}

/** GET, возвращающий сырой текст (для XML/plist-эндпоинтов). */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    fullUrl.searchParams.set(k, String(v));
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < config.scrapeMaxRetries; attempt++) {
    const slot = await acquireSlot();
    try {
      const dispatcher = dispatcherForSlot(slot, 'apple');
      counters.requests++;
      const res = await request(fullUrl, {
        method: 'GET',
        headers: { 'User-Agent': pickUserAgent(), ...opts.headers },
        ...(dispatcher ? { dispatcher } : {}),
      });
      noteStatus(slot, res.statusCode);
      return await res.body.text();
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    } finally {
      releaseSlot(slot);
    }
  }
  counters.failures++;
  throw new Error(`fetchText failed after ${config.scrapeMaxRetries} attempts: ${String(lastErr)}`);
}
