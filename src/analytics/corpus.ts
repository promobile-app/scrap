import {
  addCorpusTerms, corpusTermsMatching, serpTermsContainingApp,
  type SerpHitRow,
} from '../db/repo.js';

// Сколько корпусных термов добавляем к discovery сверх сгенерированных
// кандидатов. SERP-хиты (приложение уже видели в закэшированной выдаче)
// почти гарантированно ранжируются, поэтому их лимит выше; token-match —
// это «возможно релевантные» термы корпуса, каждый стоит замера в сторе.
const CORPUS_SERP_LIMIT = Number(process.env.DISCOVERY_CORPUS_SERP_EXTRA ?? 500);
const CORPUS_TOKEN_LIMIT = Number(process.env.DISCOVERY_CORPUS_EXTRA ?? 200);

// Свежесть кэшированной выдачи, при которой ранк из неё можно отдавать
// без перезамера (тот же горизонт, что у keyword_cache в discoverByUrl).
export const SERP_FRESH_HOURS = 6;

export interface CorpusCandidates {
  /** Термы корпуса, которых не было среди сгенерированных кандидатов. */
  terms: string[];
  /** term -> кэшированная выдача, где приложение уже встречалось. */
  serpHits: Map<string, SerpHitRow>;
}

/**
 * Кандидаты из накопительного корпуса для пары (приложение, гео):
 *   1) термы, в чьих закэшированных выдачах приложение уже встречалось
 *      (собраны при анализе других приложений — свежие не требуют замера);
 *   2) термы корпуса, пересекающиеся токенами с лексикой приложения.
 * Ошибки БД не валят discovery — корпус это усилитель, а не зависимость.
 */
export async function corpusCandidates(
  platform: 'ios' | 'android',
  appId: string,
  country: string,
  coreTokens: Iterable<string>,
  existing: ReadonlySet<string>,
): Promise<CorpusCandidates> {
  const serpHits = new Map<string, SerpHitRow>();
  const terms = new Set<string>();
  try {
    const [hits, matched] = await Promise.all([
      serpTermsContainingApp(platform, country, appId, CORPUS_SERP_LIMIT),
      corpusTermsMatching(platform, country, [...coreTokens], CORPUS_TOKEN_LIMIT),
    ]);
    for (const hit of hits) {
      const t = hit.term.toLowerCase().trim();
      serpHits.set(t, hit);
      if (!existing.has(t)) terms.add(t);
    }
    for (const t of matched) {
      if (!existing.has(t)) terms.add(t);
    }
  } catch {
    // БД недоступна/не мигрирована — работаем только по сгенерированным кандидатам.
  }
  return { terms: [...terms], serpHits };
}

// Сколько ключей забираем «через конкурентов». Это самый качественный
// источник расширения: если по ключу ранжируется приложение из той же ниши,
// шанс, что по нему ранжируемся и мы, кратно выше, чем у случайного терма
// корпуса. Стоимость генерации — только запросы к своей БД.
const COMPETITOR_SERP_PER_APP = Number(process.env.DISCOVERY_COMPETITOR_SERP_PER_APP ?? 80);
const COMPETITOR_SERP_TOTAL = Number(process.env.DISCOVERY_COMPETITOR_SERP_TOTAL ?? 400);

/**
 * Ключи, по которым в накопленных выдачах ранжируются конкуренты приложения.
 *
 * Так работает расширение у больших ASO-сервисов: словарь ключей у них общий,
 * и для нового приложения они проверяют не только его собственную лексику, но
 * и то, по чему находятся соседи по нише. У нас роль словаря играет
 * keyword_cache, который пополняется каждым подбором.
 */
export async function competitorSerpTerms(
  platform: 'ios' | 'android',
  country: string,
  competitorIds: string[],
  existing: ReadonlySet<string>,
): Promise<string[]> {
  if (competitorIds.length === 0 || COMPETITOR_SERP_TOTAL <= 0) return [];
  const terms = new Set<string>();
  try {
    // По одному запросу на конкурента: условие `ids @> [id]` ложится на
    // GIN-индекс idx_keyword_cache_ids, а OR/ANY по массиву — уже нет.
    const perApp = await Promise.all(
      competitorIds.map((id) =>
        serpTermsContainingApp(platform, country, id, COMPETITOR_SERP_PER_APP)
          .catch(() => [] as SerpHitRow[]),
      ),
    );
    for (const hits of perApp) {
      for (const hit of hits) {
        const t = hit.term.toLowerCase().trim();
        if (existing.has(t)) continue;
        terms.add(t);
        if (terms.size >= COMPETITOR_SERP_TOTAL) return [...terms];
      }
    }
  } catch {
    // БД недоступна — расширение просто не сработает.
  }
  return [...terms];
}

/** Fire-and-forget пополнение корпуса: ошибки БД глотаем сознательно. */
export function feedCorpus(
  platform: 'ios' | 'android', country: string, terms: string[], source = 'discovery',
): void {
  addCorpusTerms(platform, country, terms, source).catch(() => {});
}
