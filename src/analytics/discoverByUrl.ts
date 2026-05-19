import { appLookup, lookupApps, suggest } from '../scrapers/appstore.js';
import { nativeSearchIds } from '../scrapers/native.js';
import { gpAppLookup, gpSearch, gpSuggest, type GpAppInfo } from '../scrapers/googleplay.js';
import { parseStoreUrl } from '../scrapers/storeUrl.js';

export interface UrlKeyword {
  term: string;
  rank: number | null;
  totalResults: number;
  volume: number; // 5-100
  difficulty: number; // 5-100
}

export interface UrlDiscoveryResult {
  platform: 'ios' | 'android';
  appId: string;
  title: string;
  country: string;
  keywords: UrlKeyword[];
}

// Сколько ключей-кандидатов набираем и считаем максимум.
const MAX_KEYWORDS = 150;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'app', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by',
]);

/** Нормализованные слова из строки (без стоп-слов и коротышей). */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Оценка объёма по насыщенности выдачи (5-100). */
function volumeFromResults(total: number): number {
  const signal = Math.min(1, Math.log10(total + 1) / Math.log10(201));
  return Math.round(5 + signal * 95);
}

/** Оценка сложности по среднему числу отзывов у топ-приложений (5-100). */
function difficultyFromRatings(counts: number[]): number {
  const valid = counts.filter((n) => n > 0);
  if (valid.length === 0) return 5;
  const avg = valid.reduce((s, n) => s + n, 0) / valid.length;
  const strength = Math.min(1, Math.log10(avg + 1) / 6.5);
  return Math.round(5 + strength * 95);
}

/** Параллельная обработка с ограничением одновременных задач. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
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

/**
 * Генерация ключей-кандидатов: сиды из названия и жанра, затем
 * послойное расширение через autocomplete магазина (BFS), пока не
 * наберём нужное количество.
 */
async function buildCandidates(
  title: string,
  genre: string,
  country: string,
  platform: 'ios' | 'android',
  maxCandidates = MAX_KEYWORDS,
): Promise<string[]> {
  const suggestFn = platform === 'android' ? gpSuggest : suggest;
  const seeds = [...new Set([...words(title), ...words(genre)])].slice(0, 8);
  const candidates = new Set<string>([...seeds, genre.toLowerCase()]);

  const titleWords = words(title);
  for (let i = 0; i < titleWords.length - 1; i++) {
    candidates.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  // Послойное расширение через autocomplete.
  let frontier = [...seeds];
  let depth = 0;
  while (candidates.size < maxCandidates && frontier.length > 0 && depth < 3) {
    const hintLists = await mapLimit(frontier, 5, (term) =>
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
    // Ограничиваем ветвление, чтобы не разрастаться бесконтрольно.
    frontier = next.slice(0, 24);
    depth++;
  }

  return [...candidates].filter((c) => c.length >= 3).slice(0, maxCandidates);
}

/** Сортировка: сначала где приложение в топе, затем по объёму. */
function sortKeywords(keywords: UrlKeyword[]): UrlKeyword[] {
  return keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volume - a.volume;
  });
}

/**
 * По ссылке на приложение в App Store / Google Play возвращает релевантные
 * ключевые слова с позицией, объёмом и сложностью (до ~150 ключей).
 */
export async function discoverByUrl(rawUrl: string): Promise<UrlDiscoveryResult> {
  const { platform, appId, country } = parseStoreUrl(rawUrl);

  // --- Google Play ---
  if (platform === 'android') {
    const app = await gpAppLookup(appId, country);
    if (!app) throw new Error('Приложение не найдено в Google Play для этого гео');

    const candidates = await buildCandidates(app.title, app.genre, country, 'android');

    // Кэш деталей приложений: топ-конкуренты повторяются между ключами.
    const cache = new Map<string, GpAppInfo | null>();
    const cachedLookup = async (id: string): Promise<GpAppInfo | null> => {
      if (cache.has(id)) return cache.get(id) ?? null;
      const info = await gpAppLookup(id, country);
      cache.set(id, info);
      return info;
    };

    const raw = await mapLimit(candidates, 3, async (term): Promise<UrlKeyword | null> => {
      try {
        const results = await gpSearch(term, country, 250);
        const idx = results.findIndex((a) => a.appId === appId);
        // Поиск Google Play не отдаёт число отзывов — подтягиваем детали топ-4.
        const top = await Promise.all(
          results.slice(0, 4).map((a) => cachedLookup(a.appId)),
        );
        return {
          term,
          rank: idx === -1 ? null : idx + 1,
          totalResults: results.length,
          volume: volumeFromResults(results.length),
          difficulty: difficultyFromRatings(top.map((a) => a?.ratings ?? 0)),
        };
      } catch {
        return null;
      }
    });
    const keywords = raw.filter((k): k is UrlKeyword => k !== null);
    return { platform, appId, title: app.title, country, keywords: sortKeywords(keywords) };
  }

  // --- App Store ---
  const app = await appLookup(Number(appId), country);
  if (!app) throw new Error('Приложение не найдено в App Store для этого гео');

  const candidates = await buildCandidates(app.title, app.primaryGenre, country, 'ios');
  const raw = await mapLimit(candidates, 5, async (term): Promise<UrlKeyword | null> => {
    try {
      const ids = await nativeSearchIds(term, country);
      const idx = ids.indexOf(appId);
      const top = await lookupApps(ids.slice(0, 10), country);
      return {
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volume: volumeFromResults(ids.length),
        difficulty: difficultyFromRatings(top.map((a) => a.ratingCount)),
      };
    } catch {
      return null;
    }
  });
  const keywords = raw.filter((k): k is UrlKeyword => k !== null);
  return { platform, appId, title: app.title, country, keywords: sortKeywords(keywords) };
}
