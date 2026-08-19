import { request } from 'undici';
import { config } from '../config.js';
import { nextDispatcher, reportDispatcherFailure } from './proxy.js';
import { SEARCH_TOKEN } from './gplayRpcTokens.js';

/**
 * Глубокая выдача Google Play через batchexecute-RPC витрины play.google.com.
 *
 * Зачем: HTML-страница /store/search отдаёт ~20-30 приложений и пагинации не
 * имеет (см. шапку googleplay.ts), а нативный protobuf-API Finsky для обычных
 * запросов возвращает пустой список. RPC-канал, которым пользуется сама
 * витрина, листается токеном следующей страницы и аккаунта не требует вообще.
 *
 * Важно про порядок вызовов: `qnKhOb` (следующая страница) работает ТОЛЬКО с
 * токеном, полученным из `lGYRle` (первая страница). Вызванный первым он
 * отвечает PlayDataError — из-за этого прошлая попытка в googleplay.ts и была
 * признана нерабочей.
 *
 * Формат заимствован из AuroraOSS/gplayapi (GPL-3.0-or-later):
 * data/builders/rpc/SearchQueryBuilder.kt + helpers/web/WebSearchHelper.kt.
 */

const BATCH_URL = 'https://play.google.com/_/PlayStoreUi/data/batchexecute';
const TAG = 'SearchQueryBuilder';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** Первая страница — RPC lGYRle; следующие — qnKhOb с токеном предыдущей. */
function buildRpc(query: string, nextPageToken: string): string {
  const inner = nextPageToken
    ? `[[null,${SEARCH_TOKEN},null,\\"${nextPageToken}\\"]]`
    : `[[[],${SEARCH_TOKEN},[\\"${query}\\"],4,[null,1],null,null,[]]]`;
  const rpcId = nextPageToken ? 'qnKhOb' : 'lGYRle';
  return `["${rpcId}","${inner}",null,"${TAG}@${query}"]`;
}

async function fetchRpc(rpc: string, country: string, language: string): Promise<string> {
  const url = `${BATCH_URL}?hl=${language}&gl=${country}`;
  // URLEncoder.encode в апстриме кодирует пробел как '+', encodeURIComponent — как %20.
  const body = `f.req=[[${encodeURIComponent(rpc).replace(/%20/g, '+')}]]`;
  const dispatcher = nextDispatcher('google');
  let responded = false;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: 'https://play.google.com',
        'User-Agent': UA,
      },
      body,
      ...(dispatcher ? { dispatcher } : {}),
    });
    responded = true;
    if (res.statusCode >= 400) {
      throw new Error(`batchexecute HTTP ${res.statusCode}`);
    }
    return await res.body.text();
  } catch (e) {
    // Кулдаун — только за транспортную ошибку (адрес не отвечает). Ответ со
    // статусом 4xx означает, что прокси исправен, а недоволен им Google —
    // и раньше такой ответ выводил адрес из ротации ещё и для Apple.
    if (!responded) reportDispatcherFailure(dispatcher, 'google');
    throw e;
  }
}

/** Значение по цепочке индексов; undefined на любом обрыве. */
function dig(node: unknown, ...path: number[]): unknown {
  let cur: unknown = node;
  for (const idx of path) {
    if (!Array.isArray(cur)) return undefined;
    cur = cur[idx];
  }
  return cur;
}

/**
 * Ответ batchexecute — анти-JSON поток строк; полезное лежит во фреймах
 * `[["wrb.fr", ...]]`, где элемент 2 — вложенная JSON-строка с данными.
 */
function unwrapResponse(raw: string): unknown | null {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('[["wrb.fr')) continue;
    let frames: unknown;
    try {
      frames = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (dig(frame, 0) !== 'wrb.fr') continue;
      const data = dig(frame, 2);
      if (typeof data !== 'string' || data === 'null') continue;
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface GpRpcPage {
  packageNames: string[];
  nextPageToken: string;
}

/** Одна страница выдачи: пакеты в порядке ранжирования + токен следующей. */
export async function gpRpcSearchPage(
  query: string,
  country = config.defaultCountry,
  language = 'en',
  nextPageToken = '',
): Promise<GpRpcPage> {
  const raw = await fetchRpc(buildRpc(query, nextPageToken), country, language);
  const parsed = unwrapResponse(raw);
  if (!parsed) return { packageNames: [], nextPageToken: '' };

  // Первый стрим — сама выдача; если это не он, результаты лежат уровнем ниже
  // (витрина иногда подставляет сверху тематический блок).
  let payload: unknown = dig(parsed, 0);
  if (dig(payload, 0, 1) !== 'Apps') {
    const nested = dig(payload, 1, 0);
    if (nested !== undefined) payload = nested;
  }

  const entries = dig(payload, 0, 0);
  const packageNames = Array.isArray(entries)
    ? entries.map((e) => dig(e, 12, 0)).filter((p): p is string => typeof p === 'string')
    : [];
  const token = dig(payload, 0, 7, 1);

  return { packageNames, nextPageToken: typeof token === 'string' ? token : '' };
}

export interface GpRpcSearchResult {
  term: string;
  packageNames: string[];
  pages: number;
  truncated: boolean;
}

/**
 * Ранжированный список пакетов по ключу: позиция приложения = индекс + 1.
 * Обходит страницы, пока витрина отдаёт токен следующей.
 */
export async function gpRpcSearch(
  query: string,
  country = config.defaultCountry,
  opts: {
    language?: string;
    maxPages?: number;
    delayMs?: number;
    /**
     * Пакет, ради которого идёт обход. Как только он найден, листать дальше
     * незачем — позиция уже известна. Для замера индексации это основной
     * режим: приложения, которые реально ранжируются, чаще всего находятся
     * на первой странице, и обход стоит 1 запрос вместо пяти.
     */
    stopAt?: string;
  } = {},
): Promise<GpRpcSearchResult> {
  const language = opts.language ?? 'en';
  const maxPages = opts.maxPages ?? 15;
  const delayMs = opts.delayMs ?? 300;

  const packageNames: string[] = [];
  const seen = new Set<string>();
  let token = '';
  let pages = 0;
  let found = false;

  while (pages < maxPages) {
    const page = await gpRpcSearchPage(query, country, language, token);
    pages++;
    const before = packageNames.length;
    for (const pkg of page.packageNames) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      packageNames.push(pkg);
    }
    if (opts.stopAt && seen.has(opts.stopAt)) { found = true; break; }
    token = page.nextPageToken;
    // Ни токена, ни новых пакетов — выдача кончилась.
    if (!token || packageNames.length === before) break;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    term: query,
    packageNames,
    pages,
    // Досрочная остановка по найденному пакету — это не усечение: позиция
    // точна, просто хвост выдачи не понадобился.
    truncated: !found && Boolean(token) && pages >= maxPages,
  };
}

/** Позиция приложения по ключу. null = вне пройденной глубины. */
export async function gpRpcGetRank(
  packageName: string,
  query: string,
  country = config.defaultCountry,
  opts: { language?: string; maxPages?: number } = {},
): Promise<{ rank: number | null; total: number; truncated: boolean }> {
  const result = await gpRpcSearch(query, country, opts);
  const idx = result.packageNames.indexOf(packageName);
  return { rank: idx === -1 ? null : idx + 1, total: result.packageNames.length, truncated: result.truncated };
}

/** CLI: tsx src/scrapers/gplayRpc.ts "roblox" ru ru com.roblox.client [maxPages] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const term = process.argv[2] ?? 'roblox';
  const country = process.argv[3] ?? config.defaultCountry;
  const language = process.argv[4] ?? 'en';
  const target = process.argv[5] ?? '';
  const maxPages = Number(process.argv[6] ?? 15);

  gpRpcSearch(term, country, { language, maxPages })
    .then((r) => {
      console.log(`\n"${term}" (${country}/${language}): ${r.packageNames.length} приложений за ${r.pages} страниц`);
      if (r.truncated) console.log('(упёрлись в maxPages, выдача не кончилась)');
      console.log('\nТоп-10:');
      r.packageNames.slice(0, 10).forEach((p, i) => console.log(`  ${String(i + 1).padStart(3)}. ${p}`));
      if (r.packageNames.length > 20) {
        console.log('\nПозиции 20-30:');
        r.packageNames.slice(19, 30).forEach((p, i) => console.log(`  ${String(i + 20).padStart(3)}. ${p}`));
      }
      if (target) {
        const idx = r.packageNames.indexOf(target);
        console.log(`\n${target}: ${idx === -1 ? 'не найден' : `позиция ${idx + 1}`}`);
      }
    })
    .catch((e: unknown) => {
      console.error('❌', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
