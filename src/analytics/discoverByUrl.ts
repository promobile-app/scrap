import { appLookup, lookupApps, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest, type GpAppInfo } from '../scrapers/googleplay.js';
import { parseStoreUrl } from '../scrapers/storeUrl.js';
import {
  createDiscoveryJob, getDiscoveryJob, latestDiscoveryJob, updateDiscoveryJob,
  type DiscoveryJobRow,
} from '../db/repo.js';

export interface UrlKeyword {
  term: string;
  rank: number | null;
  totalResults: number;
  volume: number; // 5-100
  difficulty: number; // 5-100
}

export interface DiscoveryJobState {
  jobId: number;
  status: 'pending' | 'running' | 'done' | 'error';
  processed: number;
  total: number;
  platform: string;
  appId: string;
  appTitle: string;
  country: string;
  keywords: UrlKeyword[];
  error?: string | null;
  cached?: boolean;
}

// Сколько ключей-кандидатов набираем максимум.
const MAX_KEYWORDS = 1000;
// Готовый результат считаем свежим в течение 6 часов.
const DONE_TTL_MS = 6 * 60 * 60 * 1000;
// Задача без прогресса дольше 3 минут считается «зависшей».
const STALE_MS = 3 * 60 * 1000;
// Время жизни кэша выдачи по ключу.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  constructor(private ttlMs: number, private maxEntries = 8000) {}
  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) { this.store.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

interface KeywordData {
  ids: string[];
  totalResults: number;
  volume: number;
  difficulty: number;
}
const keywordCache = new TtlCache<KeywordData>(CACHE_TTL_MS);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'app', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by',
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function volumeFromResults(total: number): number {
  const signal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  return Math.round(5 + signal * 95);
}

function difficultyFromRatings(counts: number[]): number {
  const valid = counts.filter((n) => n > 0);
  if (valid.length === 0) return 5;
  const avg = valid.reduce((s, n) => s + n, 0) / valid.length;
  const strength = Math.min(1, Math.log10(avg + 1) / 6.5);
  return Math.round(5 + strength * 95);
}

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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** Генерация ключей-кандидатов: послойное расширение через autocomplete (BFS). */
async function buildCandidates(
  title: string, genre: string, country: string, platform: 'ios' | 'android',
): Promise<string[]> {
  const suggestFn = platform === 'android' ? gpSuggest : suggest;
  const seeds = [...new Set([...words(title), ...words(genre)])].slice(0, 10);
  const candidates = new Set<string>([...seeds, genre.toLowerCase()]);

  const titleWords = words(title);
  for (let i = 0; i < titleWords.length - 1; i++) {
    candidates.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  let frontier = [...seeds];
  let depth = 0;
  while (candidates.size < MAX_KEYWORDS && frontier.length > 0 && depth < 6) {
    const hintLists = await mapLimit(frontier, 6, (term) =>
      suggestFn(term, country).catch(() => [] as string[]),
    );
    const next: string[] = [];
    for (const hints of hintLists) {
      for (const h of hints) {
        const hl = h.toLowerCase().trim();
        if (hl.length >= 3 && !candidates.has(hl)) {
          candidates.add(hl);
          next.push(hl);
        }
      }
    }
    frontier = next.slice(0, 80);
    depth++;
  }
  return [...candidates].filter((c) => c.length >= 3).slice(0, MAX_KEYWORDS);
}

function sortKeywords(keywords: UrlKeyword[]): UrlKeyword[] {
  return keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volume - a.volume;
  });
}

async function iosKeywordData(term: string, country: string): Promise<KeywordData> {
  const key = `ios|${country}|${term}`;
  const hit = keywordCache.get(key);
  if (hit) return hit;
  const ids = await nativeSearchIds(term, country);
  const top = await lookupApps(ids.slice(0, 10), country);
  const data: KeywordData = {
    ids,
    totalResults: ids.length,
    volume: volumeFromResults(ids.length),
    difficulty: difficultyFromRatings(top.map((a) => a.ratingCount)),
  };
  keywordCache.set(key, data);
  return data;
}

function rowToState(row: DiscoveryJobRow): DiscoveryJobState {
  return {
    jobId: row.id,
    status: row.status,
    processed: row.processed,
    total: row.total,
    platform: row.platform,
    appId: row.appId,
    appTitle: row.appTitle ?? row.appId,
    country: row.country,
    keywords: (row.keywords as UrlKeyword[]) ?? [],
  };
}

/** Фоновая обработка: набирает кандидатов и считает метрики, обновляя БД. */
async function runJob(
  jobId: number, platform: 'ios' | 'android', appId: string, country: string,
): Promise<void> {
  try {
    await updateDiscoveryJob(jobId, { status: 'running' });

    let title = appId;
    let candidates: string[];
    const appCache = new Map<string, GpAppInfo | null>();

    if (platform === 'android') {
      const app = await gpAppLookup(appId, country);
      if (!app) throw new Error('Приложение не найдено в Google Play для этого гео');
      title = app.title;
      candidates = await buildCandidates(app.title, app.genre, country, 'android');
    } else {
      const app = await appLookup(Number(appId), country);
      if (!app) throw new Error('Приложение не найдено в App Store для этого гео');
      title = app.title;
      candidates = await buildCandidates(app.title, app.primaryGenre, country, 'ios');
    }
    await updateDiscoveryJob(jobId, { appTitle: title, total: candidates.length });

    const cachedLookup = async (id: string): Promise<GpAppInfo | null> => {
      if (appCache.has(id)) return appCache.get(id) ?? null;
      const info = await gpAppLookup(id, country);
      appCache.set(id, info);
      return info;
    };

    async function processKeyword(term: string): Promise<UrlKeyword | null> {
      try {
        if (platform === 'android') {
          const key = `android|${country}|${term}`;
          let data = keywordCache.get(key);
          if (!data) {
            const results = await gpSearch(term, country, 250);
            const top = await Promise.all(
              results.slice(0, 4).map((a) => cachedLookup(a.appId)),
            );
            data = {
              ids: results.map((a) => a.appId),
              totalResults: results.length,
              volume: volumeFromResults(results.length),
              difficulty: difficultyFromRatings(top.map((a) => a?.ratings ?? 0)),
            };
            keywordCache.set(key, data);
          }
          const idx = data.ids.indexOf(appId);
          return {
            term, rank: idx === -1 ? null : idx + 1,
            totalResults: data.totalResults, volume: data.volume, difficulty: data.difficulty,
          };
        }
        const data = await iosKeywordData(term, country);
        const idx = data.ids.indexOf(appId);
        return {
          term, rank: idx === -1 ? null : idx + 1,
          totalResults: data.totalResults, volume: data.volume, difficulty: data.difficulty,
        };
      } catch {
        return null;
      }
    }

    const found: UrlKeyword[] = [];
    const chunk = 24;
    const conc = platform === 'android' ? 4 : 8;
    for (let i = 0; i < candidates.length; i += chunk) {
      const slice = candidates.slice(i, i + chunk);
      const part = await mapLimit(slice, conc, processKeyword);
      for (const k of part) if (k) found.push(k);
      await updateDiscoveryJob(jobId, {
        processed: Math.min(i + chunk, candidates.length),
        keywords: sortKeywords([...found]),
      });
    }

    await updateDiscoveryJob(jobId, {
      status: 'done',
      processed: candidates.length,
      keywords: sortKeywords([...found]),
    });
  } catch (e) {
    await updateDiscoveryJob(jobId, {
      status: 'error',
      error: e instanceof Error ? e.message : 'ошибка обработки',
    }).catch(() => {});
  }
}

/**
 * Запускает (или возвращает уже идущую/готовую) фоновую задачу подбора ключей
 * по ссылке на приложение в App Store / Google Play.
 */
export async function startDiscoveryJob(rawUrl: string): Promise<DiscoveryJobState> {
  const { platform, appId, country } = parseStoreUrl(rawUrl);
  const jobKey = `${platform}|${appId}|${country}`;

  const existing = await latestDiscoveryJob(jobKey);
  if (existing) {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (existing.status === 'done' && age < DONE_TTL_MS) {
      return { ...rowToState(existing), cached: true };
    }
    if ((existing.status === 'running' || existing.status === 'pending') && age < STALE_MS) {
      return rowToState(existing);
    }
  }

  const job = await createDiscoveryJob(jobKey, platform, appId, country);
  // Запускаем обработку в фоне — ответ возвращаем сразу.
  void runJob(job.id, platform, appId, country);
  return rowToState(job);
}

/** Текущее состояние задачи для поллинга с фронтенда. */
export async function getDiscoveryJobState(id: number): Promise<DiscoveryJobState | null> {
  const row = await getDiscoveryJob(id);
  return row ? rowToState(row) : null;
}
