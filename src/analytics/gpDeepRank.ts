import { gpRpcSearch } from '../scrapers/gplayRpc.js';
import { langOf } from '../scrapers/googleplay.js';

// Гибрид глубины для Android-discovery: основная масса кандидатов меряется
// дешёвым одностраничным gpSearch (~20-30 позиций), и только ключи, где
// приложение не нашлось на первой странице, добиваются batchexecute-RPC
// витрины. RPC отдаёт по ~50 приложений на страницу и доходит до 250 позиций
// за 5 страниц — то есть до той же глубины, что и нативная выдача App Store.
//
// Стоимость обхода ограничена с двух сторон: числом ключей и общим бюджетом
// страниц на прогон. Бюджет — главный ограничитель времени: ключ, по которому
// приложение НЕ ранжируется, всегда стоит полный обход, и без потолка один
// подбор мог бы листать витрину часами.
const RPC_RECHECK_LIMIT = Number(process.env.DISCOVERY_RPC_RECHECK ?? 150);
const RPC_RECHECK_PAGES = Number(process.env.DISCOVERY_RPC_RECHECK_PAGES ?? 6);
const RPC_PAGE_BUDGET = Number(process.env.DISCOVERY_RPC_PAGE_BUDGET ?? 500);
// Конкурентность ниже, чем у HTML-замеров: у RPC уже есть межстраничная
// пауза, а параллельные обходы страниц умножают шанс капчи.
const RPC_CONCURRENCY = Number(process.env.DISCOVERY_RPC_CONCURRENCY ?? 4);

export interface DeepRankResult {
  rank: number | null;
  totalResults: number;
  ids: string[];
}

/** Доступен ли глубокий дозамер вообще (лимит можно занулить через env). */
export function deepRecheckEnabled(): boolean {
  return RPC_RECHECK_LIMIT > 0 && RPC_RECHECK_PAGES > 0 && RPC_PAGE_BUDGET > 0;
}

/** Обрезает список кандидатов на дозамер до лимита RPC-бюджета. */
export function capRecheckTerms(terms: string[]): string[] {
  return terms.slice(0, RPC_RECHECK_LIMIT);
}

/**
 * Глубокие ранки по списку ключей через RPC витрины Play. Возвращает только
 * успешно замеренные термы; упавший/пустой RPC-ответ по ключу молча
 * пропускается — у вызывающего остаётся результат дешёвого замера.
 *
 * Обход прекращается, как только найдено само приложение (позиция уже
 * известна) или как только исчерпан общий бюджет страниц.
 */
export async function gpDeepRanks(
  appId: string,
  country: string,
  terms: string[],
): Promise<Map<string, DeepRankResult>> {
  const out = new Map<string, DeepRankResult>();
  if (!deepRecheckEnabled() || terms.length === 0) return out;

  const queue = [...terms];
  const language = langOf(country);
  let pagesLeft = RPC_PAGE_BUDGET;

  const worker = async (): Promise<void> => {
    for (let term = queue.shift(); term !== undefined; term = queue.shift()) {
      if (pagesLeft <= 0) return;
      try {
        const res = await gpRpcSearch(term, country, {
          language,
          maxPages: Math.min(RPC_RECHECK_PAGES, Math.max(1, pagesLeft)),
          stopAt: appId,
        });
        pagesLeft -= res.pages;
        if (res.packageNames.length === 0) continue; // блокировка/пустой ответ — не перетираем дешёвый замер
        const idx = res.packageNames.indexOf(appId);
        out.set(term, {
          rank: idx === -1 ? null : idx + 1,
          totalResults: res.packageNames.length,
          ids: res.packageNames,
        });
      } catch {
        // RPC недоступен по этому ключу — остаётся результат gpSearch.
        pagesLeft -= 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RPC_CONCURRENCY, terms.length) }, () => worker()),
  );
  return out;
}
