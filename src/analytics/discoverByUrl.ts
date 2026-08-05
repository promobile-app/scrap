import { appLookup, lookupApps, lookupAppsCached, suggest } from '../scrapers/appstore.js';
import { nativeAppPage, nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest, type GpAppInfo } from '../scrapers/googleplay.js';
import { isAsaDashConfigured, keywordPopularity } from '../scrapers/asaDashboard.js';
import { isGoogleAdsConfigured, keywordSearchVolumes } from '../scrapers/googleAds.js';
import { webSearchesSignal } from './googleplay/volume.js';
import { logNorm } from './signals.js';
import { STOP_WORDS } from './stopWords.js';
import { parseStoreUrl } from '../scrapers/storeUrl.js';
import {
  createDiscoveryJob, getDiscoveryJob, latestDiscoveryJob, updateDiscoveryJob,
  getCachedKeyword, upsertCachedKeyword,
  getAppCandidateKeywords, saveAppCandidateKeywords,
  saveMetricCheckBatch,
  type DiscoveryJobRow,
} from '../db/repo.js';
import { llmRelevantTerms, type RelevanceAppContext } from './relevance.js';
import { notify } from '../notify.js';

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
  volume: number; // 5-100 — теперь это СПРОС (autocomplete-взвешенный), как в volume.ts
  saturation: number; // 5-100 — насыщенность выдачи (предложение/конкуренция за слово)
  difficulty: number; // 5-100 — сложность выхода в топ (сила топ-10)
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
const MAX_KEYWORDS = Number(process.env.MAX_KEYWORDS ?? 200);
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

/**
 * Фильтр качества кандидата: отсекает мусор-фразы, которые люди не ищут.
 * Одиночные слова (≥3 символов, не стоп-слова) — ок. Многословные фразы
 * оставляем ТОЛЬКО если их подтвердил autocomplete Apple (значит, это реальный
 * запрос) или это биграмма из названия самого приложения. Так уходят
 * биграммы-обрывки из описаний/конкурентов ("countries been", "available health").
 */
export function isQualityCandidate(
  term: string,
  autocompleteConfirmed: { has(k: string): boolean },
  titleBigrams: { has(k: string): boolean },
): boolean {
  const t = term.toLowerCase().trim();
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  if (toks.length === 1) return toks[0].length >= 3 && !STOP_WORDS.has(toks[0]);
  return autocompleteConfirmed.has(t) || titleBigrams.has(t);
}

/**
 * Релевантность ключа приложению. coreTokens — «ядро»: слова из названия,
 * жанра и топ-частотных слов описания. Ключ релевантен, если делит хотя бы один
 * токен с ядром. Отсекает реальные, но не относящиеся к приложению запросы
 * ("community bank", "device monitor" для YouTube), которые пролезали из-за
 * слишком широкого пула (вся описалка + конкуренты) и одного общего токена.
 * Пустое ядро => не фильтруем (нет метаданных — не режем вслепую).
 */
export function coreRelevant(term: string, coreTokens: Set<string>): boolean {
  if (coreTokens.size === 0) return true;
  const toks = term.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return toks.some((t) => coreTokens.has(t));
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOP_WORDS.has(w));
}

function topWords(s: string, max = 60): string[] {
  const freq = new Map<string, number>();
  // words() уже отсеял стоп-слова — здесь остаётся только частотность.
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

// Насыщенность выдачи — сигнал ПРЕДЛОЖЕНИЯ (сколько приложений бьётся за слово).
// Раньше это ошибочно отдавалось как «объём». Это НЕ спрос и коррелирует с difficulty.
export function saturationFromResults(total: number): number {
  const signal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  return Math.round(5 + signal * 95);
}

// Оценка СПРОСА (popularity) — та же эвристика, что в analytics/volume.ts:
// autocomplete-ранг это сигнал спроса (вес 0.6), насыщенность вспомогательный (0.4),
// плюс штраф за длинный хвост. autocompleteSignal ∈ [0..1] добывается БЕСПЛАТНО на
// этапе BFS (позиция термина в подсказках Apple) — без доп. запросов к магазину.
// Если сигнала нет (0) — оценка падает на насыщенность, что честно отражает
// «спрос не подтверждён автокомплитом».
// webSearches (avgMonthlySearches Keyword Planner, только Android) — самый
// сильный из доступных сигналов реального спроса: если он есть, забирает
// основной вес, autocomplete/насыщенность становятся вспомогательными.
function demandFromSignals(
  autocompleteSignal: number, total: number, term: string, webSearches?: number | null,
): number {
  const resultSignal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  const wordCount = term.trim().split(/\s+/).filter(Boolean).length;
  const lengthPenalty = wordCount >= 4 ? 0.6 : wordCount === 3 ? 0.8 : 1;
  const raw = webSearches != null
    ? (autocompleteSignal * 0.3 + resultSignal * 0.2 + webSearchesSignal(webSearches) * 0.5) * lengthPenalty
    : (autocompleteSignal * 0.6 + resultSignal * 0.4) * lengthPenalty;
  return Math.round(5 + raw * 95);
}

function difficultyFromRatings(counts: number[]): number {
  const valid = counts.filter((n) => n > 0);
  if (valid.length === 0) return 5;
  const avg = valid.reduce((s, n) => s + n, 0) / valid.length;
  const strength = Math.min(1, Math.log10(avg + 1) / 6.5);
  return Math.round(5 + strength * 95);
}

// Медиана log-нормализованных значений (устойчивее к выбросам, чем среднее).
function medianLogNorm(vals: number[], floor: number, ceil: number): number {
  const logs = vals
    .filter((n) => n > 0)
    .map((n) => logNorm(n, floor, ceil))
    .sort((a, b) => a - b);
  if (logs.length === 0) return 0;
  const mid = Math.floor(logs.length / 2);
  return logs.length % 2 ? logs[mid]! : (logs[mid - 1]! + logs[mid]!) / 2;
}

// Difficulty для Google Play: главный сигнал — installs (есть только у GP).
// Потолок 1B даёт разброс даже среди гигантов: 500M→~0.97, 10M→~0.78 (а не всё в 100,
// как при расчёте только по отзывам с низким потолком). Пол (см. logNorm в
// signals.ts) убирает завышение нишевых ключей. Отзывы — вторичный сигнал.
// Синхронизировано с analytics/googleplay/difficulty.ts.
const GP_INSTALLS_FLOOR = 10_000;
const GP_INSTALLS_CEIL = 1_000_000_000;
const GP_RATINGS_FLOOR = 100;
const GP_RATINGS_CEIL = 5_000_000;

function gpDifficulty(apps: Array<{ ratings: number; minInstalls: number }>): number {
  if (apps.length === 0) return 5;
  const installs = medianLogNorm(apps.map((a) => a.minInstalls), GP_INSTALLS_FLOOR, GP_INSTALLS_CEIL);
  const ratings = medianLogNorm(apps.map((a) => a.ratings), GP_RATINGS_FLOOR, GP_RATINGS_CEIL);
  // Если установок нет (старый кэш без minInstalls) — падаем на отзывы.
  const strength = installs > 0 ? installs * 0.6 + ratings * 0.4 : ratings;
  return Math.round(5 + Math.min(1, strength) * 95);
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
 *   1) seeds = title + description + genre + bigrams + конкуренты (включая
 *      связанные приложения от Apple) + жанры на языке витрины;
 *   2) BFS расширение через autocomplete — небольшая глубина, чтобы
 *      подсказки не «уплывали» в нерелевантную тематику;
 *   3) в кандидаты идут ВСЕ подсказки; пересечение токенов с приложением
 *      решает лишь то, раскручивать ли подсказку дальше. Релевантность
 *      определяется после замера: ранг доказывает её сам, безранговые
 *      чистят LLM-проход и coreRelevant.
 */
async function buildCandidates(
  title: string,
  genre: string,
  country: string,
  platform: 'ios' | 'android',
  description = '',
  competitorTitles: string[] = [],
  competitorDescriptions: string[] = [],
  nicheTerms: string[] = [],
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  const suggestFn = platform === 'android' ? gpSuggest : suggest;
  // Сигнал спроса по термину: лучшая (наивысшая) позиция в подсказках Apple,
  // нормированная в [0..1]. Собираем по ходу BFS — это бесплатный сигнал спроса.
  const autocompleteSignals = new Map<string, number>();

  const titleWords = words(title);
  const descWords = topWords(description, 60);
  const genreWords = words(genre);
  const compWords = topWords(competitorTitles.join(' '), 40);
  // Майнинг ключей конкурентов: их title+description вылизаны под ASO, поэтому
  // частотные слова из них — это ключи, которые таргетит вся ниша (напр. для
  // кредитных приложений: мікрозайм, позика, гроші), даже если их нет в НАШЕМ
  // описании. Берём топ-частотные и прогоняем через autocomplete как сиды.
  const compDescWords = topWords(competitorDescriptions.join(' '), 50);
  // Жанры на языке витрины. Замер на fr показал, что сами по себе они дают
  // мало (их автокомплит — вся категория, а не ниша), но на неанглоязычных
  // витринах они ЗАМЕНЯЮТ английские жанры из iTunes lookup, по которым
  // локальный автокомплит почти пуст. Основную лексику ниши даёт не это,
  // а описания связанных приложений (compDescWords) — см. relatedIds ниже.
  const nicheWords = [...new Set(nicheTerms.flatMap((t) => words(t)))];

  // Пул «своих» токенов. Используется ТОЛЬКО для решения, стоит ли раскручивать
  // подсказку дальше (см. ниже) — на попадание в кандидаты он больше не влияет.
  const relevantTokens = new Set<string>([
    ...titleWords,
    ...descWords,
    ...genreWords,
    ...compWords,
    ...compDescWords,
    ...nicheWords,
  ]);

  const seedSet = new Set<string>([
    ...titleWords,
    ...descWords.slice(0, 40),
    ...genreWords,
    ...nicheWords,
    ...nicheTerms.map((t) => t.toLowerCase().trim()),
    ...compWords,
    ...compDescWords.slice(0, 30),
    genre.toLowerCase(),
  ].filter((w) => w && w.length >= 3));
  for (const bg of bigrams(titleWords)) seedSet.add(bg);
  for (const bg of bigrams(descWords.slice(0, 20))) seedSet.add(bg);
  // НЕ сидируем биграммами названий конкурентов — это их БРЕНДЫ ("squad busters",
  // "brawl stars"), а не родовые запросы про наше приложение. Родовые ниши берём
  // из ОПИСАНИЙ конкурентов (compDescWords) и нашего описания. Бренды-одиночки,
  // просочившиеся через compWords, отсекает LLM-фильтр релевантности ниже.

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
      const listLen = Math.max(hints.length, 1);
      for (let idx = 0; idx < hints.length; idx++) {
        const hl = hints[idx].toLowerCase().trim();
        if (hl.length < 3 || hl.length > 60) continue;
        // Сигнал спроса: чем выше термин в подсказках, тем популярнее запрос.
        // Запоминаем лучший сигнал по термину (он мог встретиться в нескольких списках).
        const sig = 1 - idx / listLen;
        if (sig > (autocompleteSignals.get(hl) ?? 0)) autocompleteSignals.set(hl, sig);
        if (candidates.has(hl)) continue;
        // Кандидатом становится ЛЮБАЯ подсказка: ранг сам докажет релевантность
        // (так не теряются ключи без общих токенов с приложением — "21", "vegas"
        // для блэкджека), а безранговый мусор снимут LLM-проход и coreRelevant.
        candidates.add(hl);
        // А вот РАСКРУЧИВАТЬ дальше имеет смысл только релевантные: расширение
        // случайной подсказки уводит в чужую тематику ("cartes" → "cartes
        // vitales" → "carte vitale ameli") и жжёт бюджет замеров впустую.
        if (isRelevant(hl)) next.push(hl);
        if (candidates.size >= MAX_KEYWORDS) break;
      }
      if (candidates.size >= MAX_KEYWORDS) break;
    }
    frontier = next.slice(0, FRONTIER_LIMIT);
    depth++;
  }
  // Фильтр качества: одиночные слова — ок, многословные фразы — только
  // подтверждённые автокомплитом или биграммы из названия приложения.
  // ВАЖНО: жёсткий core-фильтр здесь НЕ применяем — он резал синонимы и бренды
  // конкурентов ("мікрозайм", "позика", "moneyveo"), по которым приложение реально
  // ранжируется. Релевантность решаем после замеров: ранжированные оставляем всегда,
  // безранговые чистит LLM-проход (или эвристика ядра как фолбэк).
  const titleBigramSet = new Set(bigrams(words(title)));
  return {
    candidates: [...candidates]
      .filter((c) => c.length >= 3 && isQualityCandidate(c, autocompleteSignals, titleBigramSet))
      .slice(0, MAX_KEYWORDS),
    autocompleteSignals,
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

async function iosKeywordData(
  term: string, country: string, autocompleteSignal = 0,
): Promise<KeywordData> {
  return cachedKeyword('ios', country, term, async () => {
    const ids = await nativeSearchIds(term, country);
    // Кэшированный lookup: топовые приложения повторяются между ключами,
    // поэтому повторные id не порождают новых запросов к iTunes.
    const top = await lookupAppsCached(ids.slice(0, 10), country);
    return {
      ids,
      totalResults: ids.length,
      volume: demandFromSignals(autocompleteSignal, ids.length, term),
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
    // Текст ошибки ДОЛЖЕН доходить до клиента: без него расширение показывает
    // generic «Analysis failed» и причину (бан IP, гео и т.п.) не видно никому.
    error: row.error,
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
    // «Ядро» релевантности приложения (название+жанр+топ описания). Считается в
    // ОБОИХ путях (и кэш, и свежий) из метаданных приложения, поэтому фильтр
    // релевантности работает даже когда кандидаты пришли из кэша.
    let coreTokens: Set<string> = new Set();
    // Контекст приложения для LLM-прохода релевантности (если подключён ключ).
    let appContext: RelevanceAppContext = { title: appId, genre: '' };
    // Сигналы спроса по терминам (autocomplete). Заполняются в свежем BFS;
    // на кэш-пути (useCached) пустые — тогда demand берётся уже из keyword_cache.
    let autocompleteSignals: Map<string, number> = new Map();
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
      coreTokens = new Set<string>([
        ...words(app.title), ...words(app.genre),
        ...topWords(`${app.summary} ${app.description}`, 20),
      ]);
      appContext = { title: app.title, genre: app.genre, description: `${app.summary} ${app.description}`.trim() };
      if (useCached) {
        candidates = persisted;
      } else {
        // Майнинг конкурентов по нескольким сидам (название, топ-слово, жанр).
        const compSeeds = [...new Set(
          [app.title, ...words(app.title).slice(0, 2), app.genre]
            .map((s) => s.trim()).filter((s) => s.length >= 3),
        )];
        const compLists = await mapLimit(compSeeds, 3, (s) =>
          gpSearch(s, country, 20).catch(() => [] as Awaited<ReturnType<typeof gpSearch>>));
        const seen = new Set<string>();
        const competitors = compLists.flat().filter((c) => {
          if (c.appId === appId || seen.has(c.appId)) return false;
          seen.add(c.appId); return true;
        }).slice(0, 15);
        const competitorTitles = competitors.map((c) => c.title);
        // У Google Play search в выдаче есть summary — используем как мини-описание.
        const competitorDescriptions = competitors.map((c) => c.summary ?? '');
        const desc = `${app.summary} ${app.description}`.trim();
        const built = await buildCandidates(
          app.title, app.genre, country, 'android', desc, competitorTitles, competitorDescriptions,
        );
        candidates = built.candidates;
        autocompleteSignals = built.autocompleteSignals;
      }
    } else {
      const app = await appLookup(Number(appId), country);
      if (!app) throw new Error('Приложение не найдено в App Store для этого гео');
      title = app.title;
      coreTokens = new Set<string>([
        ...words(app.title),
        ...words(`${app.primaryGenre} ${(app.genres ?? []).join(' ')}`),
        ...topWords(app.description ?? '', 20),
      ]);
      appContext = {
        title: app.title,
        genre: `${app.primaryGenre} ${(app.genres ?? []).join(' ')}`.trim(),
        description: app.description ?? '',
      };
      if (useCached) {
        candidates = persisted;
      } else {
        // Майнинг конкурентов: ищем по нескольким сидам (название, топ-слова
        // названия, жанр) и объединяем выдачу — в конкуренты попадают разные
        // игроки ниши, а не только «копии» по полному названию.
        const compSeeds = [...new Set(
          [app.title, ...words(app.title).slice(0, 2), app.primaryGenre]
            .map((s) => s.trim()).filter((s) => s.length >= 3),
        )];
        // Нишевой контекст от самой Apple: «покупают также» + топ категории и
        // жанры на языке витрины. Это единственный источник, описывающий НИШУ,
        // а не приложение, — от названия до этих слов автокомплитом не дойти.
        // Замер (Blackjack/fr): описания связанных приложений дают лексику
        // roulette/poker/vegas/craps/jetons, а с ней +14 ранжированных ключей,
        // которых прежний генератор не мог сгенерировать в принципе.
        const [idLists, page] = await Promise.all([
          mapLimit(compSeeds, 4, (s) => nativeSearchIds(s, country).catch(() => [] as string[])),
          nativeAppPage(appId, country),
        ]);
        // Связанные приложения от Apple идут ПЕРВЫМИ: они точнее выдачи по
        // собственному названию, где полно однофамильцев из других ниш.
        const competitorIds = [...new Set([...(page?.relatedIds ?? []), ...idLists.flat()])]
          .filter((id) => id !== String(appId)).slice(0, 20);
        const competitors = competitorIds.length
          ? await lookupApps(competitorIds, country).catch(() => [])
          : [];
        const competitorTitles = competitors.map((c) => c.title);
        const competitorDescriptions = competitors.map((c) => c.description ?? '');
        const genres = (app.genres ?? []).join(' ');
        const built = await buildCandidates(
          app.title,
          `${app.primaryGenre} ${genres}`,
          country,
          'ios',
          app.description,
          competitorTitles,
          competitorDescriptions,
          page?.genreNames ?? [],
        );
        candidates = built.candidates;
        autocompleteSignals = built.autocompleteSignals;
      }
    }
    // LLM-проход релевантности (если подключён ANTHROPIC_API_KEY): отсекает
    // off-topic запросы, которые делят токен с приложением, но про другой продукт
    // ("channels dvr" для YouTube). Один вызов на список кандидатов, до замеров —
    // заодно экономит запросы к Apple. Без ключа/при сбое остаётся эвристика.
    let llmFiltered = false;
    try {
      const keep = await llmRelevantTerms(appContext, candidates);
      if (keep) { candidates = candidates.filter((c) => keep.has(c.toLowerCase())); llmFiltered = true; }
    } catch {
      // LLM недоступен — не критично, ниже работает эвристика ядра для безранговых.
    }

    await updateDiscoveryJob(jobId, { appTitle: title, total: candidates.length });

    // --- Внешние источники спроса (один батч на весь список — дёшево) ------
    // iOS: НАСТОЯЩАЯ popularity из дашборда Apple Search Ads (та же шкала
    // 5-100, что у FoxData) — если есть, она ЗАМЕНЯЕТ эвристический volume.
    const asaVolumes = new Map<string, number>();
    if (platform === 'ios' && isAsaDashConfigured()) {
      try {
        const rows = await keywordPopularity(candidates, country.toUpperCase());
        for (const r of rows) if (r.popularity !== null) asaVolumes.set(r.keyword, r.popularity);
      } catch (e) {
        console.error(
          `[asa] batch popularity недоступна (${e instanceof Error ? e.message : e}) — ` +
            'volume по эвристике. Обнови сессию .asa-session.json!',
        );
      }
    }
    // Android: web-объёмы Keyword Planner — подмешиваются в demandFromSignals.
    let webVolumes = new Map<string, number | null>();
    if (platform === 'android' && isGoogleAdsConfigured()) {
      try {
        webVolumes = await keywordSearchVolumes(candidates, country);
      } catch (e) {
        console.warn(`[gads] web-объёмы недоступны: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Финальная сборка. Главное правило: РАНЖИРОВАННЫЕ ключи не отсекаем никогда —
    // сам факт ранга доказывает релевантность (так не теряем "мікрозайм", "позика"
    // и т.п., которых нет в названии/описании). Эвристику ядра применяем только к
    // безранговым возможностям и только если LLM не почистил кандидаты (иначе
    // эвристика срезала бы синонимы).
    const MIN_DEMAND_UNRANKED = 30;
    const finalize = (list: UrlKeyword[]): UrlKeyword[] => {
      const kept = list.filter((k) => {
        if (k.rank != null) return true; // ранг доказывает релевантность — не режем
        // Безранговая возможность: достаточный спрос + релевантность (LLM или эвристика ядра).
        const relevant = llmFiltered || coreRelevant(k.term, coreTokens);
        if (useCached) return relevant; // на кэш-пути сигнала объёма нет
        return (k.volume ?? 0) >= MIN_DEMAND_UNRANKED && relevant;
      });
      return sortKeywords(kept);
    };

    const cachedLookup = async (id: string): Promise<GpAppInfo | null> => {
      if (appCache.has(id)) return appCache.get(id) ?? null;
      const info = await gpAppLookup(id, country);
      appCache.set(id, info);
      return info;
    };

    async function processKeyword(term: string): Promise<UrlKeyword | null> {
      try {
        const signal = autocompleteSignals.get(term) ?? 0;
        if (platform === 'android') {
          const data = await cachedKeyword('android', country, term, async () => {
            const results = await gpSearch(term, country, 250);
            const top = (
              await Promise.all(results.slice(0, 5).map((a) => cachedLookup(a.appId)))
            ).filter((a): a is GpAppInfo => Boolean(a));
            return {
              ids: results.map((a) => a.appId),
              totalResults: results.length,
              volume: demandFromSignals(signal, results.length, term, webVolumes.get(term.toLowerCase())),
              difficulty: gpDifficulty(top),
            };
          });
          const idx = data.ids.indexOf(appId);
          return {
            term, rank: idx === -1 ? null : idx + 1,
            totalResults: data.totalResults, volume: data.volume,
            saturation: saturationFromResults(data.totalResults), difficulty: data.difficulty,
          };
        }
        const data = await iosKeywordData(term, country, signal);
        const idx = data.ids.indexOf(appId);
        // Настоящая ASA popularity (если получена батчем выше) заменяет эвристику.
        const asa = asaVolumes.get(term.toLowerCase());
        return {
          term, rank: idx === -1 ? null : idx + 1,
          totalResults: data.totalResults, volume: asa ?? data.volume,
          saturation: saturationFromResults(data.totalResults), difficulty: data.difficulty,
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
        keywords: finalize([...found]),
      });
    }

    // Если выдача пустая по ВСЕМ ключам — это не «приложение нигде не ранжируется»,
    // а магазин не отдал результаты (блокировка/лимит). Чаще на Google Play с
    // серверных IP. Честно падаем с понятной ошибкой, а не показываем
    // вводящие в заблуждение «не ранжируется + высокий спрос».
    const allEmpty = found.length > 0 && found.every((k) => (k.totalResults || 0) === 0);
    if ((found.length === 0 && candidates.length > 0) || allEmpty) {
      throw new Error(
        platform === 'android'
          ? 'Google Play не отдал выдачу (вероятно, ограничение запросов с сервера) — позиции не измерены. Попробуйте позже.'
          : 'Магазин ограничил запросы — не удалось получить выдачу. Попробуйте позже.',
      );
    }

    // Свежий путь: сигнал+релевантность. Кэш-путь: фильтр сигнала пропускаем
    // (кандидаты уже отфильтрованы при первом прогоне), но релевантность по ядру
    // применяем всегда — чтобы старый мусор из словаря не доезжал до пользователя.
    const finalKeywords = finalize([...found]);

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
    const msg = e instanceof Error ? e.message : 'ошибка обработки';
    await updateDiscoveryJob(jobId, {
      status: 'error',
      error: msg,
    }).catch(() => {});
    // Упавший анализ = пользователь увидел «Scan failed». Владелец должен
    // узнать сразу (дедуп по тексту — волна одинаковых ошибок шлётся один раз).
    notify(`❌ Discovery job #${jobId} (${platform}/${appId}/${country}): ${msg}`, `job-err:${msg.slice(0, 60)}`);
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
