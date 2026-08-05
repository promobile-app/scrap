import { appLookup, suggest } from '../scrapers/appstore.js';
import { nativeAppPage, nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest } from '../scrapers/googleplay.js';
import { STOP_WORDS } from './stopWords.js';
import { corpusCandidates, feedCorpus, SERP_FRESH_HOURS } from './corpus.js';

export interface DiscoveredKeyword {
  term: string;
  rank: number | null;
  totalResults: number;
  volumeScore: number;     // СПРОС (autocomplete-взвешенный), как в volume.ts
  saturationScore: number; // насыщенность выдачи (предложение/конкуренция)
}

export interface DiscoveryResult {
  appId: number | string; // iOS trackId (число) или Android package name (строка)
  title: string;
  country: string;
  keywords: DiscoveredKeyword[];
}

/**
 * Насыщенность выдачи (5-100) — сигнал ПРЕДЛОЖЕНИЯ (сколько приложений в нише).
 * Это НЕ спрос: коррелирует с difficulty. Раньше отдавалось как «объём».
 */
function saturationFromResults(total: number): number {
  const signal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  return Math.round(5 + signal * 95);
}

/**
 * Оценка СПРОСА (5-100) — как estimateVolume в analytics/volume.ts:
 * autocomplete-сигнал (вес 0.6) + насыщенность (0.4) + штраф за длинный хвост.
 * autocompleteSignal ∈ [0..1] собирается бесплатно на этапе autocomplete-расширения.
 */
function demandFromSignals(autocompleteSignal: number, total: number, term: string): number {
  const resultSignal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  const wordCount = term.trim().split(/\s+/).filter(Boolean).length;
  const lengthPenalty = wordCount >= 4 ? 0.6 : wordCount === 3 ? 0.8 : 1;
  const raw = (autocompleteSignal * 0.6 + resultSignal * 0.4) * lengthPenalty;
  return Math.round(5 + raw * 95);
}

/**
 * Нормализованные слова из строки. Юникод-осознанно: кириллические и прочие
 * не-латинские названия («Spotify: музика та подкасти») не должны схлопываться
 * в пустоту, иначе для таких приложений нет сид-слов.
 */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Параллельный map с ограничением concurrency (как p-limit). */
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

// In-memory TTL cache для выдачи по ключу. Сбрасывается при рестарте,
// но в пределах одного анализа / дашборд-сессии экономим N Apple-запросов
// когда пользователь быстро переключается между ключами.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 2000;
const idsCache = new Map<string, { value: string[]; expires: number }>();

function cacheGet(key: string): string[] | undefined {
  const e = idsCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) { idsCache.delete(key); return undefined; }
  return e.value;
}
function cacheSet(key: string, value: string[]): void {
  if (idsCache.size >= CACHE_MAX) {
    const oldest = idsCache.keys().next().value;
    if (oldest !== undefined) idsCache.delete(oldest);
  }
  idsCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

type SuggestFn = (term: string, country: string) => Promise<string[]>;

// Потолок кандидатов на приложение. Каждый кандидат — отдельный поиск в сторе,
// поэтому это главный регулятор «полнота индексации против времени ответа».
// Android ниже: там проверка — это gpSearch, а Google быстрее отдаёт капчу.
const IOS_MAX_CANDIDATES = Number(process.env.DISCOVERY_MAX_CANDIDATES ?? 300);
const GP_MAX_CANDIDATES = Number(process.env.DISCOVERY_MAX_CANDIDATES_GP ?? 120);

// Ширина генерации: сколько подсказок берём с каждого сида и сколько сидов
// уходит во вторую волну. Поднимать вместе с потолком — иначе кандидатов
// физически не наберётся столько, сколько разрешает cap.
const HINTS_PER_SEED = Number(process.env.DISCOVERY_HINTS_PER_SEED ?? 20);
const SEED_LIMIT = Number(process.env.DISCOVERY_SEED_LIMIT ?? 25);
const SECOND_WAVE_SEEDS = Number(process.env.DISCOVERY_SECOND_WAVE_SEEDS ?? 20);

/**
 * Частотные слова и биграммы из описания приложения — самый богатый
 * источник кандидатов для индексации: разработчик сам перечисляет там,
 * по каким запросам хочет находиться.
 */
function descriptionTerms(description: string): { words: string[]; bigrams: string[] } {
  const tokens = words(description);
  if (!tokens.length) return { words: [], bigrams: [] };

  const wordFreq = new Map<string, number>();
  for (const t of tokens) wordFreq.set(t, (wordFreq.get(t) ?? 0) + 1);

  const bigramFreq = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const b = `${tokens[i]} ${tokens[i + 1]}`;
    bigramFreq.set(b, (bigramFreq.get(b) ?? 0) + 1);
  }

  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
  // Биграммы, встречающиеся хотя бы дважды, — разовые сочетания почти
  // всегда шум связного текста, а не ключевая фраза.
  const topBigrams = [...bigramFreq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([b]) => b);

  return { words: topWords, bigrams: topBigrams };
}

/**
 * Генерация кандидатов ключевых слов для приложения.
 * Источники: название, жанр, описание (частотные слова и биграммы),
 * autocomplete-расширения сид-слов и вторая волна подсказок по лучшим хинтам.
 * Платформо-независимо: autocomplete-источник передаётся параметром
 * (Apple Search Hints для iOS, gplay.suggest для Android).
 */
async function buildCandidatesWith(
  suggestFn: SuggestFn,
  title: string,
  genre: string,
  country: string,
  description = '',
  maxCandidates = IOS_MAX_CANDIDATES,
  nicheTerms: string[] = [],
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  // Жанры на языке витрины: на неанглоязычной витрине они заменяют английские
  // жанры из iTunes lookup, по которым локальный автокомплит почти пуст.
  const nicheWords = [...new Set(nicheTerms.flatMap((t) => words(t)))];
  const titleGenreSeeds = [...new Set([...words(title), ...words(genre), ...nicheWords])].slice(0, 15);
  const desc = descriptionTerms(description);

  const candidates = new Set<string>([
    ...titleGenreSeeds,
    genre.toLowerCase(),
    ...nicheTerms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3),
    ...desc.words,
    ...desc.bigrams,
  ]);
  // Сигнал спроса по термину: позиция в подсказках стора, нормированная в [0..1].
  const autocompleteSignals = new Map<string, number>();

  // Биграммы из названия (например "photo editor").
  const titleWords = words(title);
  for (let i = 0; i < titleWords.length - 1; i++) {
    candidates.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  const collectHints = async (seedList: string[]): Promise<string[]> => {
    const hintLists = await mapLimit(seedList, 4, (seed) =>
      suggestFn(seed, country).catch(() => [] as string[]),
    );
    const collected: string[] = [];
    for (const hints of hintLists) {
      const listLen = Math.max(hints.length, 1);
      hints.slice(0, HINTS_PER_SEED).forEach((h, idx) => {
        const hl = h.toLowerCase().trim();
        const sig = 1 - idx / listLen;
        if (sig > (autocompleteSignals.get(hl) ?? 0)) autocompleteSignals.set(hl, sig);
        candidates.add(h);
        collected.push(hl);
      });
    }
    return collected;
  };

  // Расширения через autocomplete стора: сиды из названия/жанра + верх описания.
  const seeds = [...new Set([...titleGenreSeeds, ...desc.words.slice(0, 6)])].slice(0, SEED_LIMIT);
  const firstWave = await collectHints(seeds);

  // Вторая волна: подсказки по лучшим хинтам первой волны — так достаются
  // длиннохвостые фразы, которых нет ни в названии, ни в описании.
  const secondWaveSeeds = [...new Set(firstWave)]
    .filter((h) => !seeds.includes(h))
    .slice(0, SECOND_WAVE_SEEDS);
  await collectHints(secondWaveSeeds);

  return {
    candidates: [...candidates].filter((c) => c.length >= 3).slice(0, maxCandidates),
    autocompleteSignals,
  };
}

async function buildCandidates(
  title: string,
  genre: string,
  country: string,
  description = '',
  nicheTerms: string[] = [],
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  return buildCandidatesWith(suggest, title, genre, country, description, IOS_MAX_CANDIDATES, nicheTerms);
}

/** Сортировка выдачи discovery: сначала где приложение в топе, затем по спросу. */
function sortDiscovered(keywords: DiscoveredKeyword[]): void {
  keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volumeScore - a.volumeScore;
  });
}

/**
 * FoxData-стиль: по приложению и гео возвращает ключевые слова,
 * по которым приложение ранжируется, с позицией и оценкой объёма.
 *
 * Параллельно (concurrency=8) вместо последовательного цикла —
 * ключевое ускорение Phase 1. С in-memory кэшем идемпотентно.
 */
export async function discoverKeywords(
  appId: number,
  country = 'us',
): Promise<DiscoveryResult> {
  const app = await appLookup(appId, country);
  if (!app) throw new Error('Приложение не найдено в этом гео');

  // Жанры на языке витрины: для fr это «Cartes»/«Casino» вместо английских
  // «Card»/«Casino» из iTunes lookup — на локальной витрине сиды должны быть
  // на её языке, иначе автокомплит по ним почти пуст.
  const page = await nativeAppPage(appId, country);
  const { candidates, autocompleteSignals } = await buildCandidates(
    app.title, app.primaryGenre, country, app.description, page?.genreNames ?? [],
  );

  // Накопительный корпус гео: ключи, найденные через ДРУГИЕ приложения.
  // SERP-хиты (приложение уже видели в кэшированной выдаче) — почти
  // гарантированная индексация; token-match — проверяемая часть словаря.
  const coreTokens = new Set<string>([
    ...words(app.title), ...words(app.primaryGenre),
    ...(page?.genreNames ?? []).flatMap((g) => words(g)),
    ...descriptionTerms(app.description ?? '').words,
  ]);
  const corpus = await corpusCandidates(
    'ios', String(appId), country,
    coreTokens, new Set(candidates.map((c) => c.toLowerCase().trim())),
  );
  // Свежие кэшированные выдачи кладём в ids-кэш: их ранк отдаётся без
  // единого запроса к Apple — это и делает корпусную проверку дешёвой.
  for (const [term, hit] of corpus.serpHits) {
    if (hit.ageHours < SERP_FRESH_HOURS) cacheSet(`${country}|${term}`, hit.ids);
  }
  const allTerms = [...candidates, ...corpus.terms];
  feedCorpus('ios', country, allTerms);

  // Параллельный сбор ранков: ×6-8 быстрее чем for-await.
  // Apple channel pool в native.ts сам разрулит slot-throttling.
  const keywords: DiscoveredKeyword[] = (
    await mapLimit(allTerms, 8, async (term): Promise<DiscoveredKeyword | null> => {
      const cacheKey = `${country}|${term.toLowerCase()}`;
      let ids = cacheGet(cacheKey);
      if (!ids) {
        try {
          ids = await nativeSearchIds(term, country);
          cacheSet(cacheKey, ids);
        } catch {
          return null;
        }
      }
      const idx = ids.indexOf(String(appId));
      const signal = autocompleteSignals.get(term.toLowerCase().trim()) ?? 0;
      return {
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volumeScore: demandFromSignals(signal, ids.length, term),
        saturationScore: saturationFromResults(ids.length),
      };
    })
  ).filter((k): k is DiscoveredKeyword => k !== null);

  sortDiscovered(keywords);

  return { appId, title: app.title, country, keywords };
}

/**
 * Android-вариант discovery: то же, что discoverKeywords, но на примитивах
 * Google Play (gpAppLookup / gpSuggest / gpSearch). Особенности платформы:
 * веб-выдача Play отдаёт только первую «страницу» (~15-30 приложений, см.
 * gpSearch), поэтому rank=null означает «глубже выдачи», а totalResults
 * ограничен сверху; concurrency ниже (4), чтобы не ловить капчу Google.
 */
export async function discoverKeywordsGp(
  appId: string,
  country = 'us',
): Promise<DiscoveryResult> {
  const app = await gpAppLookup(appId, country);
  if (!app) throw new Error('Приложение не найдено в этом гео');

  // Кандидатов меньше, чем на iOS: каждая проверка — это gpSearch, а Google
  // при высокой частоте отдаёт капчу.
  const { candidates, autocompleteSignals } = await buildCandidatesWith(
    gpSuggest,
    app.title,
    app.genre,
    country,
    `${app.summary} ${app.description}`,
    GP_MAX_CANDIDATES,
  );

  // Корпус гео — как в iOS-варианте; свежие SERP-хиты не тратят запросы к Google.
  const coreTokens = new Set<string>([
    ...words(app.title), ...words(app.genre),
    ...descriptionTerms(`${app.summary} ${app.description}`).words,
  ]);
  const corpus = await corpusCandidates(
    'android', appId, country,
    coreTokens, new Set(candidates.map((c) => c.toLowerCase().trim())),
  );
  for (const [term, hit] of corpus.serpHits) {
    if (hit.ageHours < SERP_FRESH_HOURS) cacheSet(`gp|${country}|${term}`, hit.ids);
  }
  const allTerms = [...candidates, ...corpus.terms];
  feedCorpus('android', country, allTerms);

  const keywords: DiscoveredKeyword[] = (
    await mapLimit(allTerms, 4, async (term): Promise<DiscoveredKeyword | null> => {
      const cacheKey = `gp|${country}|${term.toLowerCase()}`;
      let ids = cacheGet(cacheKey);
      if (!ids) {
        try {
          const results = await gpSearch(term, country, 250);
          ids = results.map((a) => a.appId);
          cacheSet(cacheKey, ids);
        } catch {
          return null;
        }
      }
      const idx = ids.indexOf(appId);
      const signal = autocompleteSignals.get(term.toLowerCase().trim()) ?? 0;
      return {
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volumeScore: demandFromSignals(signal, ids.length, term),
        saturationScore: saturationFromResults(ids.length),
      };
    })
  ).filter((k): k is DiscoveredKeyword => k !== null);

  sortDiscovered(keywords);

  return { appId, title: app.title, country, keywords };
}
