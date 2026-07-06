import { appLookup, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest } from '../scrapers/googleplay.js';

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

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'app', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by',
]);

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

/**
 * Генерация кандидатов ключевых слов для приложения.
 * Источники: название, жанр, autocomplete-расширения сид-слов,
 * ключи из названий приложений-соседей по выдаче.
 * Платформо-независимо: autocomplete-источник передаётся параметром
 * (Apple Search Hints для iOS, gplay.suggest для Android).
 */
async function buildCandidatesWith(
  suggestFn: SuggestFn,
  title: string,
  genre: string,
  country: string,
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  const seeds = [...new Set([...words(title), ...words(genre)])].slice(0, 6);

  const candidates = new Set<string>([...seeds, genre.toLowerCase()]);
  // Сигнал спроса по термину: позиция в подсказках стора, нормированная в [0..1].
  const autocompleteSignals = new Map<string, number>();

  // Биграммы из названия (например "photo editor").
  const titleWords = words(title);
  for (let i = 0; i < titleWords.length - 1; i++) {
    candidates.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  // Расширения через autocomplete стора — параллельно (было последовательно).
  const hintLists = await mapLimit(seeds, 4, (seed) =>
    suggestFn(seed, country).catch(() => [] as string[]),
  );
  for (const hints of hintLists) {
    const listLen = Math.max(hints.length, 1);
    hints.slice(0, 5).forEach((h, idx) => {
      const hl = h.toLowerCase().trim();
      const sig = 1 - idx / listLen;
      if (sig > (autocompleteSignals.get(hl) ?? 0)) autocompleteSignals.set(hl, sig);
      candidates.add(h);
    });
  }

  return {
    candidates: [...candidates].filter((c) => c.length >= 3).slice(0, 30),
    autocompleteSignals,
  };
}

async function buildCandidates(
  title: string,
  genre: string,
  country: string,
): Promise<{ candidates: string[]; autocompleteSignals: Map<string, number> }> {
  return buildCandidatesWith(suggest, title, genre, country);
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

  const { candidates, autocompleteSignals } = await buildCandidates(
    app.title, app.primaryGenre, country,
  );

  // Параллельный сбор ранков: ×6-8 быстрее чем for-await.
  // Apple channel pool в native.ts сам разрулит slot-throttling.
  const keywords: DiscoveredKeyword[] = (
    await mapLimit(candidates, 8, async (term): Promise<DiscoveredKeyword | null> => {
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

  const { candidates, autocompleteSignals } = await buildCandidatesWith(
    gpSuggest, app.title, app.genre, country,
  );

  const keywords: DiscoveredKeyword[] = (
    await mapLimit(candidates, 4, async (term): Promise<DiscoveredKeyword | null> => {
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
