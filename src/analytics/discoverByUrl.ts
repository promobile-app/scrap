import { appLookup, lookupApps, lookupAppsCached, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest, type GpAppInfo } from '../scrapers/googleplay.js';
import { parseStoreUrl } from '../scrapers/storeUrl.js';
import {
  createDiscoveryJob, getDiscoveryJob, latestDiscoveryJob, updateDiscoveryJob,
  getCachedKeyword, upsertCachedKeyword,
  getAppCandidateKeywords, saveAppCandidateKeywords,
  saveMetricCheckBatch,
  type DiscoveryJobRow,
} from '../db/repo.js';

// Сколько уже сохранённых кандидатов нужно, чтобы пропустить дорогой BFS-этап
// (генерацию терминов из метаданных / suggestions / конкурентов).
const SKIP_BFS_THRESHOLD = 10;

// --- Очередь подборов: лимит параллельных задач --------------------------
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 4);
let activeJobs = 0;
const waitingJobs: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waitingJobs.push(resolve));
}

function releaseSlot(): void {
  const next = waitingJobs.shift();
  if (next) next();
  else activeJobs--;
}

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

// Сколько ключей-кандидатов набираем максимум. Снижено с 1000 до 300:
// на каждый кандидат идёт замер ранка (запрос к Apple), а хвост за ~300
// почти не добавляет релевантных ключей, зато сильно растягивает время.
// Тюнится через MAX_KEYWORDS.
const MAX_KEYWORDS = Number(process.env.MAX_KEYWORDS ?? 300);
// Глубина BFS-расширения через autocomplete. Снижено с 3 до 2 — третий
// уровень почти не приносит релевантных ключей, но множит suggest-запросы.
const BFS_MAX_DEPTH = Number(process.env.BFS_MAX_DEPTH ?? 2);
// Готовый результат считаем свежим в течение 6 часов.
const DONE_TTL_MS = 6 * 60 * 60 * 1000;
// Кэш-хит отдаём мгновенно, но если данные старше этого порога — в фоне
// перезамеряем и сохраняем новый снимок (история в metric_checks не застаивается).
const REFRESH_AFTER_MS = Number(process.env.REFRESH_AFTER_MS ?? 30 * 60 * 1000);
// Задача без прогресса дольше 3 минут считается «зависшей».
const STALE_MS = 3 * 60 * 1000;
// Сколько максимум держим задачу в очереди (pending) до новой попытки.
const QUEUE_MS = 30 * 60 * 1000;
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
  'the', 'and', 'for', 'app', 'apps', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by', 'is', 'it', 'as', 'or',
  'this', 'that', 'you', 'are', 'our', 'all', 'new', 'get', 'use', 'can',
  'has', 'have', 'from', 'about', 'also', 'they', 'them', 'their', 'will',
  'more', 'one', 'two', 'any', 'now', 'best', 'top', 'easy', 'simple',
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOP_WORDS.has(w));
}

function topWords(s: string, max = 60): string[] {
  const freq = new Map<string, number>();
  for (const w of words(s)) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function bigrams(input: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < input.length - 1; i++) {
    const pair = `${input[i]} ${input[i + 1]}`;
    if (pair.length <= 40) out.push(pair);
  }
  return out;
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

/**
 * Генерация ключей-кандидатов:
 *   1) seeds = слова из title + description + genre + bigrams + competitor titles
 *   2) BFS расширение через autocomplete — небольшая глубина, чтобы
 *      подсказки не «уплывали» в нерелевантную тематику.
 *   3) фильтр релевантности: оставляем кейворд только если у него есть
 *      пересечение токенов с пулом релевантных слов (title+desc+competitors).
 */
async function buildCandidates(
  title: string,
  genre: string,
  country: string,
  platform: 'ios' | 'android',
  description = '',
  competitorTitles: string[] = [],
): Promise<{ candidates: string[]; relevantTokens: Set<string> }> {
  const suggestFn = platform === 'android' ? gpSuggest : suggest;

  const titleWords = words(title);
  const descWords = topWords(description, 60);
  const genreWords = words(genre);
  const compWords = topWords(competitorTitles.join(' '), 40);

  // Пул «своих» токенов — по нему фильтруем подсказки из autocomplete,
  // чтобы не утащить нерелевантные ветки (bank → account → login → ...).
  const relevantTokens = new Set<string>([
    ...titleWords,
    ...descWords,
    ...genreWords,
    ...compWords,
  ]);

  const seedSet = new Set<string>([
    ...titleWords,
    ...descWords.slice(0, 40),
    ...genreWords,
    ...compWords,
    genre.toLowerCase(),
  ].filter((w) => w && w.length >= 3));
  for (const bg of bigrams(titleWords)) seedSet.add(bg);
  for (const bg of bigrams(descWords.slice(0, 20))) seedSet.add(bg);
  for (const t of competitorTitles.slice(0, 8)) {
    for (const bg of bigrams(words(t))) seedSet.add(bg);
  }

  const seeds = [...seedSet].slice(0, 50);
  const candidates = new Set<string>(seeds);

  const isRelevant = (term: string): boolean => {
    const toks = term.toLowerCase().split(/\s+/);
    return toks.some((t) => relevantTokens.has(t));
  };

  let frontier = [...seeds];
  let depth = 0;
  const FRONTIER_LIMIT = 100;

  while (candidates.size < MAX_KEYWORDS && frontier.length > 0 && depth < BFS_MAX_DEPTH) {
    const hintLists = await mapLimit(frontier, 8, (term) =>
      suggestFn(term, country).catch(() => [] as string[]),
    );
    const next: string[] = [];
    for (const hints of hintLists) {
      for (const h of hints) {
        const hl = h.toLowerCase().trim();
        if (hl.length < 3 || hl.length > 60) continue;
        if (candidates.has(hl)) continue;
        if (!isRelevant(hl)) continue;
        candidates.add(hl);
        next.push(hl);
        if (candidates.size >= MAX_KEYWORDS) break;
      }
      if (candidates.size >= MAX_KEYWORDS) break;
    }
    frontier = next.slice(0, FRONTIER_LIMIT);
    depth++;
  }
  return {
    candidates: [...candidates].filter((c) => c.length >= 3).slice(0, MAX_KEYWORDS),
    relevantTokens,
  };
}

function sortKeywords(keywords: UrlKeyword[]): UrlKeyword[] {
  return keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volume - a.volume;
  });
}

/**
 * Финальный фильтр: оставляем кейворды, в которых есть реальный сигнал
 * (приложение в выдаче или ключ имеет заметный объём поиска).
 * Шум типа «term=abc, rank=null, volume=5» отсеиваем — он только захламляет UI.
 */
function filterSignal(keywords: UrlKeyword[], relevantTokens: Set<string>): UrlKeyword[] {
  const MIN_VOLUME_WITHOUT_RANK = 30;
  return keywords.filter((k) => {
    if (k.rank !== null) return true;
    if (k.volume >= MIN_VOLUME_WITHOUT_RANK) {
      // Дополнительно требуем пересечения с пулом релевантных токенов —
      // чтобы «трендовые, но не наши» подсказки не пролезали.
      const toks = k.term.toLowerCase().split(/\s+/);
      return toks.some((t) => relevantTokens.has(t));
    }
    return false;
  });
}

/**
 * Кэшированный доступ к данным по ключу: память → БД → парсинг магазина.
 * БД-кэш переживает рестарты и шарится между всеми задачами.
 */
async function cachedKeyword(
  platform: 'ios' | 'android', country: string, term: string,
  fetcher: () => Promise<KeywordData>,
): Promise<KeywordData> {
  const key = `${platform}|${country}|${term}`;
  const mem = keywordCache.get(key);
  if (mem) return mem;
  try {
    const db = await getCachedKeyword(platform, country, term);
    if (db) { keywordCache.set(key, db); return db; }
  } catch {
    // ошибки БД-кэша не должны валить подбор
  }
  const fresh = await fetcher();
  keywordCache.set(key, fresh);
  upsertCachedKeyword(platform, country, term, fresh).catch(() => {});
  return fresh;
}

async function iosKeywordData(term: string, country: string): Promise<KeywordData> {
  return cachedKeyword('ios', country, term, async () => {
    const ids = await nativeSearchIds(term, country);
    // Кэшированный lookup: топовые приложения повторяются между ключами,
    // поэтому повторные id не порождают новых запросов к iTunes.
    const top = await lookupAppsCached(ids.slice(0, 10), country);
    return {
      ids,
      totalResults: ids.length,
      volume: volumeFromResults(ids.length),
      difficulty: difficultyFromRatings(top.map((a) => a.ratingCount)),
    };
  });
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

// Регистр активных задач, чтобы поддерживать отмену по force-restart.
const cancelledJobs = new Set<number>();
function cancelJob(id: number): void {
  cancelledJobs.add(id);
}
function isCancelled(id: number): boolean {
  return cancelledJobs.has(id);
}

/** Обёртка с ограничением параллельности (очередь). */
async function runJobQueued(
  jobId: number, platform: 'ios' | 'android', appId: string, country: string,
): Promise<void> {
  await acquireSlot();
  try {
    if (isCancelled(jobId)) return;
    await runJob(jobId, platform, appId, country);
  } finally {
    cancelledJobs.delete(jobId);
    releaseSlot();
  }
}

/** Фоновая обработка: набирает кандидатов и считает метрики, обновляя БД. */
async function runJob(
  jobId: number, platform: 'ios' | 'android', appId: string, country: string,
): Promise<void> {
  try {
    await updateDiscoveryJob(jobId, { status: 'running' });

    let title = appId;
    let candidates: string[];
    let relevantTokens: Set<string> = new Set();
    const appCache = new Map<string, GpAppInfo | null>();

    // Сначала проверяем постоянный словарь кандидатов для этой пары
    // (platform, appId, country). Если уже есть достаточный набор —
    // пропускаем дорогой BFS-этап и сразу идём мерить ранки.
    // Обрезаем до MAX_KEYWORDS: словарь мог быть записан при старом лимите
    // (напр. 1000) — иначе закэшированный путь игнорировал бы новый лимит и
    // мерил бы все 600+ старых ключей.
    const persisted = (await getAppCandidateKeywords(platform, appId, country)
      .catch(() => [] as string[])).slice(0, MAX_KEYWORDS);
    const useCached = persisted.length >= SKIP_BFS_THRESHOLD;

    if (platform === 'android') {
      const app = await gpAppLookup(appId, country);
      if (!app) throw new Error('Приложение не найдено в Google Play для этого гео');
      title = app.title;
      if (useCached) {
        candidates = persisted;
      } else {
        const competitors = await gpSearch(app.title, country, 20).catch(() => []);
        const competitorTitles = competitors
          .filter((c) => c.appId !== appId)
          .slice(0, 10)
          .map((c) => c.title);
        const desc = `${app.summary} ${app.description}`.trim();
        const built = await buildCandidates(
          app.title, app.genre, country, 'android', desc, competitorTitles,
        );
        candidates = built.candidates;
        relevantTokens = built.relevantTokens;
      }
    } else {
      const app = await appLookup(Number(appId), country);
      if (!app) throw new Error('Приложение не найдено в App Store для этого гео');
      title = app.title;
      if (useCached) {
        candidates = persisted;
      } else {
        const competitorIds = await nativeSearchIds(app.title, country).catch(() => []);
        const competitors = competitorIds.length
          ? await lookupApps(
              competitorIds.filter((id) => id !== String(appId)).slice(0, 10),
              country,
            ).catch(() => [])
          : [];
        const competitorTitles = competitors.map((c) => c.title);
        const genres = (app.genres ?? []).join(' ');
        const built = await buildCandidates(
          app.title,
          `${app.primaryGenre} ${genres}`,
          country,
          'ios',
          app.description,
          competitorTitles,
        );
        candidates = built.candidates;
        relevantTokens = built.relevantTokens;
      }
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
          const data = await cachedKeyword('android', country, term, async () => {
            const results = await gpSearch(term, country, 250);
            const top = await Promise.all(
              results.slice(0, 4).map((a) => cachedLookup(a.appId)),
            );
            return {
              ids: results.map((a) => a.appId),
              totalResults: results.length,
              volume: volumeFromResults(results.length),
              difficulty: difficultyFromRatings(top.map((a) => a?.ratings ?? 0)),
            };
          });
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
      if (isCancelled(jobId)) {
        // Помечаем как error чтобы фронт мог двинуться дальше; новая задача
        // уже создана в startDiscoveryJob и продолжит работу.
        await updateDiscoveryJob(jobId, {
          status: 'error',
          error: 'cancelled by recalculate',
        }).catch(() => {});
        return;
      }
      const slice = candidates.slice(i, i + chunk);
      const part = await mapLimit(slice, conc, processKeyword);
      for (const k of part) if (k) found.push(k);
      await updateDiscoveryJob(jobId, {
        processed: Math.min(i + chunk, candidates.length),
        keywords: sortKeywords(filterSignal([...found], relevantTokens)),
      });
    }

    if (found.length === 0 && candidates.length > 0) {
      throw new Error('Магазин ограничил запросы — не удалось получить выдачу. Попробуйте позже.');
    }

    // Если кандидаты пришли из кэша — фильтр по relevantTokens пропускаем,
    // они уже были отфильтрованы при первом прогоне.
    const finalKeywords = useCached
      ? sortKeywords([...found])
      : sortKeywords(filterSignal([...found], relevantTokens));

    await updateDiscoveryJob(jobId, {
      status: 'done',
      processed: candidates.length,
      keywords: finalKeywords,
    });

    // Сохраняем в постоянный словарь, чтобы следующий пользователь не повторял BFS.
    // Берём только термы, прошедшие финальный фильтр (relevant + sorted).
    const termsToPersist = finalKeywords.map((k) => k.term);
    if (termsToPersist.length > 0) {
      saveAppCandidateKeywords(platform, appId, country, termsToPersist).catch(() => {});
    }

    // Снимок истории — по строке на каждый ключ для будущих чартов
    // (rank/volume/difficulty/results во времени).
    if (finalKeywords.length > 0) {
      saveMetricCheckBatch(
        { platform, appId, appTitle: title, country, language: null },
        finalKeywords.map((k) => ({
          term: k.term,
          rank: k.rank,
          totalResults: k.totalResults,
          volume: k.volume,
          difficulty: k.difficulty,
        })),
      ).catch(() => {});
    }
  } catch (e) {
    await updateDiscoveryJob(jobId, {
      status: 'error',
      error: e instanceof Error ? e.message : 'ошибка обработки',
    }).catch(() => {});
  }
}

// Дедуп одновременных фоновых рефрешей по ключу (в пределах процесса).
const refreshingKeys = new Set<string>();

/**
 * Фоновый перезамер: создаёт новую задачу и прогоняет её, не блокируя ответ
 * пользователю. Нужен, чтобы повторный анализ уже известного app+гео всё
 * равно сохранял свежий снимок (metric_checks + словарь кандидатов).
 */
function backgroundRefresh(
  jobKey: string, platform: 'ios' | 'android', appId: string, country: string,
): void {
  if (refreshingKeys.has(jobKey)) return;
  refreshingKeys.add(jobKey);
  void (async () => {
    try {
      const job = await createDiscoveryJob(jobKey, platform, appId, country);
      await runJobQueued(job.id, platform, appId, country);
    } catch {
      // фоновый рефреш — ошибки не должны влиять на пользователя
    } finally {
      refreshingKeys.delete(jobKey);
    }
  })();
}

/**
 * Запускает (или возвращает уже идущую/готовую) фоновую задачу подбора ключей
 * по ссылке на приложение в App Store / Google Play.
 */
export async function startDiscoveryJob(
  rawUrl: string, force = false,
): Promise<DiscoveryJobState> {
  const { platform, appId, country } = parseStoreUrl(rawUrl);
  const jobKey = `${platform}|${appId}|${country}`;

  const existing = await latestDiscoveryJob(jobKey);
  if (existing) {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (!force && existing.status === 'done' && age < DONE_TTL_MS) {
      // Кэш + фоновый рефреш: отдаём готовое мгновенно, а если данные не
      // совсем свежие — в фоне перезамеряем и сохраняем новый снимок.
      if (age > REFRESH_AFTER_MS) backgroundRefresh(jobKey, platform, appId, country);
      return { ...rowToState(existing), cached: true };
    }
    if (existing.status === 'running' && age < STALE_MS) {
      if (force) {
        // Отменяем текущую задачу и запускаем новую с свежими настройками.
        cancelJob(existing.id);
      } else {
        return rowToState(existing);
      }
    }
    if (!force && existing.status === 'pending' && age < QUEUE_MS) {
      // Уже стоит в очереди — не плодим дубликат.
      return rowToState(existing);
    }
  }

  const job = await createDiscoveryJob(jobKey, platform, appId, country);
  // Ставим в очередь — выполнится, когда освободится слот.
  void runJobQueued(job.id, platform, appId, country);
  return rowToState(job);
}

/** Текущее состояние задачи для поллинга с фронтенда. */
export async function getDiscoveryJobState(id: number): Promise<DiscoveryJobState | null> {
  const row = await getDiscoveryJob(id);
  return row ? rowToState(row) : null;
}
