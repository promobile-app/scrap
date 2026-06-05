import { request } from 'undici';
import { config } from '../config.js';

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
      const res = await request(fullUrl, {
        method: 'GET',
        headers: { 'User-Agent': pickUserAgent(), Accept: 'application/json', ...opts.headers },
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      if (res.statusCode >= 400) {
        throw new Error(`HTTP ${res.statusCode} (non-retryable)`);
      }
      return (await res.body.json()) as T;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    } finally {
      releaseSlot(slot);
    }
  }
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
      const res = await request(fullUrl, {
        method: 'GET',
        headers: { 'User-Agent': pickUserAgent(), ...opts.headers },
      });
      if (res.statusCode === 429 || res.statusCode >= 500) throw new Error(`HTTP ${res.statusCode}`);
      if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode} (non-retryable)`);
      return await res.body.text();
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    } finally {
      releaseSlot(slot);
    }
  }
  throw new Error(`fetchText failed after ${config.scrapeMaxRetries} attempts: ${String(lastErr)}`);
}
