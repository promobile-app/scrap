import { request } from 'undici';
import { config } from '../config.js';

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'iTunes-AppStore/1.0',
];

let lastRequestAt = 0;

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Троттлинг: выдерживаем минимальную паузу между запросами. */
async function throttle(): Promise<void> {
  const wait = config.scrapeDelayMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
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
    await throttle();
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
    await throttle();
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
    }
  }
  throw new Error(`fetchText failed after ${config.scrapeMaxRetries} attempts: ${String(lastErr)}`);
}
