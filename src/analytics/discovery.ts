import { appLookup, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';

export interface DiscoveredKeyword {
  term: string;
  rank: number | null;
  totalResults: number;
  volumeScore: number;
}

export interface DiscoveryResult {
  appId: number;
  title: string;
  country: string;
  keywords: DiscoveredKeyword[];
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'app', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by',
]);

/**
 * Лёгкая оценка объёма по насыщенности выдачи (5-100).
 * Точную метрику даёт estimateVolume / Apple Search Ads.
 */
function volumeFromResults(total: number): number {
  const signal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  return Math.round(5 + signal * 95);
}

/** Нормализованные слова из строки. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
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
 * Генерация кандидатов ключевых слов для приложения.
 * Источники: название, жанр, autocomplete-расширения сид-слов,
 * ключи из названий приложений-соседей по выдаче.
 */
async function buildCandidates(
  title: string,
  genre: string,
  country: string,
): Promise<string[]> {
  const seeds = [...new Set([...words(title), ...words(genre)])].slice(0, 6);

  const candidates = new Set<string>([...seeds, genre.toLowerCase()]);

  // Биграммы из названия (например "photo editor").
  const titleWords = words(title);
  for (let i = 0; i < titleWords.length - 1; i++) {
    candidates.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  // Расширения через autocomplete App Store — параллельно (было последовательно).
  const hintLists = await mapLimit(seeds, 4, (seed) =>
    suggest(seed, country).catch(() => [] as string[]),
  );
  for (const hints of hintLists) {
    hints.slice(0, 5).forEach((h) => candidates.add(h));
  }

  return [...candidates].filter((c) => c.length >= 3).slice(0, 30);
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

  const candidates = await buildCandidates(app.title, app.primaryGenre, country);

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
      return {
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volumeScore: volumeFromResults(ids.length),
      };
    })
  ).filter((k): k is DiscoveredKeyword => k !== null);

  // Сортировка: сначала где приложение в топе, затем по объёму.
  keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volumeScore - a.volumeScore;
  });

  return { appId, title: app.title, country, keywords };
}
