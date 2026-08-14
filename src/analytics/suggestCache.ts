import { getCachedSuggests, upsertCachedSuggestBatch } from '../db/repo.js';

/**
 * Кэш автокомплита магазина: память -> БД -> магазин.
 *
 * Зачем отдельный слой: с алфавитным расширением (см. discovery.ts) один
 * прогон подбора делает не десятки, а сотни запросов подсказок, и раньше
 * КАЖДЫЙ повторный подбор оплачивал их заново — suggest() не кэшировался
 * вообще. Подсказки меняются медленно (дни), поэтому суточный кэш почти не
 * теряет в свежести, но снимает основную часть стоимости генерации.
 *
 * Работает пачками: один SELECT на все префиксы и один INSERT на всё, что
 * реально ходило в магазин, — вместо запроса к БД на каждый префикс.
 */

/**
 * Запрос подсказок в магазин. Страна/язык замкнуты в самой функции: ключ
 * кэша (scope) и параметры запроса — разные вещи, см. suggestMany.
 */
export type RawSuggestFn = (term: string) => Promise<string[]>;

const MEM_TTL_MS = Number(process.env.SUGGEST_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const DB_TTL_HOURS = Number(process.env.SUGGEST_CACHE_TTL_HOURS ?? 24);
const MEM_MAX = 50_000;

const mem = new Map<string, { hints: string[]; expires: number }>();

function memGet(key: string): string[] | undefined {
  const e = mem.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) { mem.delete(key); return undefined; }
  return e.hints;
}

function memSet(key: string, hints: string[]): void {
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(key, { hints, expires: Date.now() + MEM_TTL_MS });
}

async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * Подсказки по списку префиксов. Возвращает карту «префикс -> подсказки»;
 * префиксы, по которым магазин не ответил, в карту не попадают.
 */
export async function suggestMany(
  platform: 'ios' | 'android',
  /** Ключ изоляции кэша: страна или «страна-язык» — см. scopeFor в discovery.ts. */
  country: string,
  terms: string[],
  raw: RawSuggestFn,
  concurrency = 8,
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(
    terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0),
  )];
  const out = new Map<string, string[]>();
  if (wanted.length === 0) return out;

  const misses: string[] = [];
  for (const term of wanted) {
    const hit = memGet(`${platform}|${country}|${term}`);
    if (hit) out.set(term, hit);
    else misses.push(term);
  }

  if (misses.length) {
    try {
      const fromDb = await getCachedSuggests(platform, country, misses, DB_TTL_HOURS);
      for (const [term, hints] of fromDb) {
        memSet(`${platform}|${country}|${term}`, hints);
        out.set(term, hints);
      }
    } catch {
      // БД недоступна/не мигрирована — просто идём в магазин.
    }
  }

  const toFetch = misses.filter((t) => !out.has(t));
  if (toFetch.length === 0) return out;

  const fetched: { term: string; hints: string[] }[] = [];
  await mapLimit(toFetch, concurrency, async (term) => {
    const hints = await raw(term).catch(() => null);
    // null = запрос не удался: не кэшируем, иначе на сутки закрепим пустоту.
    if (hints === null) return;
    memSet(`${platform}|${country}|${term}`, hints);
    out.set(term, hints);
    fetched.push({ term, hints });
  });

  if (fetched.length) {
    upsertCachedSuggestBatch(platform, country, fetched).catch(() => {});
  }
  return out;
}
