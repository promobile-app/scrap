import { appLookup, lookupAppsCached, suggest } from '../scrapers/appstore.js';
import { nativeAppPage, nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest } from '../scrapers/googleplay.js';
import { STOP_WORDS } from './stopWords.js';
import {
  competitorSerpTerms, corpusCandidates, feedCorpus, SERP_FRESH_HOURS,
} from './corpus.js';
import { capRecheckTerms, deepRecheckEnabled, gpDeepRanks } from './gpDeepRank.js';
import { suggestMany } from './suggestCache.js';
import { getCachedKeyword, upsertCachedSerpBatch } from '../db/repo.js';

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
export function words(s: string): string[] {
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

/**
 * Выдача по ключу: память -> общий кэш в БД -> магазин.
 *
 * Раньше этот путь знал только про память: 5 минут, свой на каждый инстанс и
 * обнуляется редеплоем — то есть практически каждый клик по «Индексации»
 * заново оплачивал ВСЮ выдачу. Хуже того, снимки никуда не сохранялись, и
 * serpTermsContainingApp (самый дешёвый источник индексации — «приложение уже
 * видели в чужой выдаче») по этим данным не находил ничего.
 *
 * Теперь свежие снимки берутся из keyword_cache, а новые складываются туда же
 * пачкой (fresh) — каждый прогон удешевляет и обогащает все следующие.
 */
async function serpIds(
  platform: 'ios' | 'android',
  country: string,
  term: string,
  memKey: string,
  fetcher: () => Promise<string[]>,
  fresh: Map<string, string[]>,
): Promise<string[]> {
  const mem = cacheGet(memKey);
  if (mem) return mem;

  try {
    const row = await getCachedKeyword(platform, country, term, SERP_CACHE_TTL_HOURS);
    if (row?.ids?.length) {
      cacheSet(memKey, row.ids);
      return row.ids;
    }
  } catch {
    // БД недоступна/не мигрирована — общий кэш просто выключается.
  }

  const ids = await fetcher();
  cacheSet(memKey, ids);
  // Карта, а не список: один терм не должен попасть в батч-upsert дважды —
  // Postgres на такое отвечает «cannot affect row a second time».
  fresh.set(term, ids);
  return ids;
}

/**
 * Замер списка ключей: для каждого — выдача (кэш или магазин), позиция
 * приложения в ней и оценки спроса/насыщенности. Общая для обеих платформ,
 * различия закрыты параметрами memKeyOf/fetchIds.
 */
async function measureTerms(
  ctx: {
    platform: 'ios' | 'android';
    country: string;
    targetId: string;
    concurrency: number;
    memKeyOf: (normalized: string) => string;
    fetchIds: (term: string) => Promise<string[]>;
    autocompleteSignals: Map<string, number>;
    fresh: Map<string, string[]>;
  },
  terms: string[],
): Promise<DiscoveredKeyword[]> {
  if (!terms.length) return [];
  return (
    await mapLimit(terms, ctx.concurrency, async (term): Promise<DiscoveredKeyword | null> => {
      const normalized = term.toLowerCase().trim();
      let ids: string[];
      try {
        ids = await serpIds(
          ctx.platform, ctx.country, normalized, ctx.memKeyOf(normalized),
          () => ctx.fetchIds(term), ctx.fresh,
        );
      } catch {
        return null;
      }
      const idx = ids.indexOf(ctx.targetId);
      const signal = ctx.autocompleteSignals.get(normalized) ?? 0;
      return {
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volumeScore: demandFromSignals(signal, ids.length, term),
        saturationScore: saturationFromResults(ids.length),
      };
    })
  ).filter((k): k is DiscoveredKeyword => k !== null);
}

/**
 * Соседи по нише, выведенные из уже измеренных выдач: приложения, которые
 * чаще всего стоят рядом с нашим по ключам, где мы ранжируемся. Точнее
 * любого списка «похожих» от магазина — это фактическое соседство в выдаче.
 */
function competitorsFromSerps(
  measured: DiscoveredKeyword[],
  memKeyOf: (normalized: string) => string,
  ownId: string,
  topTerms = 30,
  topPerSerp = 10,
  maxCompetitors = 15,
): string[] {
  const freq = new Map<string, number>();
  const ranked = measured
    .filter((k) => k.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .slice(0, topTerms);

  for (const k of ranked) {
    const ids = cacheGet(memKeyOf(k.term.toLowerCase().trim()));
    if (!ids) continue;
    for (const id of ids.slice(0, topPerSerp)) {
      if (id === ownId) continue;
      freq.set(id, (freq.get(id) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCompetitors)
    .map(([id]) => id);
}

/** Батч-запись накопленных снимков. Ошибки глотаем: кэш — ускоритель. */
function flushSerpCache(
  platform: 'ios' | 'android', country: string, fresh: Map<string, string[]>,
): void {
  if (!fresh.size) return;
  upsertCachedSerpBatch(
    platform, country,
    [...fresh].map(([term, ids]) => ({ term, ids })),
  ).catch(() => {});
}

type SuggestFn = (term: string, country: string) => Promise<string[]>;

// Потолок кандидатов на приложение. Каждый кандидат — отдельный поиск в сторе,
// поэтому это главный регулятор «полнота индексации против времени ответа».
// Android ниже: там проверка — это gpSearch, а Google быстрее отдаёт капчу.
const IOS_MAX_CANDIDATES = Number(process.env.DISCOVERY_MAX_CANDIDATES ?? 1200);
const GP_MAX_CANDIDATES = Number(process.env.DISCOVERY_MAX_CANDIDATES_GP ?? 250);

/**
 * Сколько кандидатов ГЕНЕРИРУЕМ — в отличие от того, сколько измеряем.
 *
 * Это две разные цены. Генерация — это подсказки автокомплита
 * (MZSearchHints), эндпоинт, который за сутки принял 54 868 запросов без
 * единого троттлинга. Замер — это выдача (MZStore), которую Apple
 * рационирует по адресам и которой мы 19 августа выбили весь пул.
 *
 * Раньше обе ширины задавались одним числом: список резался ДО замера, и
 * всё, что не влезало, пропадало, хотя досталось почти даром. Теперь
 * урожай целиком уходит в накопительный словарь гео, а под замер идёт
 * приоритетная верхушка — сиды приложения и сильный автокомплит-сигнал.
 * Остальное измерится следующими прогонами из корпуса, по мере бюджета.
 */
const GEN_CANDIDATES = Number(process.env.DISCOVERY_GENERATE_CANDIDATES ?? 5000);

// Жёсткий потолок замеров за один прогон (кандидаты + корпус). Ограничивает
// худший случай по времени ответа: корпус гео растёт бесконечно, и без этого
// потолка через полгода один клик уходил бы в тысячи запросов к магазину.
const MAX_MEASURE = Number(process.env.DISCOVERY_MAX_MEASURE ?? 5000);

// Ширина генерации: сколько подсказок берём с каждого сида и сколько сидов
// уходит во вторую волну. Поднимать вместе с потолком — иначе кандидатов
// физически не наберётся столько, сколько разрешает cap.
const HINTS_PER_SEED = Number(process.env.DISCOVERY_HINTS_PER_SEED ?? 20);
const SEED_LIMIT = Number(process.env.DISCOVERY_SEED_LIMIT ?? 40);
const SECOND_WAVE_SEEDS = Number(process.env.DISCOVERY_SECOND_WAVE_SEEDS ?? 40);

// Алфавитное расширение — главный множитель кандидатов. Магазин отдаёт на
// префикс всего ~10 подсказок, поэтому «music» это 10 фраз, а «music a» …
// «music z» — уже сотни РАЗНЫХ реальных запросов (замер на витрине US: 10 против
// 254 уникальных). Стоимость — по одному запросу подсказок на букву, и он
// кэшируется на сутки (suggestCache.ts), так что платится один раз на гео.
const ALPHABET_SEEDS = Number(process.env.DISCOVERY_ALPHABET_SEEDS ?? 14);
const ALPHABET_SEEDS_GP = Number(process.env.DISCOVERY_ALPHABET_SEEDS_GP ?? 8);
const ALPHABET_SIZE = Number(process.env.DISCOVERY_ALPHABET_SIZE ?? 26);

// Конкурентность. Замеры ранков раньше шли в 8 потоков при пуле в 18 каналов ×
// 300 мс (~60 запросов/с) — то есть использовали шестую часть пропускной
// способности. Android заметно ниже: там замер это gpSearch, а Google быстро
// отвечает капчей.
const RANK_CONCURRENCY = Number(process.env.DISCOVERY_CONCURRENCY_IOS ?? 32);
const RANK_CONCURRENCY_GP = Number(process.env.DISCOVERY_CONCURRENCY_ANDROID ?? 6);
const SUGGEST_CONCURRENCY = Number(process.env.DISCOVERY_SUGGEST_CONCURRENCY ?? 16);

// Сколько соседей по нише разбираем на лексику. Их title+description вылизаны
// под ASO, поэтому частотные слова оттуда — это запросы, которые таргетит вся
// ниша, даже если в НАШЕМ описании их нет.
const COMPETITOR_APPS = Number(process.env.DISCOVERY_COMPETITOR_APPS ?? 12);

// Свежесть SERP-снимка в общем кэше, при которой ранк можно отдавать без
// перезамера. Согласовано с SERP_FRESH_HOURS в corpus.ts — это одно и то же
// окно, и расхождение означало бы, что корпусные хиты считаются годными, а
// те же самые термы при замере перезапрашиваются.
const SERP_CACHE_TTL_HOURS = Number(process.env.DISCOVERY_SERP_TTL_HOURS ?? 24);

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
 * Алфавит для расширения префиксов, выведенный из лексики самого приложения:
 * берём первые буквы слов его метаданных по частоте. Так расширение
 * автоматически идёт на языке витрины (для ua — кириллица, для jp — кана),
 * без карты «страна -> алфавит», которая всё равно врёт для двуязычных гео.
 *
 * Если своих букв мало (короткие метаданные, иероглифика) — добираем
 * латиницей: заметная часть запросов на любой витрине пишется латиницей
 * (бренды, англоязычные жанры).
 */
const LATIN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Стоит ли вообще тратить на фразу замер в магазине. Алфавитное расширение
 * вытаскивает из автокомплита и мусор — домены («audiobooks.com») и слишком
 * длинные фразы, — а каждый такой кандидат это отдельный запрос к магазину.
 * Фильтр намеренно мягкий: релевантность доказывает ранг, а не эвристика.
 */
export function isMeasurable(term: string): boolean {
  const t = term.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (/[./@]|https?:/i.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length <= 5;
}

export function expansionAlphabet(texts: string[], max = ALPHABET_SIZE): string[] {
  const freq = new Map<string, number>();
  for (const text of texts) {
    // Своя токенизация, а не words(): для алфавита важны все слова, включая
    // короткие и стоп-слова — они тоже показывают, каким письмом пишет витрина.
    for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      const ch = [...w][0];
      if (ch && /\p{L}/u.test(ch)) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
  }
  const observed = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([c]) => c);
  if (observed.length >= 10) return observed;
  return [...new Set([...observed, ...LATIN_ALPHABET])].slice(0, max);
}

/**
 * Генерация кандидатов ключевых слов для приложения.
 * Источники: название, подзаголовок, жанр, описание (частотные слова и
 * биграммы), лексика соседей по нише, autocomplete-расширения сид-слов,
 * алфавитное расширение лучших сидов и вторая волна подсказок.
 * Платформо-независимо: autocomplete-источник передаётся параметром
 * (Apple Search Hints для iOS, gplay.suggest для Android).
 */
export async function buildCandidatesWith(
  platform: 'ios' | 'android',
  /** Запрос подсказок с уже замкнутыми страной и языком витрины. */
  suggestFn: (term: string) => Promise<string[]>,
  title: string,
  genre: string,
  country: string,
  description = '',
  maxCandidates = IOS_MAX_CANDIDATES,
  nicheTerms: string[] = [],
  subtitle = '',
  competitorText = '',
  alphabetSeeds = ALPHABET_SEEDS,
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  // Жанры на языке витрины: на неанглоязычной витрине они заменяют английские
  // жанры из iTunes lookup, по которым локальный автокомплит почти пуст.
  const nicheWords = [...new Set(nicheTerms.flatMap((t) => words(t)))];
  const titleWords = words(title);
  const subtitleWords = words(subtitle);
  const desc = descriptionTerms(description);
  // Лексика ниши от соседей: отдельным блоком, чтобы не размывать частотность
  // собственного описания приложения.
  const competitor = descriptionTerms(competitorText);

  const titleGenreSeeds = [...new Set([
    ...titleWords, ...subtitleWords, ...words(genre), ...nicheWords,
  ])].slice(0, 20);

  const candidates = new Set<string>([
    ...titleGenreSeeds,
    genre.toLowerCase(),
    ...nicheTerms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3),
    ...desc.words,
    ...desc.bigrams,
    ...competitor.words,
  ]);
  // Сигнал спроса по термину: позиция в подсказках стора, нормированная в [0..1].
  const autocompleteSignals = new Map<string, number>();

  // Биграммы из названия и подзаголовка (например "photo editor").
  for (const src of [titleWords, subtitleWords]) {
    for (let i = 0; i < src.length - 1; i++) {
      candidates.add(`${src[i]} ${src[i + 1]}`);
    }
  }

  const collectHints = async (prefixes: string[]): Promise<string[]> => {
    const lists = await suggestMany(
      platform, country, prefixes, suggestFn, SUGGEST_CONCURRENCY,
    );
    const collected: string[] = [];
    for (const hints of lists.values()) {
      const listLen = Math.max(hints.length, 1);
      hints.slice(0, HINTS_PER_SEED).forEach((h, idx) => {
        const hl = h.toLowerCase().trim();
        if (hl.length < 3) return;
        const sig = 1 - idx / listLen;
        if (sig > (autocompleteSignals.get(hl) ?? 0)) autocompleteSignals.set(hl, sig);
        // В кандидаты кладём нормализованную форму: раньше сюда шёл сырой
        // хинт, и "Music"/"music" мерились как два разных ключа.
        candidates.add(hl);
        collected.push(hl);
      });
    }
    return collected;
  };

  // Волна 1 — подсказки по сидам из названия/жанра/ниши + верх описания и
  // лексики конкурентов.
  const seeds = [...new Set([
    ...titleGenreSeeds,
    ...desc.words.slice(0, 10),
    ...competitor.words.slice(0, 10),
  ])].slice(0, SEED_LIMIT);
  const seedSet = new Set(seeds);
  const firstWave = await collectHints(seeds);

  // Волна 2 — алфавитное расширение: главный источник объёма. Каждый сид
  // раскрывается в «сид + буква», и магазин отдаёт по 10 подсказок на КАЖДУЮ
  // букву вместо 10 на весь сид.
  const alphabet = expansionAlphabet(
    [title, subtitle, genre, description, nicheTerms.join(' ')],
  );
  const alphaPrefixes: string[] = [];
  for (const seed of seeds.slice(0, alphabetSeeds)) {
    for (const letter of alphabet) alphaPrefixes.push(`${seed} ${letter}`);
  }
  const alphaWave = await collectHints(alphaPrefixes);

  // Волна 3 — подсказки по лучшим хинтам предыдущих волн: так достаются
  // длиннохвостые фразы, которых нет ни в названии, ни в описании.
  const secondWaveSeeds = [...new Set([...firstWave, ...alphaWave])]
    .filter((h) => !seedSet.has(h))
    .sort((a, b) => (autocompleteSignals.get(b) ?? 0) - (autocompleteSignals.get(a) ?? 0))
    .slice(0, SECOND_WAVE_SEEDS);
  await collectHints(secondWaveSeeds);

  // Отбор под потолок: кандидатов теперь генерируется кратно больше, чем можно
  // измерить, поэтому важно ЧТО именно обрежет slice. Сначала сиды (лексика
  // самого приложения), дальше — по силе автокомплит-сигнала.
  const ranked = [...candidates]
    .filter((c) => isMeasurable(c))
    .sort((a, b) => {
      const sa = (seedSet.has(a) ? 2 : 0) + (autocompleteSignals.get(a) ?? 0);
      const sb = (seedSet.has(b) ? 2 : 0) + (autocompleteSignals.get(b) ?? 0);
      return sb - sa;
    });

  return { candidates: ranked.slice(0, maxCandidates), autocompleteSignals };
}

/**
 * Прежний генератор кандидатов — две волны подсказок без алфавитного
 * расширения, без подзаголовка и без лексики соседей. Давал ~275 кандидатов
 * на приложение (замер: Spotify/US) и был главным ограничителем полноты
 * индексации. Оставлен для сравнения замеров.
 */
export async function buildCandidatesWith_old(
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
  subtitle = '',
  competitorText = '',
  language?: string,
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  return buildCandidatesWith(
    'ios',
    (term) => suggest(term, country, language),
    title, genre, country, description,
    // Потолок генерации, не замера: обрезать урожай здесь значит выбросить
    // ключи, которые уже оплачены подсказками.
    GEN_CANDIDATES, nicheTerms, subtitle, competitorText, ALPHABET_SEEDS,
  );
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
  language?: string,
): Promise<DiscoveryResult> {
  const app = await appLookup(appId, country);
  if (!app) throw new Error('Приложение не найдено в этом гео');

  // Язык витрины здесь нужен ТОЛЬКО ради метаданных: жанры и подзаголовок
  // приходят на нём, и от них зависят сид-слова. Ни выдача, ни подсказки от
  // него не зависят — проверено сравнением ответов на `143443,29` и
  // `143443-2,29` (DE, немецкий против английского): списки совпадают
  // побайтно. Поэтому кэши и корпус ключуются страной, без языка: разделять
  // их означало бы дробить общий словарь гео без всякой пользы.
  //
  // Жанры на языке витрины: для fr это «Cartes»/«Casino» вместо английских
  // «Card»/«Casino» из iTunes lookup — на локальной витрине сиды должны быть
  // на её языке, иначе автокомплит по ним почти пуст.
  const page = await nativeAppPage(appId, country, language);

  // Соседи по нише глазами самой Apple («покупают также» + топ категории).
  // Их описания дают лексику ниши, которой нет в нашем описании, — один
  // батч-lookup на всех, поэтому источник почти бесплатный. Страница уже
  // скачана выше ради жанров, relatedIds приходят тем же ответом.
  const competitors = page?.relatedIds.length
    ? await lookupAppsCached(page.relatedIds.slice(0, COMPETITOR_APPS), country)
        .catch(() => [])
    : [];
  const competitorText = competitors
    .map((c) => `${c.title} ${c.description}`)
    .join(' ');

  const { candidates, autocompleteSignals } = await buildCandidates(
    app.title, app.primaryGenre, country, app.description, page?.genreNames ?? [],
    page?.subtitle ?? '', competitorText, language,
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
  // В словарь гео — весь урожай генерации: это запись в базу, а не запрос в
  // магазин. Ключ, попавший сюда сегодня, завтра придёт в corpus.terms и
  // будет измерен в следующем прогоне — так база и растёт, не упираясь в
  // квоту Apple. Корпусные термы сюда не нужны: они и взяты из корпуса.
  feedCorpus('ios', country, candidates);

  // А под замер — приоритетная верхушка: buildCandidates уже отсортировал
  // список так, что первыми идут сиды приложения и сильный сигнал
  // автокомплита.
  const measurable = candidates.slice(0, IOS_MAX_CANDIDATES);
  const allTerms = [...measurable, ...corpus.terms].slice(0, MAX_MEASURE);

  // Параллельный сбор ранков. Apple channel pool в native.ts сам разрулит
  // slot-throttling, поэтому конкурентность здесь ограничивают не ошибки, а
  // размер пула (APPLE_CHANNELS / SCRAPE_DELAY_MS).
  const fresh = new Map<string, string[]>();
  const memKeyOf = (normalized: string): string => `${country}|${normalized}`;
  const ctx = {
    platform: 'ios' as const,
    country,
    targetId: String(appId),
    concurrency: RANK_CONCURRENCY,
    memKeyOf,
    fetchIds: (term: string) => nativeSearchIds(term, country, language),
    autocompleteSignals,
    fresh,
  };
  const keywords = await measureTerms(ctx, allTerms);

  // Вторая волна — «через конкурентов»: по выдачам, где мы уже нашлись,
  // видно фактических соседей по нише, а по ним из накопленного кэша
  // достаются ключи, до которых лексика самого приложения не доводит.
  const measured = new Set(allTerms.map((t) => t.toLowerCase().trim()));
  // Бюджет у волны свой (COMPETITOR_SERP_TOTAL), а не остаток от MAX_MEASURE:
  // иначе на устоявшемся корпусе, где первая волна упирается в потолок, самый
  // урожайный источник получал бы ноль. Дорого это не выходит — термы взяты
  // ИЗ keyword_cache, поэтому свежие из них меряются без похода в магазин.
  const reverse = await competitorSerpTerms(
    'ios', country,
    competitorsFromSerps(keywords, memKeyOf, String(appId)),
    measured,
  );
  if (reverse.length) {
    feedCorpus('ios', country, reverse);
    keywords.push(...(await measureTerms(ctx, reverse)));
  }

  // Снимки выдачи — в общий кэш: каждый прогон удешевляет следующие и
  // пополняет источник «приложение уже видели в чужой выдаче».
  flushSerpCache('ios', country, fresh);

  sortDiscovered(keywords);

  return { appId, title: app.title, country, keywords };
}

/**
 * Android-вариант discovery: то же, что discoverKeywords, но на примитивах
 * Google Play (gpAppLookup / gpSuggest / gpSearch). Особенности платформы:
 * веб-выдача Play отдаёт только первую «страницу» (~15-30 приложений, см.
 * gpSearch), поэтому дешёвый замер видит лишь верх выдачи, а всё остальное
 * добирается RPC-обходом витрины до 250 позиций (gpDeepRank). Конкурентность
 * ниже, чем на iOS, чтобы не ловить капчу Google.
 */
export async function discoverKeywordsGp(
  appId: string,
  country = 'us',
): Promise<DiscoveryResult> {
  const app = await gpAppLookup(appId, country);
  if (!app) throw new Error('Приложение не найдено в этом гео');

  // Кандидатов меньше, чем на iOS: каждая проверка — это gpSearch, а Google
  // при высокой частоте отдаёт капчу. По той же причине уже алфавитных сидов.
  const { candidates, autocompleteSignals } = await buildCandidatesWith(
    'android',
    // У Play язык витрины выводится из страны (langOf), отдельного
    // пространства имён кэша не требуется.
    (term) => gpSuggest(term, country),
    app.title,
    app.genre,
    country,
    `${app.summary} ${app.description}`,
    GP_MAX_CANDIDATES,
    [],
    '',
    '',
    ALPHABET_SEEDS_GP,
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
  const allTerms = [...candidates, ...corpus.terms].slice(0, MAX_MEASURE);
  feedCorpus('android', country, allTerms);

  const fresh = new Map<string, string[]>();
  const memKeyOf = (normalized: string): string => `gp|${country}|${normalized}`;
  const ctx = {
    platform: 'android' as const,
    country,
    targetId: appId,
    concurrency: RANK_CONCURRENCY_GP,
    memKeyOf,
    fetchIds: async (term: string) =>
      (await gpSearch(term, country, 250)).map((a) => a.appId),
    autocompleteSignals,
    fresh,
  };
  const keywords = await measureTerms(ctx, allTerms);

  // Вторая волна «через конкурентов» — см. iOS-ветку. Для Play соседей берём
  // из тех же выдач: списка «похожих приложений» в gpAppLookup нет.
  const measured = new Set(allTerms.map((t) => t.toLowerCase().trim()));
  const reverse = await competitorSerpTerms(
    'android', country,
    competitorsFromSerps(keywords, memKeyOf, appId),
    measured,
  );
  if (reverse.length) {
    feedCorpus('android', country, reverse);
    keywords.push(...(await measureTerms(ctx, reverse)));
  }

  // Гибрид глубины: HTML-выдача видит ~20-30 позиций, поэтому rank=null при
  // непустой выдаче значит «возможно глубже», а не «не ранжируется». Самые
  // перспективные из таких (по спросу) добиваем RPC-замером витрины —
  // лимиты числа ключей и страниц в gpDeepRank.ts.
  if (deepRecheckEnabled()) {
    const unrankedByDemand = keywords
      .filter((k) => k.rank === null && k.totalResults > 0)
      .sort((a, b) => b.volumeScore - a.volumeScore);
    const deep = await gpDeepRanks(
      appId, country, capRecheckTerms(unrankedByDemand.map((k) => k.term)),
    );
    for (const k of keywords) {
      const d = deep.get(k.term);
      if (!d) continue;
      k.rank = d.rank;
      // Обход прекращается, как только приложение найдено, поэтому глубокая
      // выдача бывает КОРОЧЕ дешёвой — берём максимум, чтобы насыщенность не
      // проседала на ключах, где приложение нашлось на первой же странице.
      k.totalResults = Math.max(k.totalResults, d.totalResults);
      k.saturationScore = saturationFromResults(k.totalResults);
      // Глубокая выдача полнее — обновляем кэш, чтобы корпусные SERP-хиты
      // и повторные прогоны видели приложение и за пределами топ-30. Но
      // только если она действительно длиннее: затирать полный снимок
      // обрывком до первой страницы нельзя, кэш общий для всех приложений.
      const memKey = `gp|${country}|${k.term.toLowerCase()}`;
      if (d.ids.length >= (cacheGet(memKey)?.length ?? 0)) {
        cacheSet(memKey, d.ids);
        fresh.set(k.term.toLowerCase().trim(), d.ids);
      }
    }
  }

  flushSerpCache('android', country, fresh);

  sortDiscovered(keywords);

  return { appId, title: app.title, country, keywords };
}
