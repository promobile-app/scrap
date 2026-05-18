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

  // Расширения через autocomplete App Store.
  for (const seed of seeds) {
    const hints = await suggest(seed, country).catch(() => [] as string[]);
    hints.slice(0, 5).forEach((h) => candidates.add(h));
  }

  return [...candidates].filter((c) => c.length >= 3).slice(0, 30);
}

/**
 * FoxData-стиль: по приложению и гео возвращает ключевые слова,
 * по которым приложение ранжируется, с позицией и оценкой объёма.
 */
export async function discoverKeywords(
  appId: number,
  country = 'us',
): Promise<DiscoveryResult> {
  const app = await appLookup(appId, country);
  if (!app) throw new Error('Приложение не найдено в этом гео');

  const candidates = await buildCandidates(app.title, app.primaryGenre, country);

  const keywords: DiscoveredKeyword[] = [];
  for (const term of candidates) {
    try {
      // Один запрос нативной выдачи на кандидата: полный список ID -> rank.
      const ids = await nativeSearchIds(term, country);
      const idx = ids.indexOf(String(appId));
      keywords.push({
        term,
        rank: idx === -1 ? null : idx + 1,
        totalResults: ids.length,
        volumeScore: volumeFromResults(ids.length),
      });
    } catch {
      // пропускаем сбойный кандидат
    }
  }

  // Сортировка: сначала где приложение в топе, затем по объёму.
  keywords.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    return b.volumeScore - a.volumeScore;
  });

  return { appId, title: app.title, country, keywords };
}
